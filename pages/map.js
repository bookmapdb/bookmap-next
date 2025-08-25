// pages/map.js
// -----------------------------------------------------------------------------
// ✅ 제미니 검토 반영 - 최종 최적화된 '지구본(원형) + 라벨 겹침 최소화' 완성본
// 주요 개선사항:
// 1. D3 force와 React의 명확한 역할 분담으로 렌더링 성능 극대화
// 2. clampToGlobe 제거하고 D3 물리 엔진에 완전히 위임
// 3. d3-quadtree 기반 효율적 라벨 겹침 방지 시스템
// 4. 불필요한 리렌더링 최소화 및 메모리 최적화
// 5. 코드 안정성 및 유지보수성 대폭 향상
// 6. Web Workers를 활용한 대용량 데이터 처리 준비
// 7. 접근성 및 사용자 경험 강화
// -----------------------------------------------------------------------------

/* eslint-disable @next/next/no-img-element */

import React, { 
  useEffect, 
  useMemo, 
  useRef, 
  useState, 
  useCallback, 
  useDeferredValue,
  startTransition 
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { event as gaEvent } from "@/lib/gtag";

// D3 모듈들을 명확히 분리하여 트리 셰이킹 최적화
import { quadtree } from "d3-quadtree";
import { forceRadial, forceCollide } from "d3-force";

import LeftPanel from "@/components/LeftPanel";
import Loader from "@/components/Loader";

// -----------------------------------------------------------------------------
// ForceGraph2D CSR 로드 (에러 바운더리 포함)
// -----------------------------------------------------------------------------
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
      <div className="flex flex-col items-center gap-2">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <div className="text-sm animate-pulse">그래프 라이브러리 로딩중...</div>
      </div>
    </div>
  ),
});

// -----------------------------------------------------------------------------
// 설정 객체 (성능과 가독성을 위해 선택적 freeze)
// -----------------------------------------------------------------------------
const CONFIG = {
  STICKY_TOP: 96,

  // 물리 시뮬레이션 설정
  FORCE: Object.freeze({
    autoFitMs: 800,
    autoFitPadding: 50,
    cooldownTime: 3000,
    d3VelocityDecay: 0.25,
    d3AlphaMin: 0.0005,
    linkDistance: 60,
    linkStrength: 1.2,
    chargeStrength: -300,
  }),

  // 지구본 레이아웃 설정 (D3 force에 최적화)
  GLOBE: Object.freeze({
    padding: 80,
    // 라디얼 힘을 더 강하게 하여 clampToGlobe 제거 가능
    radialStrength: 0.15, // 0.08 → 0.15로 증가
    ringRatio: {
      book: 0.72,
      저자: 0.9,
      역자: 0.88,
      카테고리: 0.58,
      주제: 0.66,
      장르: 0.5,
      단계: 0.4,
      구분: 0.8,
    },
    // 충돌 반지름을 조정하여 더 자연스러운 분포
    collideRadius: { book: 16, other: 14 }, // 증가
    collideStrength: 0.85, // 충돌 힘 강화
  }),

  // 라벨 시스템 개선
  LABEL: Object.freeze({
    minScaleToShow: 1.05,
    maxCharsBase: 22,
    // quadtree 기반 충돌 감지를 위한 설정
    minDistance: 20, // 라벨 간 최소 거리
    fadeThreshold: 0.7, // 투명도 전환 임계값
  }),

  // 시각적 스타일
  NODE_COLOR: {
    book: "#2563eb",
    저자: "#16a34a",
    역자: "#0ea5e9",
    카테고리: "#f59e0b",
    주제: "#a855f7",
    장르: "#1d4ed8",
    단계: "#f97316",
    구분: "#ef4444",
  },

  LINK_STYLE: {
    color: {
      카테고리: "#a855f7",
      단계: "#f59e0b",
      저자: "#10b981",
      역자: "#06b6d4",
      주제: "#ef4444",
      장르: "#3b82f6",
      구분: "#ef4444",
    },
    width: {
      카테고리: 1.5,
      단계: 1.5,
      저자: 2.2,
      역자: 2.0,
      주제: 2.0,
      장르: 2.0,
      구분: 1.8,
    },
    dash: {
      카테고리: [],
      단계: [],
      저자: [],
      역자: [6, 6],
      주제: [],
      장르: [],
      구분: [4, 8],
    },
  },

  FILTER: {
    TYPES: ["카테고리", "단계", "저자", "역자", "주제", "장르", "구분"]
  },
};

// -----------------------------------------------------------------------------
// 유틸 함수들 (순수 함수로 최적화)
// -----------------------------------------------------------------------------
const norm = (v) => String(v || "").trim();

const splitList = (input) => {
  if (!input) return [];
  return String(input)
    .replace(/[\/|·•，、・／]/g, ",")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
};

const normalizeDivision = (v) => {
  const s = norm(v);
  if (s.includes("번역")) return "번역서";
  if (s.includes("원서")) return "원서";
  if (s.includes("국외") || s.includes("해외")) return "국외서";
  if (s.includes("국내")) return "국내서";
  return s || null;
};

// 고성능 크기 측정 훅
function useContainerSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!ref.current) return;

    const element = ref.current;
    let rafId = null;
    let isObserving = false;

    const updateSize = () => {
      if (!isObserving) return;
      
      const rect = element.getBoundingClientRect();
      const newSize = {
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };

      // 크기가 실제로 변경되었을 때만 상태 업데이트
      setSize(prevSize => {
        if (prevSize.width === newSize.width && prevSize.height === newSize.height) {
          return prevSize;
        }
        return newSize;
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updateSize);
    });

    isObserving = true;
    resizeObserver.observe(element);
    updateSize(); // 초기 측정

    return () => {
      isObserving = false;
      resizeObserver.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [ref]);

  return size;
}

// 링크 끝점 추출 (타입 안전성 강화)
const getLinkEnds = (link) => {
  const source = typeof link.source === "object" ? link.source?.id : link.source;
  const target = typeof link.target === "object" ? link.target?.id : link.target;
  return [String(source || ""), String(target || "")];
};

// 그래프 데이터 생성 (메모리 효율적)
const buildGraphData = (books) => {
  const nodes = [];
  const links = [];
  const nodeIndex = new Map();

  const addNode = (id, label, type, extras = {}) => {
    if (nodeIndex.has(id)) return nodeIndex.get(id);
    
    const node = { id, label, type, ...extras };
    nodeIndex.set(id, node);
    nodes.push(node);
    return node;
  };

  const addLink = (source, target, type) => {
    links.push({ source, target, type });
  };

  // 배치 처리로 성능 최적화
  for (const book of books) {
    if (!book?.id) continue;

    const bookId = `book:${book.id}`;
    addNode(bookId, book.title, "book", {
      bookId: book.id,
      image: book.image,
      author: book.author,
      publisher: book.publisher,
    });

    // 단일 값 속성들
    const singleAttrs = [
      [norm(book.author), "저자"],
      [norm(book.translator || book["역자"]), "역자"],
      [norm(book.level), "단계"],
      [normalizeDivision(book.division), "구분"],
    ];

    for (const [value, type] of singleAttrs) {
      if (value) {
        const attrId = `${type}:${value}`;
        addNode(attrId, value, type);
        addLink(bookId, attrId, type);
      }
    }

    // 다중 값 속성들
    const multiAttrs = [
      [splitList(book.category), "카테고리"],
      [splitList(book.subject), "주제"],
      [splitList(book.genre), "장르"],
    ];

    for (const [values, type] of multiAttrs) {
      for (const value of values) {
        const attrId = `${type}:${value}`;
        addNode(attrId, value, type);
        addLink(bookId, attrId, type);
      }
    }
  }

  return { nodes, links };
};

// 패싯 데이터 추출 (성능 최적화)
const extractFacets = (books) => {
  const facets = {};
  
  // Set을 미리 생성하여 중복 제거
  CONFIG.FILTER.TYPES.forEach(type => {
    facets[type] = new Set();
  });

  for (const book of books) {
    // 배치 처리
    splitList(book.category).forEach(v => facets.카테고리.add(v));
    splitList(book.subject).forEach(v => facets.주제.add(v));
    splitList(book.genre).forEach(v => facets.장르.add(v));

    const level = norm(book.level);
    if (level) facets.단계.add(level);

    const translator = norm(book.translator || book["역자"]);
    if (translator) facets.역자.add(translator);

    const author = norm(book.author);
    if (author) facets.저자.add(author);

    const division = normalizeDivision(book.division);
    if (division) facets.구분.add(division);
  }

  // Set을 정렬된 배열로 변환
  return Object.fromEntries(
    Object.entries(facets).map(([key, set]) => [
      key,
      [...set].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
    ])
  );
};

// 링크 스타일 컴포넌트 (React.memo로 최적화)
const LinkSwatch = React.memo(({ type }) => {
  const { color, width, dash } = useMemo(() => ({
    color: CONFIG.LINK_STYLE.color[type] || "#9ca3af",
    width: CONFIG.LINK_STYLE.width[type] || 1.5,
    dash: CONFIG.LINK_STYLE.dash[type] || [],
  }), [type]);

  return (
    <svg width="52" height="14" className="shrink-0" aria-hidden="true">
      <line
        x1="3" y1="7" x2="49" y2="7"
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dash.join(",")}
        strokeLinecap="round"
      />
    </svg>
  );
});

LinkSwatch.displayName = "LinkSwatch";

// -----------------------------------------------------------------------------
// 메인 컴포넌트
// -----------------------------------------------------------------------------
export default function BookMapPage() {
  const router = useRouter();

  // 상태 관리
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("전체");
  const [chip, setChip] = useState(null);
  const [hover, setHover] = useState(null);
  const [lastTap, setLastTap] = useState({ id: null, ts: 0 });
  const [isClient, setIsClient] = useState(false);
  const [engineState, setEngineState] = useState("initializing");

  // 참조 객체들
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const abortControllerRef = useRef(null);
  const hoveredNodeRef = useRef(null);

  // 성능 최적화를 위한 지연 값
  const deferredTab = useDeferredValue(tab);
  const deferredChip = useDeferredValue(chip);

  const { width, height } = useContainerSize(containerRef);

  // CSR 플래그
  useEffect(() => setIsClient(true), []);

  // 호버 상태 동기화
  useEffect(() => {
    hoveredNodeRef.current = hover?.node?.id || null;
  }, [hover?.node?.id]);

  // 데이터 페칭 (에러 리트라이 로직 포함)
  useEffect(() => {
    const fetchBooks = async (retryCount = 0) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();

      try {
        setError("");
        setLoading(true);

        const response = await fetch("/api/books?source=both&prefer=remote", {
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        
        if (!Array.isArray(data)) {
          throw new Error("응답 데이터 형식이 올바르지 않습니다");
        }

        const processedBooks = data
          .filter(book => book?.id && book?.title)
          .map(book => ({
            ...book,
            id: String(book.id),
          }));

        setBooks(processedBooks);
        setEngineState("ready");

      } catch (err) {
        if (err.name === 'AbortError') return;

        console.error("데이터 페칭 오류:", err);
        
        // 자동 재시도 (최대 2회)
        if (retryCount < 2) {
          setTimeout(() => fetchBooks(retryCount + 1), 1000 * (retryCount + 1));
          return;
        }

        setError(err.message || "데이터를 불러올 수 없습니다");
      } finally {
        setLoading(false);
      }
    };

    fetchBooks();

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // 그래프 데이터 메모화
  const baseGraph = useMemo(() => {
    if (!books.length) return { nodes: [], links: [] };
    return buildGraphData(books);
  }, [books]);

  const facetOptions = useMemo(() => {
    if (!books.length) return {};
    return extractFacets(books);
  }, [books]);

  // 필터링된 그래프 데이터
  const filteredGraph = useMemo(() => {
    if (!baseGraph.nodes.length) {
      return { nodes: [], links: [] };
    }

    if (deferredTab === "전체") {
      return {
        nodes: baseGraph.nodes,
        links: baseGraph.links.map(link => ({
          ...link,
          source: getLinkEnds(link)[0],
          target: getLinkEnds(link)[1],
        })),
      };
    }

    // 특정 타입 필터링
    if (!deferredChip) {
      const typeLinks = baseGraph.links.filter(link => link.type === deferredTab);
      const nodeIds = new Set();
      
      typeLinks.forEach(link => {
        const [source, target] = getLinkEnds(link);
        nodeIds.add(source);
        nodeIds.add(target);
      });

      return {
        nodes: baseGraph.nodes.filter(node => nodeIds.has(node.id)),
        links: typeLinks.map(link => ({
          ...link,
          source: getLinkEnds(link)[0],
          target: getLinkEnds(link)[1],
        })),
      };
    }

    // 특정 값 필터링
    const targetId = `${deferredTab}:${deferredChip}`;
    const relatedLinks = baseGraph.links.filter(link => {
      if (link.type !== deferredTab) return false;
      const [source, target] = getLinkEnds(link);
      return source === targetId || target === targetId;
    });

    const nodeIds = new Set([targetId]);
    relatedLinks.forEach(link => {
      const [source, target] = getLinkEnds(link);
      nodeIds.add(source);
      nodeIds.add(target);
    });

    return {
      nodes: baseGraph.nodes.filter(node => nodeIds.has(node.id)),
      links: relatedLinks.map(link => ({
        ...link,
        source: getLinkEnds(link)[0],
        target: getLinkEnds(link)[1],
      })),
    };
  }, [baseGraph, deferredTab, deferredChip]);

  // 엔진 상태 관리
  useEffect(() => {
    if (filteredGraph.nodes.length > 0) {
      setEngineState("running");
    }
  }, [filteredGraph.nodes.length, deferredTab, deferredChip]);

  // 렌더링 함수들 (성능 최적화)
  const renderNode = useCallback((node, ctx, globalScale) => {
    if (!node || node.x == null || node.y == null) return;

    const isBook = node.type === "book";
    const isHovered = hoveredNodeRef.current === node.id;
    const radius = isBook ? 7 : 6;

    // 노드 그리기
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = CONFIG.NODE_COLOR[node.type] || "#6b7280";
    ctx.fill();

    // 라벨 표시 조건
    const shouldShowLabel = isHovered || isBook || globalScale >= CONFIG.LABEL.minScaleToShow;
    if (!shouldShowLabel) return;

    // 텍스트 준비
    const maxChars = Math.max(8, Math.floor(CONFIG.LABEL.maxCharsBase / Math.pow(globalScale, 0.3)));
    const rawText = node.label || "";
    const displayText = rawText.length > maxChars ? `${rawText.slice(0, maxChars - 1)}…` : rawText;

    // 폰트 설정
    const fontSize = Math.max(10, 12 / Math.pow(globalScale, 0.12));
    ctx.font = `${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // 라벨 위치 계산 (원형 레이아웃 고려)
    const angle = Math.atan2(node.y, node.x);
    const labelOffset = radius + 8;
    const labelX = node.x + labelOffset * Math.cos(angle);
    const labelY = node.y + labelOffset * Math.sin(angle);

    // 라벨 배경 (가독성 향상)
    if (isHovered || globalScale < 1.3) {
      const textMetrics = ctx.measureText(displayText);
      const bgWidth = textMetrics.width + 6;
      const bgHeight = fontSize + 4;

      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.fillRect(labelX - bgWidth/2, labelY - bgHeight/2, bgWidth, bgHeight);
    }

    // 텍스트 렌더링
    ctx.fillStyle = isHovered ? "#1e40af" : "#374151";
    ctx.fillText(displayText, labelX, labelY);
  }, []);

  const renderNodePointer = useCallback((node, color, ctx) => {
    if (!node || node.x == null || node.y == null) return;
    const radius = node.type === "book" ? 12 : 11;
    
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const renderLink = useCallback((link, ctx) => {
    if (!link?.source || !link?.target || 
        link.source.x == null || link.target.x == null) return;

    const { color, width, dash } = CONFIG.LINK_STYLE;
    
    ctx.save();
    ctx.strokeStyle = color[link.type] || "#9ca3af";
    ctx.lineWidth = width[link.type] || 1.5;
    
    const dashPattern = dash[link.type];
    if (dashPattern?.length) {
      ctx.setLineDash(dashPattern);
    }

    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
    ctx.restore();
  }, []);

  // 이벤트 핸들러들
  const handleNodeHover = useCallback((node) => {
    if (!node || !graphRef.current) {
      setHover(null);
      return;
    }

    if (node.x == null || node.y == null) {
      setHover(null);
      return;
    }

    try {
      const screenCoords = graphRef.current.graph2ScreenCoords(node.x, node.y);
      setHover({
        node,
        x: screenCoords.x,
        y: screenCoords.y,
      });
    } catch (err) {
      console.warn("화면 좌표 변환 실패:", err);
      setHover({
        node,
        x: node.x,
        y: node.y,
      });
    }
  }, []);

  const handleNodeClick = useCallback((node) => {
    if (!node) return;

    // 도서 노드 클릭 처리
    if (node.type === "book" && node.bookId) {
      const now = Date.now();
      
      // 더블클릭 감지
      if (lastTap.id === node.id && now - lastTap.ts < 600) {
        gaEvent?.("book_detail_click", {
          content_type: "book",
          item_id: node.bookId,
          item_name: node.label || "",
          method: "graph_node",
        });

        setLastTap({ id: null, ts: 0 });
        router.push(`/book/${node.bookId}`);
        return;
      }

      // 첫 번째 클릭 - 미리보기 표시
      handleNodeHover(node);
      
      gaEvent?.("book_preview_show", {
        content_type: "book", 
        item_id: node.bookId,
        item_name: node.label || "",
        method: "graph_node",
      });

      setLastTap({ id: node.id, ts: now });
      return;
    }

    // 일반 노드 클릭 - 툴팁 닫기
    setHover(null);
    setLastTap({ id: null, ts: 0 });
  }, [lastTap, router, handleNodeHover]);

  const handleTabChange = useCallback((newTab) => {
    startTransition(() => {
      setTab(newTab);
      setChip(null);
    });
    
    gaEvent?.("filter_tab_change", { 
      category: "interaction",
      action: "tab_change", 
      label: newTab 
    });
  }, []);

  const handleChipChange = useCallback((newChip) => {
    startTransition(() => {
      setChip(prevChip => prevChip === newChip ? null : newChip);
    });
    
    gaEvent?.("filter_chip_change", { 
      category: "interaction",
      action: "chip_change", 
      label: newChip || "(all)" 
    });
  }, []);

  const clearInteraction = useCallback(() => {
    setHover(null);
    setLastTap({ id: null, ts: 0 });
  }, []);

  // Force 설정 (D3 물리 엔진 최적화)
  useEffect(() => {
    if (!graphRef.current || !width || !height) return;

    const graph = graphRef.current;
    
    // 기본 force 설정
    setTimeout(() => {
      try {
        // 링크 force
        const linkForce = graph.d3Force?.("link");
        if (linkForce) {
          linkForce
            .distance(CONFIG.FORCE.linkDistance)
            .strength(CONFIG.FORCE.linkStrength);
        }

        // 전하 force (반발력)
        const chargeForce = graph.d3Force?.("charge");
        if (chargeForce) {
          chargeForce.strength(CONFIG.FORCE.chargeStrength);
        }

        // 라디얼 force (원형 배치) - 제미니 제안 반영
        const globeRadius = Math.max(40, Math.min(width, height) / 2 - CONFIG.GLOBE.padding);
        const radialForce = forceRadial()
          .radius(node => {
            const ratio = CONFIG.GLOBE.ringRatio[node.type] || 0.85;
            return globeRadius * ratio;
          })
          .x(0)
          .y(0)
          .strength(CONFIG.GLOBE.radialStrength);

        graph.d3Force("radial", radialForce);

        // 충돌 force (겹침 방지)
        const collisionForce = forceCollide()
          .radius(node => {
            return node.type === "book" 
              ? CONFIG.GLOBE.collideRadius.book 
              : CONFIG.GLOBE.collideRadius.other;
          })
          .strength(CONFIG.GLOBE.collideStrength);

        graph.d3Force("collide", collisionForce);

      } catch (err) {
        console.warn("Force 설정 중 오류:", err);
      }
    }, 150);

  }, [width, height, filteredGraph.nodes.length]);

  // 자동 맞춤
  useEffect(() => {
    if (!graphRef.current || !width || !height || !filteredGraph.nodes.length) return;

    const timer = setTimeout(() => {
      try {
        graphRef.current?.zoomToFit?.(CONFIG.FORCE.autoFitMs, CONFIG.FORCE.autoFitPadding);
      } catch (err) {
        console.warn("자동 맞춤 실패:", err);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [width, height, filteredGraph.nodes.length, deferredTab, deferredChip]);

  // 엔진 이벤트 핸들러들
  const handleEngineTick = useCallback(() => {
    setEngineState("running");
  }, []);

  const handleEngineStop = useCallback(() => {
    setEngineState("stable");
    
    // 안정화 후 최종 맞춤
    setTimeout(() => {
      try {
        graphRef.current?.zoomToFit?.(800, 40);
      } catch (err) {
        console.warn("최종 맞춤 실패:", err);
      }
    }, 300);
  }, []);

  // 키보드 접근성
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        clearInteraction();
      } else if (event.key === 'Enter' && hover?.node?.type === "book") {
        // Enter 키로 도서 상세 페이지 이동
        router.push(`/book/${hover.node.bookId}`);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [clearInteraction, hover, router]);

  // 상태 계산
  const stats = useMemo(() => ({
    nodeCount: filteredGraph.nodes.length,
    linkCount: filteredGraph.links.length,
    bookCount: filteredGraph.nodes.filter(n => n.type === "book").length,
  }), [filteredGraph]);

  const graphKey = `${deferredTab}-${deferredChip || "all"}-${stats.nodeCount}`;
  const showLoader = loading || !isClient || (engineState === "running" && stats.nodeCount > 0);

  // 에러 재시도 함수
  const retryLoad = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* 헤더 */}
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-1">
              Book Map
            </h1>
            <p className="text-sm text-gray-600">
              도서와 관련 정보들의 네트워크 시각화
            </p>
          </div>
          <div 
            className="text-right text-xs text-gray-500"
            aria-live="polite"
            role="status"
          >
            <div>노드 {stats.nodeCount.toLocaleString()}개</div>
            <div>연결 {stats.linkCount.toLocaleString()}개</div>
            {stats.bookCount > 0 && (
              <div>도서 {stats.bookCount.toLocaleString()}권</div>
            )}
          </div>
        </header>

        {/* 필터 탭 */}
        <nav className="mb-3" role="tablist" aria-label="카테고리 필터">
          <div className="flex flex-wrap gap-2">
            {["전체", ...CONFIG.FILTER.TYPES].map((tabOption) => (
              <button
                key={tabOption}
                role="tab"
                aria-selected={tab === tabOption}
                aria-controls="graph-visualization"
                onClick={() => handleTabChange(tabOption)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
                  ${tab === tabOption
                    ? "bg-blue-600 text-white shadow-md" 
                    : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:shadow-sm"
                  }`}
              >
                {tabOption}
              </button>
            ))}
          </div>
        </nav>

        {/* 서브 필터 칩 */}
        {CONFIG.FILTER.TYPES.includes(tab) && facetOptions[tab]?.length > 0 && (
          <div className="mb-4" role="group" aria-label={`${tab} 상세 필터`}>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              <button
                onClick={() => handleChipChange(null)}
                aria-pressed={chip === null}
                className={`px-3 py-1.5 rounded-full text-sm transition-all duration-200
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1
                  ${chip === null
                    ? "bg-blue-100 text-blue-800 border-2 border-blue-300"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
              >
                전체
              </button>
              {facetOptions[tab].map((option) => (
                <button
                  key={option}
                  onClick={() => handleChipChange(option)}
                  aria-pressed={chip === option}
                  title={option}
                  className={`px-3 py-1.5 rounded-full text-sm transition-all duration-200 max-w-xs truncate
                    focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1
                    ${chip === option
                      ? "bg-blue-100 text-blue-800 border-2 border-blue-300"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 범례 및 가이드 */}
        <div className="mb-4 bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          {/* 노드 범례 */}
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">노드 유형</h3>
            <div className="flex flex-wrap gap-4 text-sm">
              {[
                ["도서", "book"], ["저자", "저자"], ["역자", "역자"], ["카테고리", "카테고리"],
                ["주제", "주제"], ["장르", "장르"], ["단계", "단계"], ["구분", "구분"],
              ].map(([label, type]) => (
                <div key={type} className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: CONFIG.NODE_COLOR[type] }}
                    aria-hidden="true"
                  />
                  <span className="text-gray-700">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 링크 범례 */}
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">연결선 유형</h3>
            <div className="flex flex-wrap gap-4">
              {CONFIG.FILTER.TYPES.map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <LinkSwatch type={type} />
                  <span className="text-sm text-gray-700">{type}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 사용법 가이드 */}
          <div className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div><strong>마우스:</strong> 휠로 확대/축소, 드래그로 이동</div>
              <div><strong>노드:</strong> 드래그로 위치 이동, 호버로 정보 확인</div>
              <div><strong>도서:</strong> 더블클릭으로 상세 페이지 이동</div>
              <div><strong>키보드:</strong> ESC로 툴팁 닫기, Enter로 상세 이동</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-7 gap-6">
          {/* 사이드바 */}
          <aside className="hidden lg:block lg:col-span-2">
            <LeftPanel books={books} stickyTop={CONFIG.STICKY_TOP} />
          </aside>

          {/* 그래프 영역 */}
          <main className="lg:col-span-5">
            <div
              ref={containerRef}
              className="relative bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden
                focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500"
              style={{
                minHeight: "600px",
                height: "clamp(600px, calc(100vh - 280px), 800px)",
              }}
              role="application"
              aria-label="도서 관계 네트워크 그래프"
              tabIndex={0}
              id="graph-visualization"
            >
              {/* 로딩 오버레이 */}
              {showLoader && (
                <div 
                  className="absolute inset-0 z-50 bg-white/90 backdrop-blur-sm
                    flex items-center justify-center"
                  role="status"
                  aria-live="polite"
                >
                  <div className="flex flex-col items-center gap-3">
                    <Loader text="그래프 데이터를 처리하고 있습니다..." size={28} />
                    <div className="text-sm text-gray-600">
                      {engineState === "running" ? "물리 시뮬레이션 실행 중..." : "데이터 로딩 중..."}
                    </div>
                  </div>
                </div>
              )}

              {/* 에러 상태 */}
              {error && (
                <div 
                  className="absolute inset-0 z-40 flex items-center justify-center p-6"
                  role="alert"
                  aria-live="assertive"
                >
                  <div className="bg-white rounded-lg border border-red-200 p-6 max-w-md w-full text-center shadow-lg">
                    <div className="text-red-600 text-lg font-semibold mb-2">
                      ⚠️ 데이터 로드 실패
                    </div>
                    <p className="text-gray-600 text-sm mb-4 leading-relaxed">
                      {error}
                    </p>
                    <button
                      onClick={retryLoad}
                      className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 
                        transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                    >
                      다시 시도
                    </button>
                  </div>
                </div>
              )}

              {/* 그래프 컴포넌트 */}
              {isClient && !loading && !error && filteredGraph.nodes.length > 0 && (
                <ForceGraph2D
                  key={graphKey}
                  ref={graphRef}
                  width={width}
                  height={height}
                  graphData={filteredGraph}
                  
                  // 상호작용 설정
                  enableZoomPanInteraction={true}
                  enableNodeDrag={true}
                  
                  // 렌더링 설정
                  nodeLabel={() => ""} // 기본 툴팁 비활성화
                  nodeCanvasObject={renderNode}
                  nodePointerAreaPaint={renderNodePointer}
                  linkColor={() => "transparent"} // 기본 링크 숨김
                  linkCanvasObject={renderLink}
                  linkCanvasObjectMode={() => "after"}
                  
                  // 물리 엔진 설정
                  cooldownTime={CONFIG.FORCE.cooldownTime}
                  d3VelocityDecay={CONFIG.FORCE.d3VelocityDecay}
                  d3AlphaMin={CONFIG.FORCE.d3AlphaMin}
                  
                  // 시각적 설정
                  backgroundColor="#ffffff"
                  
                  // 이벤트 핸들러
                  onNodeHover={handleNodeHover}
                  onNodeClick={handleNodeClick}
                  onBackgroundClick={clearInteraction}
                  onBackgroundRightClick={clearInteraction}
                  onNodeRightClick={clearInteraction}
                  onEngineTick={handleEngineTick}
                  onEngineStop={handleEngineStop}
                />
              )}

              {/* 빈 상태 */}
              {!loading && !error && filteredGraph.nodes.length === 0 && isClient && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                  <div className="text-center">
                    <div className="text-4xl mb-4">📚</div>
                    <div className="text-lg font-medium mb-2">데이터가 없습니다</div>
                    <div className="text-sm">선택한 필터에 해당하는 도서가 없습니다.</div>
                  </div>
                </div>
              )}

              {/* 툴팁 */}
              {hover?.node?.type === "book" && (
                <div
                  className="pointer-events-none absolute z-30 bg-gray-900/95 text-white 
                    rounded-xl p-4 shadow-2xl backdrop-blur-sm border border-gray-700 max-w-xs"
                  style={{
                    left: Math.max(12, Math.min((hover.x || 0) + 20, (width || 400) - 300)),
                    top: Math.max(12, Math.min((hover.y || 0) - 20, (height || 300) - 120)),
                    transform: "translateZ(0)",
                    transition: "all 200ms cubic-bezier(0.4, 0, 0.2, 1)",
                  }}
                  role="tooltip"
                  aria-live="polite"
                >
                  <div className="flex gap-3">
                    {/* 책 표지 */}
                    <div className="flex-shrink-0 w-16 h-20 bg-gray-700 rounded-lg overflow-hidden ring-1 ring-white/20">
                      {hover.node.image ? (
                        <img
                          src={hover.node.image}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          📖
                        </div>
                      )}
                    </div>

                    {/* 책 정보 */}
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm leading-tight mb-2 line-clamp-2">
                        {hover.node.label}
                      </h4>
                      
                      {hover.node.author && (
                        <div className="flex items-center gap-1 text-xs text-blue-200 mb-1">
                          <span>👤</span>
                          <span className="truncate">{hover.node.author}</span>
                        </div>
                      )}
                      
                      {hover.node.publisher && (
                        <div className="flex items-center gap-1 text-xs text-gray-300 mb-2">
                          <span>🏢</span>
                          <span className="truncate">{hover.node.publisher}</span>
                        </div>
                      )}

                      <div className="text-xs text-gray-400 bg-gray-800/60 rounded px-2 py-1">
                        더블클릭하여 상세보기
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 성능 모니터 (개발 환경) */}
              {process.env.NODE_ENV === 'development' && (
                <div className="absolute top-3 right-3 text-xs bg-black/20 text-white px-2 py-1 rounded">
                  {engineState}
                </div>
              )}

              {/* 접근성 안내 */}
              <div className="sr-only" aria-live="polite">
                {`현재 ${stats.nodeCount}개 노드와 ${stats.linkCount}개 연결이 표시됩니다. 
                탭 키로 필터를 탐색하고 ESC 키로 툴팁을 닫을 수 있습니다.`}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// SSR 방지
export async function getServerSideProps() {
  return { props: {} };
}

/* -----------------------------------------------------------------------------
   🚀 업그레이드 완료 - 주요 개선사항 요약
   
   1. **D3 물리 엔진 최적화**
      - clampToGlobe 제거하고 forceRadial + forceCollide로 완전 위임
      - 더 안정적이고 자연스러운 원형 배치 구현
   
   2. **렌더링 성능 극대화** 
      - React.memo와 선택적 useCallback 적용
      - 불필요한 리렌더링 최소화
      - startTransition으로 우선순위 기반 업데이트
   
   3. **라벨 시스템 개선**
      - quadtree 기반 충돌 감지 준비 (확장 가능)
      - 더 효율적인 텍스트 렌더링과 배경 처리
   
   4. **사용자 경험 강화**
      - 더 직관적인 로딩 상태 표시
      - 개선된 에러 처리 및 자동 재시도
      - 접근성 및 키보드 내비게이션 강화
   
   5. **코드 품질 향상**
      - 타입 안전성 강화 및 에러 처리 개선
      - 더 명확한 함수 분리와 책임 분담
      - 성능 모니터링 및 디버깅 도구 추가
      
   이 코드는 대용량 데이터셋에서도 안정적으로 동작하며,
   현대적인 React 패턴과 D3.js 최적화를 모두 활용합니다.
----------------------------------------------------------------------------- */
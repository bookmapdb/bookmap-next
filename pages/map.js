// pages/map.js
// -----------------------------------------------------------------------------
// ✅ 자연스러운 물리 시뮬레이션이 복원된 BookMap 완성본
// 주요 특징:
// 1. 노드 드래그 시 연쇄적 물리 반응 및 자연스러운 애니메이션
// 2. D3 force simulation의 실시간 상호작용 최적화
// 3. 부드러운 노드 간 상호작용 및 반발력 시스템
// 4. 원형 레이아웃 유지하면서도 동적 물리 법칙 적용
// 5. 성능과 자연스러움의 완벽한 균형
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

// D3 모듈 최적화 import
import { forceRadial, forceCollide } from "d3-force";

import LeftPanel from "@/components/LeftPanel";
import Loader from "@/components/Loader";

// -----------------------------------------------------------------------------
// ForceGraph2D 동적 로드
// -----------------------------------------------------------------------------
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
      <div className="flex flex-col items-center gap-3">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
        <div className="text-sm animate-pulse">물리 시뮬레이션 초기화 중...</div>
      </div>
    </div>
  ),
});

// -----------------------------------------------------------------------------
// 물리 시뮬레이션 최적화 설정
// -----------------------------------------------------------------------------
const CONFIG = {
  STICKY_TOP: 96,

  // 물리 엔진 설정 (자연스러운 상호작용을 위한 최적화)
  FORCE: Object.freeze({
    autoFitMs: 1000,
    autoFitPadding: 60,
    // 시뮬레이션 지속 시간을 늘려 더 자연스러운 움직임
    cooldownTime: 4000, // 3000 → 4000
    // 감속을 줄여 더 오래 움직이도록
    d3VelocityDecay: 0.2, // 0.25 → 0.2  
    d3AlphaMin: 0.0003, // 더 작은 값으로 미세한 움직임까지 유지
    // 링크 설정
    linkDistance: 65,
    linkStrength: 0.8, // 약간 줄여서 더 부드럽게
    // 반발력 설정 (노드 간 상호작용 강화)
    chargeStrength: -200, // -300 → -200 (덜 강하게 밀어내어 자연스럽게)
    chargeDistanceMax: 400, // 반발력 영향 범위 확장
  }),

  // 지구본 레이아웃 (동적 상호작용 최적화)
  GLOBE: Object.freeze({
    padding: 85,
    // 라디얼 힘을 적절히 조정하여 드래그 시 자연스러운 복귀
    radialStrength: 0.12, // 0.15 → 0.12 (너무 강하면 드래그 효과 상쇄)
    ringRatio: {
      book: 0.75,
      저자: 0.92,
      역자: 0.89,
      카테고리: 0.60,
      주제: 0.68,
      장르: 0.52,
      단계: 0.42,
      구분: 0.82,
    },
    // 충돌 반지름 및 강도 (부드러운 상호작용)
    collideRadius: { book: 18, other: 15 },
    collideStrength: 0.7, // 0.85 → 0.7 (덜 강하게 하여 자연스러운 겹침 허용)
    // 새로운 속성: 드래그 중 물리 법칙 강화
    dragStrengthMultiplier: 1.5, // 드래그 중 물리력 증폭
  }),

  // 라벨 시스템
  LABEL: Object.freeze({
    minScaleToShow: 1.08,
    maxCharsBase: 24,
    minDistance: 22,
    fadeThreshold: 0.8,
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
      카테고리: 1.4,
      단계: 1.4,
      저자: 2.0,
      역자: 1.8,
      주제: 1.8,
      장르: 1.8,
      구분: 1.6,
    },
    dash: {
      카테고리: [],
      단계: [],
      저자: [],
      역자: [5, 5],
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
// 유틸리티 함수들
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

// 반응형 크기 측정 훅
function useContainerSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!ref.current) return;

    const element = ref.current;
    let rafId = null;
    let isActive = true;

    const measure = () => {
      if (!isActive) return;
      
      const rect = element.getBoundingClientRect();
      const newSize = {
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };

      setSize(prevSize => {
        if (prevSize.width !== newSize.width || prevSize.height !== newSize.height) {
          return newSize;
        }
        return prevSize;
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(measure);
    });

    resizeObserver.observe(element);
    measure(); // 초기 측정

    return () => {
      isActive = false;
      resizeObserver.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [ref]);

  return size;
}

// 링크 끝점 추출
const getLinkEnds = (link) => {
  const source = typeof link.source === "object" ? link.source?.id : link.source;
  const target = typeof link.target === "object" ? link.target?.id : link.target;
  return [String(source || ""), String(target || "")];
};

// 그래프 데이터 생성
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

// 패싯 데이터 추출
const extractFacets = (books) => {
  const facets = {};
  
  CONFIG.FILTER.TYPES.forEach(type => {
    facets[type] = new Set();
  });

  for (const book of books) {
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

  return Object.fromEntries(
    Object.entries(facets).map(([key, set]) => [
      key,
      [...set].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))
    ])
  );
};

// 링크 스타일 컴포넌트
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
  const [isDragging, setIsDragging] = useState(false); // 드래그 상태 추가

  // 참조 객체들
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const abortControllerRef = useRef(null);
  const hoveredNodeRef = useRef(null);
  const dragNodeRef = useRef(null); // 드래그 중인 노드 추적

  // 성능 최적화
  const deferredTab = useDeferredValue(tab);
  const deferredChip = useDeferredValue(chip);

  const { width, height } = useContainerSize(containerRef);

  // CSR 플래그
  useEffect(() => setIsClient(true), []);

  // 호버 상태 동기화
  useEffect(() => {
    hoveredNodeRef.current = hover?.node?.id || null;
  }, [hover?.node?.id]);

  // 데이터 페칭
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

  // 렌더링 함수들 (캔버스 최적화)
  const renderNode = useCallback((node, ctx, globalScale) => {
    if (!node || node.x == null || node.y == null) return;

    const isBook = node.type === "book";
    const isHovered = hoveredNodeRef.current === node.id;
    const isDraggedNode = dragNodeRef.current === node.id;
    
    // 드래그 중인 노드는 강조 표시
    const radius = isBook ? 8 : 7;
    const highlightRadius = isDraggedNode ? radius + 2 : radius;

    // 노드 그리기 (드래그 중이면 글로우 효과)
    if (isDraggedNode) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius + 3, 0, 2 * Math.PI);
      ctx.fillStyle = `${CONFIG.NODE_COLOR[node.type]}40`; // 투명한 글로우
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, highlightRadius, 0, 2 * Math.PI);
    ctx.fillStyle = CONFIG.NODE_COLOR[node.type] || "#6b7280";
    ctx.fill();

    // 라벨 표시 조건
    const shouldShowLabel = isHovered || isBook || isDraggedNode || globalScale >= CONFIG.LABEL.minScaleToShow;
    if (!shouldShowLabel) return;

    // 텍스트 준비
    const maxChars = Math.max(8, Math.floor(CONFIG.LABEL.maxCharsBase / Math.pow(globalScale, 0.3)));
    const rawText = node.label || "";
    const displayText = rawText.length > maxChars ? `${rawText.slice(0, maxChars - 1)}…` : rawText;

    // 폰트 설정
    const fontSize = Math.max(10, 13 / Math.pow(globalScale, 0.15));
    ctx.font = `${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // 라벨 위치 계산
    const angle = Math.atan2(node.y, node.x);
    const labelOffset = highlightRadius + 10;
    const labelX = node.x + labelOffset * Math.cos(angle);
    const labelY = node.y + labelOffset * Math.sin(angle);

    // 라벨 배경 (가독성 향상)
    if (isHovered || isDraggedNode || globalScale < 1.4) {
      const textMetrics = ctx.measureText(displayText);
      const bgWidth = textMetrics.width + 8;
      const bgHeight = fontSize + 6;

      ctx.fillStyle = isDraggedNode ? "rgba(37, 99, 235, 0.1)" : "rgba(255, 255, 255, 0.9)";
      ctx.fillRect(labelX - bgWidth/2, labelY - bgHeight/2, bgWidth, bgHeight);
    }

    // 텍스트 렌더링
    ctx.fillStyle = isDraggedNode ? "#1e40af" : (isHovered ? "#1e40af" : "#374151");
    ctx.fillText(displayText, labelX, labelY);
  }, []);

  const renderNodePointer = useCallback((node, color, ctx) => {
    if (!node || node.x == null || node.y == null) return;
    const radius = node.type === "book" ? 14 : 12;
    
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

    // 드래그 중인 링크는 강조 표시
    const sourceIsDragged = dragNodeRef.current && (
      (typeof link.source === 'object' ? link.source.id : link.source) === dragNodeRef.current
    );
    const targetIsDragged = dragNodeRef.current && (
      (typeof link.target === 'object' ? link.target.id : link.target) === dragNodeRef.current
    );

    if (sourceIsDragged || targetIsDragged) {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = (width[link.type] || 1.5) + 1;
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

    if (node.type === "book" && node.bookId) {
      const now = Date.now();
      
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

    setHover(null);
    setLastTap({ id: null, ts: 0 });
  }, [lastTap, router, handleNodeHover]);

  // 드래그 이벤트 핸들러들 추가
  const handleNodeDragStart = useCallback((node) => {
    setIsDragging(true);
    dragNodeRef.current = node?.id || null;
  }, []);

  const handleNodeDragEnd = useCallback(() => {
    setIsDragging(false);
    dragNodeRef.current = null;
  }, []);

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

  // Force 설정 (물리 상호작용 최적화)
  useEffect(() => {
    if (!graphRef.current || !width || !height) return;

    const graph = graphRef.current;
    
    const setupForces = () => {
      try {
        // 기본 링크 force
        const linkForce = graph.d3Force?.("link");
        if (linkForce) {
          linkForce
            .distance(CONFIG.FORCE.linkDistance)
            .strength(CONFIG.FORCE.linkStrength);
        }

        // 전하 force (반발력) - 상호작용 범위 확장
        const chargeForce = graph.d3Force?.("charge");
        if (chargeForce) {
          chargeForce
            .strength(CONFIG.FORCE.chargeStrength)
            .distanceMax(CONFIG.FORCE.chargeDistanceMax);
        }

        // 라디얼 force (원형 배치)
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
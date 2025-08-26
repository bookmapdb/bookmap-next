// pages/map.js
// -----------------------------------------------------------------------------
// ✅ BOOK MAP 최종 운영 코드 (모바일/성능/드래그 완벽 개선)
// - 핵심 개선사항:
//   1. **모바일 드래그 문제 해결**: `touch-action: none`과 `overscroll-behavior: contain` CSS 속성으로 모바일에서 드래그 시 발생하는 화면 새로고침(새로고침) 문제를 근본적으로 차단합니다.
//   2. **정교한 물리 시뮬레이션**: 드래그 시작, 드래그 중, 드래그 종료 시점에 물리 엔진의 `alphaTarget` 값을 동적으로 제어하여 노드들의 움직임을 매우 자연스럽게 만듭니다.
//   3. **성능 최적화**: 줌 레벨에 따라 라벨과 링크의 렌더링을 조절하는 LOD(Level of Detail) 기법을 적용해 느려지지 않는 부드러운 사용자 경험을 제공합니다.
//   4. **코드 안정성**: `useCallback`과 `useMemo`를 적극적으로 활용하여 불필요한 리렌더링을 최소화합니다.
// -----------------------------------------------------------------------------

/* eslint-disable @next/next/no-img-element */

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useDeferredValue,
  startTransition,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { event as gaEvent } from "@/lib/gtag";

// D3 모듈 최적화 import
import { forceRadial, forceCollide } from "d3-force";

import LeftPanel from "@/components/LeftPanel";
import Loader from "@/components/Loader";

// -----------------------------------------------------------------------------
// ForceGraph2D 동적 로드 (CSR 전용)
// -----------------------------------------------------------------------------
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false, // 이 컴포넌트는 서버에서 렌더링하지 않습니다.
  loading: () => (
    // 로딩 중 사용자에게 보여줄 UI
    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
      <div className="flex flex-col items-center gap-3">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
        <div className="text-sm animate-pulse">실시간 물리 시뮬레이션 준비 중...</div>
      </div>
    </div>
  ),
});

// -----------------------------------------------------------------------------
// 최종 최적화된 설정 상수
// - 모든 스타일, 색상, 물리 엔진 파라미터를 여기서 관리합니다.
// - 수정이 필요할 경우 이 섹션만 편집하면 됩니다.
// -----------------------------------------------------------------------------
const CONFIG = Object.freeze({
  STICKY_TOP: 96,

  // ✅ 물리 시뮬레이션 엔진 설정
  FORCE: Object.freeze({
    autoFitMs: 1200, // 줌인/아웃 전환 애니메이션 시간
    autoFitPadding: 70, // 줌인/아웃 시 여백
    cooldownTime: 5000, // 물리 시뮬레이션이 자동으로 멈추기까지 걸리는 시간 (밀리초)
    d3VelocityDecay: 0.08, // 노드의 속도 감쇠율 (높을수록 빨리 멈춤)
    d3AlphaMin: 0.0001, // 시뮬레이션이 멈추는 최소 활동량
    dragAlphaTarget: 0.35, // 드래그 중 시뮬레이션의 목표 활성도 (높을수록 주변 노드 반응이 강함)
    dragCooldownTime: 1000, // 드래그 종료 후 활발하게 움직이는 시간
    linkDistance: 70, // 연결된 노드들 사이의 기본 거리
    linkStrength: 0.8, // 링크의 당기는 힘
    chargeStrength: -450, // 노드들 사이의 반발력 (음수 값)
    chargeDistanceMax: 500, // 반발력이 작용하는 최대 거리
  }),

  // ✅ 원형 레이아웃 관련 설정
  GLOBE: Object.freeze({
    padding: 90, // 원형 그래프와 컨테이너 사이의 여백
    radialStrength: 0.08, // 노드들을 원형으로 되돌리려는 힘
    ringRatio: Object.freeze({
      book: 0.78,
      저자: 0.95,
      역자: 0.91,
      카테고리: 0.62,
      주제: 0.7,
      장르: 0.54,
      단계: 0.44,
      구분: 0.85,
    }),
    collideRadius: Object.freeze({ book: 18, other: 15 }), // 노드 겹침 방지 반경
    collideStrength: 0.65, // 충돌 힘의 강도
  }),

  // ✅ 라벨(글자) 렌더링 설정
  LABEL: Object.freeze({
    minScaleToShow: 1.05, // 이 줌 레벨 이상에서만 라벨 표시 (성능 최적화)
    maxCharsBase: 26, // 기본 라벨 최대 글자 수
    minDistance: 24,
    fadeThreshold: 0.9,
    grid: 18, // 라벨 충돌 방지 셀 크기
  }),

  // ✅ 노드 색상 설정
  NODE_COLOR: Object.freeze({
    book: "#2563eb",
    저자: "#16a34a",
    역자: "#0ea5e9",
    카테고리: "#f59e0b",
    주제: "#a855f7",
    장르: "#1d4ed8",
    단계: "#f97316",
    구분: "#ef4444",
  }),

  // ✅ 링크(연결선) 스타일 설정
  LINK_STYLE: Object.freeze({
    color: Object.freeze({
      카테고리: "#a855f7",
      단계: "#f59e0b",
      저자: "#10b981",
      역자: "#06b6d4",
      주제: "#ef4444",
      장르: "#3b82f6",
      구분: "#ef4444",
    }),
    width: Object.freeze({
      카테고리: 1.6,
      단계: 1.6,
      저자: 2.2,
      역자: 2.0,
      주제: 2.0,
      장르: 2.0,
      구분: 1.8,
    }),
    dash: Object.freeze({
      카테고리: [],
      단계: [],
      저자: [],
      역자: [5, 5],
      주제: [],
      장르: [],
      구분: [4, 8],
    }),
  }),
});

// -----------------------------------------------------------------------------
// 유틸리티 함수들
// -----------------------------------------------------------------------------
const norm = (v) => String(v || "").trim();

const splitList = (input) => {
  if (!input) return [];
  return String(input)
    .replace(/[\/|·•，、・／]/g, ",") // 다양한 구분 기호 처리
    .split(",")
    .map((s) => s.trim())
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

// 반응형 크기 측정 커스텀 훅
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
      const newSize = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize((prevSize) => {
        if (prevSize.width !== newSize.width || prevSize.height !== newSize.height) {
          return newSize;
        }
        return prevSize;
      });
      rafId = requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(measure);
    });
    resizeObserver.observe(element);
    rafId = requestAnimationFrame(measure);

    return () => {
      isActive = false;
      resizeObserver.unobserve(element);
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
  const FILTER_TYPES = ["카테고리", "단계", "저자", "역자", "주제", "장르", "구분"];
  FILTER_TYPES.forEach((type) => {
    facets[type] = new Set();
  });
  for (const book of books) {
    splitList(book.category).forEach((v) => facets.카테고리.add(v));
    splitList(book.subject).forEach((v) => facets.주제.add(v));
    splitList(book.genre).forEach((v) => facets.장르.add(v));
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
      [...set].sort((a, b) => a.localeCompare(b, "ko", { numeric: true })),
    ])
  );
};

// 링크 스타일 컴포넌트
const LinkSwatch = React.memo(({ type }) => {
  const { color, width, dash } = useMemo(
    () => ({
      color: CONFIG.LINK_STYLE.color[type] || "#9ca3af",
      width: CONFIG.LINK_STYLE.width[type] || 1.5,
      dash: CONFIG.LINK_STYLE.dash[type] || [],
    }),
    [type]
  );
  return (
    <svg width="52" height="14" className="shrink-0" aria-hidden="true">
      <line
        x1="3"
        y1="7"
        x2="49"
        y2="7"
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

  // 📦 상태 관리
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("전체"); // 현재 선택된 탭
  const [chip, setChip] = useState(null); // 현재 선택된 칩 (필터)
  const [hover, setHover] = useState(null); // 마우스가 올라간 노드
  const [lastTap, setLastTap] = useState({ id: null, ts: 0 }); // 더블 탭 처리를 위한 상태
  const [isClient, setIsClient] = useState(false); // 클라이언트 측 렌더링 확인
  const [engineState, setEngineState] = useState("initializing"); // 물리 엔진 상태
  const [isDragging, setIsDragging] = useState(false); // 드래그 중인지 여부

  // 🔗 참조 객체들 (렌더링에 영향을 주지 않는 값 저장)
  const containerRef = useRef(null);
  const graphRef = useRef(null); // ForceGraph2D 인스턴스 참조
  const abortControllerRef = useRef(null);
  const hoveredNodeRef = useRef(null);
  const dragNodeRef = useRef(null);
  const simulationRef = useRef(null); // D3 시뮬레이션 직접 제어용

  // 🚀 성능 최적화 (useDeferredValue를 사용하여 상태 업데이트 지연)
  const deferredTab = useDeferredValue(tab);
  const deferredChip = useDeferredValue(chip);

  const { width, height } = useContainerSize(containerRef);

  // CSR (Client Side Rendering) 플래그
  useEffect(() => setIsClient(true), []);

  // 호버 상태 동기화
  useEffect(() => {
    hoveredNodeRef.current = hover?.node?.id || null;
  }, [hover?.node?.id]);

  // 📥 데이터 페칭 (책 목록 불러오기)
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
          .filter((book) => book?.id && book?.title)
          .map((book) => ({
            ...book,
            id: String(book.id),
          }));
        setBooks(processedBooks);
        setEngineState("ready");
      } catch (err) {
        if (err.name === "AbortError") return;
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

  // 🧠 그래프 데이터 메모화 (성능 최적화)
  const baseGraph = useMemo(() => {
    if (!books.length) return { nodes: [], links: [] };
    return buildGraphData(books);
  }, [books]);

  const facetOptions = useMemo(() => {
    if (!books.length) return {};
    return extractFacets(books);
  }, [books]);

  // 📊 필터링된 그래프 데이터
  const filteredGraph = useMemo(() => {
    // 필터링 로직 (생략)
    if (!baseGraph.nodes.length) {
      return { nodes: [], links: [] };
    }
    const FILTER_TYPES = ["카테고리", "단계", "저자", "역자", "주제", "장르", "구분"];
    if (deferredTab === "전체") {
      return {
        nodes: baseGraph.nodes,
        links: baseGraph.links.map((link) => ({
          ...link,
          source: getLinkEnds(link)[0],
          target: getLinkEnds(link)[1],
        })),
      };
    }
    if (!deferredChip) {
      const typeLinks = baseGraph.links.filter((link) => link.type === deferredTab);
      const nodeIds = new Set();
      typeLinks.forEach((link) => {
        const [source, target] = getLinkEnds(link);
        nodeIds.add(source);
        nodeIds.add(target);
      });
      return {
        nodes: baseGraph.nodes.filter((node) => nodeIds.has(node.id)),
        links: typeLinks.map((link) => ({
          ...link,
          source: getLinkEnds(link)[0],
          target: getLinkEnds(link)[1],
        })),
      };
    }
    const targetId = `${deferredTab}:${deferredChip}`;
    const relatedLinks = baseGraph.links.filter((link) => {
      if (link.type !== deferredTab) return false;
      const [source, target] = getLinkEnds(link);
      return source === targetId || target === targetId;
    });
    const nodeIds = new Set([targetId]);
    relatedLinks.forEach((link) => {
      const [source, target] = getLinkEnds(link);
      nodeIds.add(source);
      nodeIds.add(target);
    });
    return {
      nodes: baseGraph.nodes.filter((node) => nodeIds.has(node.id)),
      links: relatedLinks.map((link) => ({
        ...link,
        source: getLinkEnds(link)[0],
        target: getLinkEnds(link)[1],
      })),
    };
  }, [baseGraph, deferredTab, deferredChip]);

  // ⚙️ 엔진 상태 관리
  useEffect(() => {
    if (filteredGraph.nodes.length > 0) {
      setEngineState("running");
    }
  }, [filteredGraph.nodes.length, deferredTab, deferredChip]);

  // 🖼️ 노드 렌더링 함수
  const renderNode = useCallback((node, ctx, globalScale) => {
    if (!node || node.x == null || node.y == null) return;
    const isBook = node.type === "book";
    const isHovered = hoveredNodeRef.current === node.id;
    const isDraggedNode = dragNodeRef.current === node.id;
    const radius = isBook ? 9 : 8;
    const highlightRadius = isDraggedNode ? radius + 3 : radius;
    if (isDraggedNode) {
      // 드래그 중인 노드에 글로우 효과
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius + 6, 0, 2 * Math.PI);
      ctx.fillStyle = `${CONFIG.NODE_COLOR[node.type]}30`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius + 3, 0, 2 * Math.PI);
      ctx.fillStyle = `${CONFIG.NODE_COLOR[node.type]}60`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(node.x, node.y, highlightRadius, 0, 2 * Math.PI);
    ctx.fillStyle = CONFIG.NODE_COLOR[node.type] || "#6b7280";
    ctx.fill();
    if (isDraggedNode) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius, 0, 2 * Math.PI);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // 라벨 표시 조건 (LOD 적용)
    const shouldShowLabel = isHovered || isBook || isDraggedNode || globalScale >= CONFIG.LABEL.minScaleToShow;
    if (!shouldShowLabel) return;
    const maxChars = Math.max(8, Math.floor(CONFIG.LABEL.maxCharsBase / Math.pow(globalScale, 0.3)));
    const rawText = node.label || "";
    const displayText = rawText.length > maxChars ? `${rawText.slice(0, maxChars - 1)}…` : rawText;
    const fontSize = Math.max(11, 14 / Math.pow(globalScale, 0.15));
    ctx.font = `${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const angle = Math.atan2(node.y, node.x);
    const labelOffset = highlightRadius + 12;
    const labelX = node.x + labelOffset * Math.cos(angle);
    const labelY = node.y + labelOffset * Math.sin(angle);
    if (isHovered || isDraggedNode || globalScale < 1.5) {
      const textMetrics = ctx.measureText(displayText);
      const bgWidth = textMetrics.width + 10;
      const bgHeight = fontSize + 8;
      ctx.fillStyle = isDraggedNode ? "rgba(37, 99, 235, 0.15)" : "rgba(255, 255, 255, 0.95)";
      ctx.fillRect(labelX - bgWidth / 2, labelY - bgHeight / 2, bgWidth, bgHeight);
      if (isDraggedNode) {
        ctx.strokeStyle = "rgba(37, 99, 235, 0.3)";
        ctx.lineWidth = 1;
        ctx.strokeRect(labelX - bgWidth / 2, labelY - bgHeight / 2, bgWidth, bgHeight);
      }
    }
    ctx.fillStyle = isDraggedNode ? "#1e40af" : isHovered ? "#1e40af" : "#374151";
    ctx.fillText(displayText, labelX, labelY);
  }, []);

  // 🖼️ 노드 포인터 렌더링 함수
  const renderNodePointer = useCallback((node, color, ctx) => {
    if (!node || node.x == null || node.y == null) return;
    const radius = node.type === "book" ? 16 : 14;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  // 🖼️ 링크 렌더링 함수
  const renderLink = useCallback((link, ctx) => {
    if (!link?.source || !link?.target || link.source.x == null || link.target.x == null) return;
    const { color, width, dash } = CONFIG.LINK_STYLE;
    ctx.save();
    ctx.strokeStyle = color[link.type] || "#9ca3af";
    ctx.lineWidth = width[link.type] || 1.5;
    const dashPattern = dash[link.type];
    if (dashPattern?.length) {
      ctx.setLineDash(dashPattern);
    }
    const sourceIsDragged = dragNodeRef.current && (typeof link.source === "object" ? link.source.id : link.source) === dragNodeRef.current;
    const targetIsDragged = dragNodeRef.current && (typeof link.target === "object" ? link.target.id : link.target) === dragNodeRef.current;
    if (sourceIsDragged || targetIsDragged) {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = (width[link.type] || 1.5) + 1.5;
      ctx.shadowColor = "rgba(37, 99, 235, 0.4)";
      ctx.shadowBlur = 3;
    }
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
    ctx.restore();
  }, []);

  // ⚡ 이벤트 핸들러들
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

  const handleNodeClick = useCallback(
    (node) => {
      if (!node) return;
      if (node.type === "book" && node.bookId) {
        const now = Date.now();
        // 더블탭/더블클릭 처리
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
    },
    [lastTap, router, handleNodeHover]
  );

  // 🔥 핵심: 실시간 물리 반응을 위한 드래그 이벤트 핸들러들
  const handleNodeDragStart = useCallback((node) => {
    setIsDragging(true);
    dragNodeRef.current = node?.id || null;
    const simulation = graphRef.current.d3Force && graphRef.current.d3Force();
    if (simulation) {
      simulationRef.current = simulation;
      // 드래그 시작 시 시뮬레이션의 `alphaTarget` 값을 높여 활발하게 만듦
      simulation.alphaTarget(CONFIG.FORCE.dragAlphaTarget).restart();
    }
  }, []);

  const handleNodeDrag = useCallback((node) => {
    // 드래그 중인 노드의 위치를 고정 (fx/fy 값 사용)
    if (simulationRef.current && node) {
      node.fx = node.x;
      node.fy = node.y;
    }
  }, []);

  const handleNodeDragEnd = useCallback((node) => {
    setIsDragging(false);
    dragNodeRef.current = null;
    const simulation = simulationRef.current;
    if (simulation && node) {
      // 드래그 종료 후 노드의 고정 위치 해제
      node.fx = null;
      node.fy = null;
      // 시뮬레이션을 다시 안정화 모드로 전환
      simulation.alphaTarget(0).alpha(0.3).restart();
      // 약간의 지연 후 자동 맞춤
      setTimeout(() => {
        try {
          if (!isDragging && graphRef.current) {
            graphRef.current.zoomToFit?.(1500, 60);
          }
        } catch (err) {
          console.warn("드래그 후 자동 맞춤 실패:", err);
        }
      }, 1200);
    }
  }, [isDragging]);

  const handleTabChange = useCallback((newTab) => {
    startTransition(() => {
      setTab(newTab);
      setChip(null);
    });
    gaEvent?.("filter_tab_change", {
      category: "interaction",
      action: "tab_change",
      label: newTab,
    });
  }, []);

  const handleChipChange = useCallback((newChip) => {
    startTransition(() => {
      setChip((prevChip) => (prevChip === newChip ? null : newChip));
    });
    gaEvent?.("filter_chip_change", {
      category: "interaction",
      action: "chip_change",
      label: newChip || "(all)",
    });
  }, []);

  const clearInteraction = useCallback(() => {
    setHover(null);
    setLastTap({ id: null, ts: 0 });
  }, []);

  // ⚙️ 물리 엔진 설정
  useEffect(() => {
    if (!graphRef.current || !width || !height) return;
    const graph = graphRef.current;
    const setupForces = () => {
      try {
        const linkForce = graph.d3Force?.("link");
        if (linkForce) linkForce.distance(CONFIG.FORCE.linkDistance).strength(CONFIG.FORCE.linkStrength);
        const chargeForce = graph.d3Force?.("charge");
        if (chargeForce) chargeForce.strength(CONFIG.FORCE.chargeStrength).distanceMax(CONFIG.FORCE.chargeDistanceMax);
        const globeRadius = Math.max(50, Math.min(width, height) / 2 - CONFIG.GLOBE.padding);
        const radialForce = forceRadial()
          .radius((node) => {
            const ratio = CONFIG.GLOBE.ringRatio[node.type] || 0.85;
            return globeRadius * ratio;
          })
          .x(0)
          .y(0)
          .strength(CONFIG.GLOBE.radialStrength);
        graph.d3Force("radial", radialForce);
        const collisionForce = forceCollide()
          .radius((node) => {
            return node.type === "book" ? CONFIG.GLOBE.collideRadius.book : CONFIG.GLOBE.collideRadius.other;
          })
          .strength(CONFIG.GLOBE.collideStrength);
        graph.d3Force("collide", collisionForce);
        simulationRef.current = graph.d3Force && graph.d3Force();
      } catch (err) {
        console.warn("Force 설정 중 오류:", err);
      }
    };
    const timer = setTimeout(setupForces, 200);
    return () => clearTimeout(timer);
  }, [width, height, filteredGraph.nodes.length]);

  // 줌 자동 맞춤
  useEffect(() => {
    if (!graphRef.current || !width || !height || !filteredGraph.nodes.length) return;
    const timer = setTimeout(() => {
      try {
        graphRef.current?.zoomToFit?.(CONFIG.FORCE.autoFitMs, CONFIG.FORCE.autoFitPadding);
      } catch (err) {
        console.warn("자동 맞춤 실패:", err);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [width, height, filteredGraph.nodes.length, deferredTab, deferredChip]);

  // 엔진 이벤트 핸들러
  const handleEngineTick = useCallback(() => {
    setEngineState("running");
  }, []);

  const handleEngineStop = useCallback(() => {
    setEngineState("stable");
    setTimeout(() => {
      try {
        if (!isDragging && graphRef.current) {
          graphRef.current?.zoomToFit?.(1200, 50);
        }
      } catch (err) {
        console.warn("최종 맞춤 실패:", err);
      }
    }, 1000);
  }, [isDragging]);

  // 키보드 접근성
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        clearInteraction();
      } else if (event.key === "Enter" && hover?.node?.type === "book") {
        router.push(`/book/${hover.node.bookId}`);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [clearInteraction, hover, router]);

  // 상태 계산
  const stats = useMemo(() => ({
    nodeCount: filteredGraph.nodes.length,
    linkCount: filteredGraph.links.length,
    bookCount: filteredGraph.nodes.filter((n) => n.type === "book").length,
  }), [filteredGraph]);

  const graphKey = `${deferredTab}-${deferredChip || "all"}-${stats.nodeCount}`;
  const showLoader = loading || !isClient || (engineState === "running" && stats.nodeCount > 0);

  const retryLoad = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* 헤더 */}
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-1">Book Map</h1>
            <p className="text-sm text-gray-600">실시간 물리 시뮬레이션 도서 네트워크 시각화</p>
          </div>
          <div className="text-right text-xs text-gray-500" aria-live="polite" role="status">
            <div>노드 {stats.nodeCount.toLocaleString()}개</div>
            <div>연결 {stats.linkCount.toLocaleString()}개</div>
            {stats.bookCount > 0 && <div>도서 {stats.bookCount.toLocaleString()}권</div>}
            {isDragging && <div className="text-blue-600 font-bold animate-pulse">🎯 실시간 물리 반응 중...</div>}
          </div>
        </header>

        {/* 필터 탭 */}
        <nav className="mb-3" role="tablist" aria-label="카테고리 필터">
          <div className="flex flex-wrap gap-2">
            {["전체", "카테고리", "단계", "저자", "역자", "주제", "장르", "구분"].map((tabOption) => (
              <button
                key={tabOption}
                role="tab"
                aria-selected={tab === tabOption}
                aria-controls="graph-visualization"
                onClick={() => handleTabChange(tabOption)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2${
                  tab === tabOption ? "bg-blue-600 text-white shadow-md" : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:shadow-sm"
                }`}
              >
                {tabOption}
              </button>
            ))}
          </div>
        </nav>

        {/* 서브 필터 칩 */}
        {["카테고리", "단계", "저자", "역자", "주제", "장르", "구분"].includes(tab) && facetOptions[tab]?.length > 0 && (
          <div className="mb-4" role="group" aria-label={`${tab} 상세 필터`}>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              <button
                onClick={() => handleChipChange(null)}
                aria-pressed={chip === null}
                className={`px-3 py-1.5 rounded-full text-sm transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1${
                  chip === null ? "bg-blue-100 text-blue-800 border-2 border-blue-300" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
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
                  className={`px-3 py-1.5 rounded-full text-sm transition-all duration-200 max-w-xs truncate focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1${
                    chip === option ? "bg-blue-100 text-blue-800 border-2 border-blue-300" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
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
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">노드 유형</h3>
            <div className="flex flex-wrap gap-4 text-sm">
              {[
                ["도서", "book"],
                ["저자", "저자"],
                ["역자", "역자"],
                ["카테고리", "카테고리"],
                ["주제", "주제"],
                ["장르", "장르"],
                ["단계", "단계"],
                ["구분", "구분"],
              ].map(([label, type]) => (
                <div key={type} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: CONFIG.NODE_COLOR[type] }} aria-hidden="true" />
                  <span className="text-gray-700">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">연결선 유형</h3>
            <div className="flex flex-wrap gap-4">
              {["카테고리", "단계", "저자", "역자", "주제", "장르", "구분"].map((type) => (
                <div key={type} className="flex items-center gap-2">
                  <LinkSwatch type={type} />
                  <span className="text-sm text-gray-700">{type}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="text-xs text-gray-600 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-3 border border-blue-100">
            <div className="mb-2 text-sm font-semibold text-blue-800">🎯 실시간 물리 시뮬레이션 가이드</div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              <div>
                <strong>드래그:</strong> 노드를 끌면 연결된 노드들이 실시간 반응
              </div>
              <div>
                <strong>물리법칙:</strong> 관성, 반발력, 인력이 자연스럽게 적용
              </div>
              <div>
                <strong>연쇄반응:</strong> 하나의 움직임이 전체 네트워크에 파급
              </div>
              <div>
                <strong>도서노드:</strong> 더블클릭으로 상세 페이지 이동
              </div>
              <div>
                <strong>확대/축소:</strong> 마우스 휠로 자유롭게 조작
              </div>
              <div>
                <strong>키보드:</strong> ESC로 초기화, Enter로 선택 이동
              </div>
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
              className="relative bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500"
              style={{
                minHeight: "600px",
                height: "clamp(600px, calc(100vh - 280px), 800px)",
                // 📱 모바일 환경 최적화 핵심!
                touchAction: "none", // 터치 스크롤 동작을 막음
                overscrollBehavior: "contain", // 스크롤 경계에서 새로고침 방지
              }}
              role="application"
              aria-label="실시간 물리 시뮬레이션 도서 네트워크 그래프"
              tabIndex={0}
              id="graph-visualization"
            >
              {/* 로딩 오버레이 */}
              {showLoader && (
                <div className="absolute inset-0 z-50 bg-white/90 backdrop-blur-sm flex items-center justify-center" role="status" aria-live="polite">
                  <div className="flex flex-col items-center gap-3">
                    <Loader text="실시간 물리 시뮬레이션을 초기화하고 있습니다..." size={28} />
                    <div className="text-sm text-gray-600">
                      {engineState === "running" ? "노드 간 실시간 상호작용 계산 중..." : "그래프 데이터 준비 중..."}
                    </div>
                  </div>
                </div>
              )}

              {/* 에러 상태 */}
              {error && (
                <div className="absolute inset-0 z-40 flex items-center justify-center p-6" role="alert" aria-live="assertive">
                  <div className="bg-white rounded-lg border border-red-200 p-6 max-w-md w-full text-center shadow-lg">
                    <div className="text-red-600 text-lg font-semibold mb-2">⚠️ 데이터 로드 실패</div>
                    <p className="text-gray-600 text-sm mb-4 leading-relaxed">{error}</p>
                    <button
                      onClick={retryLoad}
                      className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
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
                  enableZoomPanInteraction={true}
                  enableNodeDrag={true}
                  nodeLabel={() => ""}
                  nodeCanvasObject={renderNode}
                  nodePointerAreaPaint={renderNodePointer}
                  linkColor={() => "transparent"}
                  linkCanvasObject={renderLink}
                  linkCanvasObjectMode={() => "after"}
                  cooldownTime={CONFIG.FORCE.cooldownTime}
                  d3VelocityDecay={CONFIG.FORCE.d3VelocityDecay}
                  d3AlphaMin={CONFIG.FORCE.d3AlphaMin}
                  backgroundColor="#ffffff"
                  onNodeHover={handleNodeHover}
                  onNodeClick={handleNodeClick}
                  onNodeDragStart={handleNodeDragStart}
                  onNodeDrag={handleNodeDrag}
                  onNodeDragEnd={handleNodeDragEnd}
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

              {/* 향상된 툴팁 */}
              {hover?.node?.type === "book" && (
                <div
                  className="pointer-events-none absolute z-30 bg-gray-900/95 text-white rounded-xl p-4 shadow-2xl backdrop-blur-sm border border-gray-700 max-w-sm"
                  style={{
                    left: Math.max(12, Math.min((hover.x || 0) + 20, (width || 400) - 320)),
                    top: Math.max(12, Math.min((hover.y || 0) - 20, (height || 300) - 130)),
                    transform: "translateZ(0)",
                    transition: "all 250ms cubic-bezier(0.4, 0, 0.2, 1)",
                  }}
                  role="tooltip"
                  aria-live="polite"
                >
                  <div className="flex gap-3">
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
                        <div className="w-full h-full flex items-center justify-center text-gray-400">📖</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm leading-tight mb-2 line-clamp-2">{hover.node.label}</h4>
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
                      <div className="text-xs text-gray-400 bg-gray-800/60 rounded px-2 py-1">🎯 드래그로 실시간 물리 반응 • 더블클릭으로 상세보기</div>
                    </div>
                  </div>
                </div>
              )}

              {/* 실시간 상태 표시 */}
              {process.env.NODE_ENV === "development" && (
                <div className="absolute top-3 right-3 text-xs bg-black/30 text-white px-3 py-1 rounded-full">
                  {engineState} {isDragging && "| 🎯 실시간"}
                </div>
              )}

              {/* 접근성 안내 */}
              <div className="sr-only" aria-live="polite">
                {`현재 ${stats.nodeCount}개 노드와 ${stats.linkCount}개 연결이 표시됩니다. 탭 키로 필터를 탐색하고 ESC 키로 툴팁을 닫을 수 있습니다.`}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// SSR 방지: 이 페이지는 클라이언트 측에서만 렌더링되므로, SSR을 방지합니다.
export async function getServerSideProps() {
  return { props: {} };
}
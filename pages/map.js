// pages/map.js
// -----------------------------------------------------------------------------
// ✅ BOOK MAP — 드래그 연쇄 반응 복구(이전 동작으로 회귀) + 모바일 안정화
// - 핵심 포인트:
//   1) 드래그 시 d3AlphaTarget + d3ReheatSimulation 사용 → 연쇄적 유기적 움직임 복원
//   2) 모바일: touch-action:none, overscroll-behavior:contain → 풀다운 새로고침/튕김 방지
//   3) forceRadial/forceCollide 로 원형(지구본) 배치 + 겹침 최소화
//   4) LOD(줌레벨) 라벨 렌더링 + 캔버스 커스텀 렌더
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

// ⬇️ react-force-graph-2d 내부는 d3-force-3d를 사용합니다.
//    추가 사용자 force(radial/collide)도 3d 버전으로 가져오는 게 가장 안전합니다.
import { forceRadial, forceCollide } from "d3-force-3d";

import LeftPanel from "@/components/LeftPanel";
import Loader from "@/components/Loader";

// -----------------------------------------------------------------------------
// ForceGraph2D (CSR 전용)
// -----------------------------------------------------------------------------
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
      <div className="flex flex-col items-center gap-3">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600" />
        <div className="text-sm animate-pulse">그래프 초기화 중…</div>
      </div>
    </div>
  ),
});

// -----------------------------------------------------------------------------
// 설정값(필요 시 여기만 수정)
// -----------------------------------------------------------------------------
const CONFIG = Object.freeze({
  STICKY_TOP: 96,
  FORCE: Object.freeze({
    autoFitMs: 1000,
    autoFitPadding: 60,

    // ★ 물리 시뮬레이션 (연쇄 반응에 가장 큰 영향)
    cooldownTime: 5000,      // 오래 움직이게
    d3VelocityDecay: 0.08,   // 감속 낮게(0.05~0.12 권장)
    d3AlphaMin: 0.0001,

    // ★ 드래그 시 재가열 강도(알파 타깃)
    dragAlphaTarget: 0.35,

    // 링크/반발
    linkDistance: 70,
    linkStrength: 0.8,
    chargeStrength: -450,
    chargeDistanceMax: 500,
  }),
  GLOBE: Object.freeze({
    padding: 90,
    radialStrength: 0.08,
    ringRatio: Object.freeze({
      book: 0.78,
      저자: 0.95,
      역자: 0.91,
      카테고리: 0.62,
      주제: 0.70,
      장르: 0.54,
      단계: 0.44,
      구분: 0.85,
    }),
    collideRadius: Object.freeze({ book: 18, other: 15 }),
    collideStrength: 0.65,
  }),
  LABEL: Object.freeze({
    minScaleToShow: 1.05,
    maxCharsBase: 26,
  }),
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
  FILTER: Object.freeze({
    TYPES: Object.freeze(["카테고리", "단계", "저자", "역자", "주제", "장르", "구분"]),
  }),
});

// -----------------------------------------------------------------------------
// 유틸
// -----------------------------------------------------------------------------
const norm = (v) => String(v ?? "").trim();
const splitList = (input) =>
  !input
    ? []
    : String(input)
        .replace(/[\/|·•，、・／]/g, ",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
const normalizeDivision = (v) => {
  const s = norm(v);
  if (!s) return null;
  if (s.includes("번역")) return "번역서";
  if (s.includes("원서")) return "원서";
  if (s.includes("국외") || s.includes("해외")) return "국외서";
  if (s.includes("국내")) return "국내서";
  return s;
};

// 컨테이너 크기 측정
function useContainerSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// 링크 양끝 id 문자열화
const getLinkEnds = (l) => {
  const s = typeof l.source === "object" ? l.source?.id : l.source;
  const t = typeof l.target === "object" ? l.target?.id : l.target;
  return [String(s ?? ""), String(t ?? "")];
};

// 그래프 데이터 구성 (Book ↔ 속성 이분그래프)
const buildGraph = (books) => {
  const nodes = [];
  const links = [];
  const byId = new Map();

  const addNode = (id, label, type, extra = {}) => {
    if (byId.has(id)) return byId.get(id);
    const n = { id, label, type, ...extra };
    byId.set(id, n);
    nodes.push(n);
    return n;
  };
  const addLink = (s, t, type) => links.push({ source: s, target: t, type });

  for (const b of books) {
    if (!b?.id || !b?.title) continue;
    const bookId = `book:${b.id}`;
    addNode(bookId, b.title, "book", {
      bookId: String(b.id),
      image: b.image,
      author: b.author,
      publisher: b.publisher,
    });

    // 단일
    [[norm(b.author), "저자"], [norm(b.translator || b["역자"]), "역자"], [norm(b.level), "단계"], [normalizeDivision(b.division), "구분"]]
      .forEach(([val, type]) => {
        if (!val) return;
        const id = `${type}:${val}`;
        addNode(id, val, type);
        addLink(bookId, id, type);
      });

    // 다중
    [[splitList(b.category), "카테고리"], [splitList(b.subject), "주제"], [splitList(b.genre), "장르"]]
      .forEach(([arr, type]) => {
        arr.forEach((v) => {
          const id = `${type}:${v}`;
          addNode(id, v, type);
          addLink(bookId, id, type);
        });
      });
  }
  return { nodes, links };
};

// 패싯
const extractFacetList = (books) => {
  const sets = Object.fromEntries(CONFIG.FILTER.TYPES.map((t) => [t, new Set()]));
  for (const b of books) {
    splitList(b.category).forEach((v) => sets.카테고리.add(v));
    splitList(b.subject).forEach((v) => sets.주제.add(v));
    splitList(b.genre).forEach((v) => sets.장르.add(v));
    if (norm(b.level)) sets.단계.add(norm(b.level));
    const tr = norm(b.translator || b["역자"]);
    if (tr) sets.역자.add(tr);
    if (norm(b.author)) sets.저자.add(norm(b.author));
    const div = normalizeDivision(b.division);
    if (div) sets.구분.add(div);
  }
  const sort = (s) => [...s].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, sort(v)]));
};

// 링크 범례 샘플
const LinkSwatch = React.memo(({ type }) => {
  const color = CONFIG.LINK_STYLE.color[type] || "#9ca3af";
  const width = CONFIG.LINK_STYLE.width[type] || 1.5;
  const dash = CONFIG.LINK_STYLE.dash[type] || [];
  return (
    <svg width="52" height="14" className="shrink-0" aria-hidden="true">
      <line x1="3" y1="7" x2="49" y2="7" stroke={color} strokeWidth={width} strokeDasharray={dash.join(",")} strokeLinecap="round" />
    </svg>
  );
});

// -----------------------------------------------------------------------------
// 페이지
// -----------------------------------------------------------------------------
export default function BookMapPage() {
  const router = useRouter();

  // 상태
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState("전체");
  const [chip, setChip] = useState(null);
  const [hover, setHover] = useState(null);
  const [lastTap, setLastTap] = useState({ id: null, ts: 0 });
  const [isClient, setIsClient] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [engineState, setEngineState] = useState("init");

  // 참조
  const wrapRef = useRef(null);
  const graphRef = useRef(null);
  const hoveredIdRef = useRef(null);

  // 성능
  const dTab = useDeferredValue(tab);
  const dChip = useDeferredValue(chip);

  const { width, height } = useContainerSize(wrapRef);

  // CSR 플래그
  useEffect(() => setIsClient(true), []);

  // 데이터 로드
  useEffect(() => {
    let ac = new AbortController();
    setErr("");
    setLoading(true);
    fetch("/api/books?source=both&prefer=remote", { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then((raw) => {
        const rows = Array.isArray(raw) ? raw : [];
        const normalized = rows
          .filter((b) => b?.id && b?.title)
          .map((b) => ({ ...b, id: String(b.id) }));
        setBooks(normalized);
        setEngineState("ready");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setErr(e.message || "데이터 로드 실패");
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, []);

  // 그래프/패싯
  const base = useMemo(() => buildGraph(books), [books]);
  const facets = useMemo(() => extractFacetList(books), [books]);

  // 필터 적용
  const graph = useMemo(() => {
    if (!base.nodes.length) return { nodes: [], links: [] };
    if (dTab === "전체") {
      return {
        nodes: base.nodes,
        links: base.links.map((l) => {
          const [s, t] = getLinkEnds(l);
          return { ...l, source: s, target: t };
        }),
      };
    }
    if (!dChip) {
      const keep = base.links.filter((l) => l.type === dTab);
      const used = new Set();
      keep.forEach((l) => {
        const [s, t] = getLinkEnds(l);
        used.add(s);
        used.add(t);
      });
      return {
        nodes: base.nodes.filter((n) => used.has(n.id)),
        links: keep.map((l) => {
          const [s, t] = getLinkEnds(l);
          return { ...l, source: s, target: t };
        }),
      };
    }
    const id = `${dTab}:${dChip}`;
    const keep = base.links.filter((l) => {
      if (l.type !== dTab) return false;
      const [s, t] = getLinkEnds(l);
      return s === id || t === id;
    });
    const used = new Set([id]);
    keep.forEach((l) => {
      const [s, t] = getLinkEnds(l);
      used.add(s);
      used.add(t);
    });
    return {
      nodes: base.nodes.filter((n) => used.has(n.id)),
      links: keep.map((l) => {
        const [s, t] = getLinkEnds(l);
        return { ...l, source: s, target: t };
      }),
    };
  }, [base, dTab, dChip]);

  // 호버 id 동기화(라벨 표시 조건에 사용)
  useEffect(() => {
    hoveredIdRef.current = hover?.node?.id ?? null;
  }, [hover]);

  // ---------- 노드/링크 캔버스 렌더러 ----------
  const drawNode = useCallback((node, ctx, scale) => {
    if (node.x == null || node.y == null) return;
    const isBook = node.type === "book";
    const r = isBook ? 9 : 8;
    const isHovered = hoveredIdRef.current === node.id;

    // 점
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = CONFIG.NODE_COLOR[node.type] || "#6b7280";
    ctx.fill();

    // 라벨 LOD: 줌이 충분하거나(크게) or book or hover일 때만
    const showLabel = isBook || isHovered || scale >= CONFIG.LABEL.minScaleToShow;
    if (!showLabel) return;

    const maxChars = Math.max(8, Math.floor(CONFIG.LABEL.maxCharsBase / Math.pow(scale, 0.3)));
    const raw = node.label || "";
    const text = raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw;

    const fontSize = Math.max(11, 14 / Math.pow(scale, 0.15));
    ctx.font = `${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";

    // 라벨을 노드에서 방사형으로 약간 띄워서 배치
    const angle = Math.atan2(node.y, node.x);
    const off = r + 12;
    const x = node.x + off * Math.cos(angle);
    const y = node.y + off * Math.sin(angle);

    // 가독성 위한 연한 배경(저배율/호버 때)
    if (isHovered || scale < 1.5) {
      const m = ctx.measureText(text);
      const w = m.width + 10;
      const h = fontSize + 8;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(x - w / 2, y - h / 2, w, h);
    }
    ctx.fillStyle = "#374151";
    ctx.fillText(text, x, y);
  }, []);

  const drawNodePointer = useCallback((node, color, ctx) => {
    if (node.x == null || node.y == null) return;
    const r = node.type === "book" ? 16 : 14;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const drawLink = useCallback((l, ctx) => {
    if (!l.source || !l.target || l.source.x == null || l.target.x == null) return;
    const c = CONFIG.LINK_STYLE.color[l.type] || "#9ca3af";
    const w = CONFIG.LINK_STYLE.width[l.type] || 1.5;
    const d = CONFIG.LINK_STYLE.dash[l.type] || [];
    ctx.save();
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    if (d.length) ctx.setLineDash(d);
    ctx.beginPath();
    ctx.moveTo(l.source.x, l.source.y);
    ctx.lineTo(l.target.x, l.target.y);
    ctx.stroke();
    ctx.restore();
  }, []);

  // ---------- 인터랙션 ----------
  const handleHover = useCallback((node) => {
    if (!node || !graphRef.current) { setHover(null); return; }
    try {
      const p = graphRef.current.graph2ScreenCoords(node.x, node.y);
      setHover({ node, x: p.x, y: p.y });
    } catch {
      setHover({ node, x: node.x || 0, y: node.y || 0 });
    }
  }, []);

  const handleClick = useCallback((node) => {
    if (!node) return;
    if (node.type === "book" && node.bookId) {
      const now = Date.now();
      // 600ms 이내 더블탭/클릭 → 상세 이동
      if (lastTap.id === node.id && now - lastTap.ts < 600) {
        gaEvent?.("book_detail_click", {
          content_type: "book",
          item_id: node.bookId,
          item_name: node.label || "",
          method: "map_node",
        });
        setLastTap({ id: null, ts: 0 });
        router.push(`/book/${node.bookId}`);
        return;
      }
      handleHover(node);
      gaEvent?.("book_preview_open", {
        content_type: "book",
        item_id: node.bookId,
        item_name: node.label || "",
        method: "map_node",
      });
      setLastTap({ id: node.id, ts: now });
      return;
    }
    setHover(null);
    setLastTap({ id: null, ts: 0 });
  }, [lastTap, router, handleHover]);

  // ★★★★★ 드래그 연쇄 반응 — “이전 동작”으로 복구
  const onDragStart = useCallback((node) => {
    setIsDragging(true);
    // react-force-graph 공식 API 사용: 알파 타깃 올리고 즉시 재가열
    try {
      graphRef.current?.d3AlphaTarget(CONFIG.FORCE.dragAlphaTarget)?.d3ReheatSimulation?.();
    } catch {}
    // d3-drag가 fx/fy를 자동으로 세팅하지만, 안전하게 동기화
    if (node) { node.fx = node.x; node.fy = node.y; }
  }, []);

  const onDrag = useCallback((node) => {
    // 드래그 중 지속적으로 reheat → 주변 노드가 계속 반응
    try { graphRef.current?.d3ReheatSimulation?.(); } catch {}
    // 위치 고정 지속
    if (node) { node.fx = node.x; node.fy = node.y; }
  }, []);

  const onDragEnd = useCallback((node) => {
    setIsDragging(false);
    // 고정 해제 + 알파 타깃 0으로 내리며 자연스러운 안정화
    if (node) { node.fx = null; node.fy = null; }
    try { graphRef.current?.d3AlphaTarget(0)?.d3ReheatSimulation?.(); } catch {}
  }, []);

  // 탭/칩
  const changeTab = useCallback((next) => {
    startTransition(() => { setTab(next); setChip(null); });
    gaEvent?.("map_tab_change", { tab: next });
  }, []);
  const changeChip = useCallback((next) => {
    startTransition(() => setChip((v) => (v === next ? null : next)));
    gaEvent?.("map_chip_change", { tab, chip: next || "(전체)" });
  }, [tab]);

  const clearHover = useCallback(() => { setHover(null); setLastTap({ id: null, ts: 0 }); }, []);

  // ---------- force 주입 ----------
  useEffect(() => {
    if (!graphRef.current || !width || !height) return;
    const g = graphRef.current;
    const t = setTimeout(() => {
      try {
        // 링크
        const lf = g.d3Force?.("link");
        lf?.distance?.(CONFIG.FORCE.linkDistance)?.strength?.(CONFIG.FORCE.linkStrength);
        // 반발
        const ch = g.d3Force?.("charge");
        ch?.strength?.(CONFIG.FORCE.chargeStrength)?.distanceMax?.(CONFIG.FORCE.chargeDistanceMax);
        // 라디얼(원형)
        const R = Math.max(50, Math.min(width, height) / 2 - CONFIG.GLOBE.padding);
        const radial = forceRadial(
          (n) => (CONFIG.GLOBE.ringRatio[n.type] ?? 0.85) * R,
          0,
          0
        ).strength(CONFIG.GLOBE.radialStrength);
        g.d3Force("radial", radial);
        // 충돌
        const collide = forceCollide((n) => (n.type === "book" ? CONFIG.GLOBE.collideRadius.book : CONFIG.GLOBE.collideRadius.other))
          .strength(CONFIG.GLOBE.collideStrength);
        g.d3Force("collide", collide);
      } catch (e) {
        // 무시(브라우저별 내부 구현차 보호)
      }
    }, 150);
    return () => clearTimeout(t);
  }, [width, height, graph.nodes?.length]);

  // 자동 맞춤
  useEffect(() => {
    if (!graphRef.current || !width || !height || !graph.nodes?.length) return;
    const t = setTimeout(() => {
      try { graphRef.current?.zoomToFit?.(CONFIG.FORCE.autoFitMs, CONFIG.FORCE.autoFitPadding); } catch {}
    }, 500);
    return () => clearTimeout(t);
  }, [width, height, graph.nodes?.length, dTab, dChip]);

  // 엔진 상태
  const onTick = useCallback(() => setEngineState("running"), []);
  const onStop = useCallback(() => setEngineState("stable"), []);

  // 통계
  const nodeCount = graph.nodes.length;
  const linkCount = graph.links.length;
  const bookCount = graph.nodes.filter((n) => n.type === "book").length;

  const graphKey = `${dTab}|${dChip ?? "ALL"}|${nodeCount}`;
  const showSpinner = loading || !isClient || (nodeCount > 0 && engineState === "running");

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* 헤더 */}
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-1">Book Map</h1>
            <p className="text-sm text-gray-600">실시간 물리 시뮬레이션 도서 네트워크</p>
          </div>
          <div className="text-right text-xs text-gray-500" aria-live="polite">
            <div>노드 {nodeCount.toLocaleString()}개</div>
            <div>연결 {linkCount.toLocaleString()}개</div>
            {bookCount > 0 && <div>도서 {bookCount.toLocaleString()}권</div>}
            {isDragging && <div className="text-blue-600 font-bold animate-pulse">🎯 드래그 중(연쇄 반응)</div>}
          </div>
        </header>

        {/* 탭 */}
        <nav className="mb-3" role="tablist" aria-label="카테고리 필터">
          <div className="flex flex-wrap gap-2">
            {["전체", ...CONFIG.FILTER.TYPES].map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => changeTab(t)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  tab === t ? "bg-blue-600 text-white shadow-md" : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:shadow-sm"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </nav>

        {/* 칩 */}
        {CONFIG.FILTER.TYPES.includes(tab) && (
          <div className="mb-4" role="group" aria-label={`${tab} 상세 필터`}>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              <button
                onClick={() => changeChip(null)}
                aria-pressed={chip == null}
                className={`px-3 py-1.5 rounded-full text-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                  chip == null ? "bg-blue-100 text-blue-800 border-2 border-blue-300" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                전체
              </button>
              {(facets[tab] || []).map((v) => (
                <button
                  key={v}
                  onClick={() => changeChip(v)}
                  aria-pressed={chip === v}
                  title={v}
                  className={`px-3 py-1.5 rounded-full text-sm transition-all max-w-xs truncate focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                    chip === v ? "bg-blue-100 text-blue-800 border-2 border-blue-300" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 범례 */}
        <div className="mb-4 bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">노드 유형</h3>
            <div className="flex flex-wrap gap-4 text-sm">
              {[
                ["도서", "book"], ["저자", "저자"], ["역자", "역자"], ["카테고리", "카테고리"],
                ["주제", "주제"], ["장르", "장르"], ["단계", "단계"], ["구분", "구분"],
              ].map(([label, key]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: CONFIG.NODE_COLOR[key] }} aria-hidden="true" />
                  <span className="text-gray-700">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">연결선 유형</h3>
            <div className="flex flex-wrap gap-4">
              {CONFIG.FILTER.TYPES.map((t) => (
                <div key={t} className="flex items-center gap-2">
                  <LinkSwatch type={t} />
                  <span className="text-sm text-gray-700">{t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 본문 레이아웃 */}
        <div className="grid grid-cols-1 lg:grid-cols-7 gap-6">
          <aside className="hidden lg:block lg:col-span-2">
            <LeftPanel books={books} stickyTop={CONFIG.STICKY_TOP} />
          </aside>

          <main className="lg:col-span-5">
            <div
              ref={wrapRef}
              className="relative bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500"
              style={{
                minHeight: "600px",
                height: "clamp(600px, calc(100vh - 280px), 800px)",
                // 📱 모바일 튕김 방지(풀다운 새로고침/제스처 차단)
                touchAction: "none",
                overscrollBehavior: "contain",
              }}
              role="application"
              aria-label="도서 관계 그래프"
              tabIndex={0}
              id="graph-visualization"
            >
              {/* 로더 */}
              {showSpinner && (
                <div className="absolute inset-0 z-50 bg-white/90 backdrop-blur-sm flex items-center justify-center" role="status" aria-live="polite">
                  <div className="flex flex-col items-center gap-3">
                    <Loader text="실시간 물리 시뮬레이션 준비 중…" size={24} />
                    <div className="text-sm text-gray-600">{engineState === "running" ? "노드 상호작용 계산 중…" : "그래프 초기화…"}</div>
                  </div>
                </div>
              )}

              {/* 에러 */}
              {err && (
                <div className="absolute inset-0 z-40 flex items-center justify-center p-6" role="alert" aria-live="assertive">
                  <div className="bg-white rounded-lg border border-red-200 p-6 max-w-md w-full text-center shadow-lg">
                    <div className="text-red-600 text-lg font-semibold mb-2">⚠️ 데이터 로드 실패</div>
                    <p className="text-gray-600 text-sm mb-4 leading-relaxed">{err}</p>
                    <button onClick={() => window.location.reload()} className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2">
                      다시 시도
                    </button>
                  </div>
                </div>
              )}

              {/* 그래프 */}
              {isClient && !loading && !err && nodeCount > 0 && (
                <ForceGraph2D
                  key={graphKey}
                  ref={graphRef}
                  width={width}
                  height={height}
                  graphData={graph}
                  enableZoomPanInteraction={true}
                  enableNodeDrag={true}
                  // 캔버스 렌더
                  nodeLabel={() => ""}
                  nodeCanvasObject={drawNode}
                  nodePointerAreaPaint={drawNodePointer}
                  linkColor={() => "transparent"}
                  linkCanvasObject={drawLink}
                  linkCanvasObjectMode={() => "after"}
                  // 물리 파라미터
                  cooldownTime={CONFIG.FORCE.cooldownTime}
                  d3VelocityDecay={CONFIG.FORCE.d3VelocityDecay}
                  d3AlphaMin={CONFIG.FORCE.d3AlphaMin}
                  backgroundColor="#ffffff"
                  // 이벤트
                  onNodeHover={handleHover}
                  onNodeClick={handleClick}
                  onNodeDragStart={onDragStart}
                  onNodeDrag={onDrag}
                  onNodeDragEnd={onDragEnd}
                  onBackgroundClick={clearHover}
                  onBackgroundRightClick={clearHover}
                  onNodeRightClick={clearHover}
                  onEngineTick={onTick}
                  onEngineStop={onStop}
                />
              )}

              {/* 빈 상태 */}
              {!loading && !err && nodeCount === 0 && isClient && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                  <div className="text-center">
                    <div className="text-4xl mb-4">📚</div>
                    <div className="text-lg font-medium mb-2">데이터가 없습니다</div>
                    <div className="text-sm">선택한 필터에 해당하는 도서가 없습니다.</div>
                  </div>
                </div>
              )}

              {/* 도서 툴팁 */}
              {hover?.node?.type === "book" && (
                <div
                  className="pointer-events-none absolute z-30 bg-gray-900/95 text-white rounded-xl p-4 shadow-2xl backdrop-blur-sm border border-gray-700 max-w-sm"
                  style={{
                    left: Math.max(12, Math.min((hover.x || 0) + 20, (width || 400) - 320)),
                    top: Math.max(12, Math.min((hover.y || 0) - 20, (height || 300) - 130)),
                    transform: "translateZ(0)",
                    transition: "all 200ms ease",
                  }}
                  role="tooltip"
                >
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-16 h-20 bg-gray-700 rounded-lg overflow-hidden ring-1 ring-white/20">
                      {hover.node.image ? (
                        <img src={hover.node.image} alt="" className="w-full h-full object-cover" loading="lazy" onError={(e) => (e.currentTarget.style.display = "none")} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">📖</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm leading-tight mb-2 line-clamp-2">{hover.node.label}</h4>
                      {hover.node.author && <div className="flex items-center gap-1 text-xs text-blue-200 mb-1">👤 <span className="truncate">{hover.node.author}</span></div>}
                      {hover.node.publisher && <div className="flex items-center gap-1 text-xs text-gray-300 mb-2">🏢 <span className="truncate">{hover.node.publisher}</span></div>}
                      <div className="text-xs text-gray-400 bg-gray-800/60 rounded px-2 py-1">드래그로 실시간 반응 · 더블클릭으로 상세 보기</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

// SSR 방지(이 페이지는 CSR 가정)
export async function getServerSideProps() {
  return { props: {} };
}

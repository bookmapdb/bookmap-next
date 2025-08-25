// pages/map.js
// -----------------------------------------------------------------------------
// ✅ 한 번에 붙여넣기용 ‘지구본(원형) 수렴 + 라벨 겹침 최소화’ 적용 완성본
// - 기존 기능 모두 유지 + 아래 개선 추가
//   1) 라디얼(forceRadial) + 충돌(forceCollide)로 원형 수렴(글로브) 
//   2) 원 경계(동그란 화면) 밖으로 튀는 노드 자동 클램프
//   3) 라벨 LOD(확대/호버/도서 우선) + 그리드 기반 라벨 겹침 억제
//   4) 타입별 동심원(ringRatio)로 구조 가독성 향상
//   5) 기존 링크 커스텀 렌더, 툴팁, 더블탭 이동, 자동 맞춤 등 그대로 유지
// -----------------------------------------------------------------------------

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { event as gaEvent } from "@/lib/gtag"; // ⬅️ GA4 이벤트 유틸

// ✨ 추가: d3-force-3d (react-force-graph와 100% 호환되는 힘들)
//  - 설치: npm i d3-force-3d
import * as d3 from "d3-force-3d";

import LeftPanel from "@/components/LeftPanel";
import Loader from "@/components/Loader";

// -----------------------------------------------------------------------------
// ForceGraph2D 를 CSR 로드 (SSR 단계에서 window 없음 → 오류 방지)
// -----------------------------------------------------------------------------
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
      그래프 초기화…
    </div>
  ),
});

// -----------------------------------------------------------------------------
// [🛠️ EDIT ME] 빠른 설정 - 그래프 스타일/물리/글로브/라벨
// -----------------------------------------------------------------------------
const CONFIG = {
  // 좌측 패널 sticky 기준(상단 네비 높이에 맞춰 조절)
  STICKY_TOP: 96,

  // 그래프 인터랙션/시뮬레이션(움직임 느낌)
  FORCE: {
    // 자동 맞춤(zoomToFit) 애니메이션 시간/여백
    autoFitMs: 800,
    autoFitPadding: 50,

    // d3 물리 (전체 거동)
    cooldownTime: 3000, // 값↑ 오래 움직임 (기본 1500 → 3000)
    d3VelocityDecay: 0.25, // 값↓ 관성 큼 (기본 0.35 → 0.25)
    d3AlphaMin: 0.0005, // 더 오래 수렴

    // 링크/반발 세부 튜닝 (아래 useEffect에서 주입)
    linkDistance: 60, // 값↑ 노드 간격 넓어짐 (기본 52 → 60)
    linkStrength: 1.2, // 링크 강도
    chargeStrength: -300, // 음수(반발) 절댓값↑ 더 밀어냄 (-240 → -300)
  },

  // ✨ 글로브(원형) 레이아웃 파라미터
  GLOBE: {
    padding: 80, // 원 경계와 컨테이너 사이 여유(px)
    radialStrength: 0.08, // 라디얼 힘 강도(값↑ 더 둥글게 조임)
    // 타입별 ‘링 비율’ (원 반지름 R의 몇 % 지점에 위치시킬지)
    ringRatio: {
      book: 0.72, // 도서
      저자: 0.9,
      역자: 0.88,
      카테고리: 0.58,
      주제: 0.66,
      장르: 0.5,
      단계: 0.4,
      구분: 0.8,
    },
    // 충돌 반경(px)
    collideRadius: { book: 14, other: 12 },
  },

  // ✨ 라벨 표시 정책(LOD + 충돌 억제)
  LABEL: {
    minScaleToShow: 1.05, // 이 배율 이상이면 일반 노드 라벨 노출
    grid: 18, // 라벨-충돌 억제용 그리드 크기(px)
    maxCharsBase: 22, // 기본 라벨 최대 글자(배율에 따라 가변)
  },

  // 노드 타입별 색상 — "book"은 도서 노드 전용 키(고정)
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

  // 링크(연결선) 스타일 — 타입별 색/두께/점선
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
      역자: [6, 6], // 역자 = 점선
      주제: [],
      장르: [],
      구분: [4, 8], // 구분 = 듬성 점선
    },
  },

  // 탭 노출 순서 (필터 타입)
  FILTER: { TYPES: ["카테고리", "단계", "저자", "역자", "주제", "장르", "구분"] },
};

// -----------------------------------------------------------------------------
// 유틸 함수/훅
// -----------------------------------------------------------------------------
const norm = (v) => String(v ?? "").trim();

function splitList(input) {
  if (!input) return [];
  let s = String(input);
  // 다양한 구분자를 쉼표로 통일
  s = s.replace(/[\/|·•]/g, ",").replace(/[，、・／]/g, ",");
  return s.split(",").map((t) => t.trim()).filter(Boolean);
}

function normalizeDivision(v) {
  const s = norm(v);
  if (!s) return "";
  if (s.includes("번역")) return "번역서";
  if (s.includes("원서")) return "원서";
  if (s.includes("국외") || s.includes("해외")) return "국외서";
  if (s.includes("국내")) return "국내서";
  return s;
}

// 반응형: 컨테이너 실제 렌더 크기 측정
function useSize(ref) {
  const [sz, setSz] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setSz({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return sz;
}

// 링크의 양 끝을 "문자열 id"로 반환(객체/문자열 모두 대응)
function getLinkEnds(link) {
  const s = typeof link.source === "object" && link.source ? link.source.id : link.source;
  const t = typeof link.target === "object" && link.target ? link.target.id : link.target;
  return [String(s), String(t)];
}

/* ─────────────────────────────────────────────────────────────
   그래프 데이터 모델: 이분 그래프(Book ↔ 속성 노드)
   - ❗️ 이 함수가 없으면 "buildGraph is not defined" 에러가 납니다.
   - books 배열(도서 API 결과)을 받아 nodes/links 객체를 만듭니다.
────────────────────────────────────────────────────────────── */
function buildGraph(books) {
  const nodes = [];
  const links = [];
  const byId = new Map();

  const addNode = (id, label, type, extra = {}) => {
    if (byId.has(id)) return byId.get(id);
    const node = { id, label, type, ...extra };
    byId.set(id, node);
    nodes.push(node);
    return node;
  };

  for (const b of books) {
    const bookId = `book:${b.id}`;
    addNode(bookId, b.title, "book", {
      bookId: b.id,
      image: b.image,
      author: b.author,
      publisher: b.publisher,
    });

    if (norm(b.author)) {
      const id = `저자:${norm(b.author)}`;
      addNode(id, norm(b.author), "저자");
      links.push({ source: bookId, target: id, type: "저자" });
    }

    const tr = norm(b.translator ?? b["역자"]);
    if (tr) {
      const id = `역자:${tr}`;
      addNode(id, tr, "역자");
      links.push({ source: bookId, target: id, type: "역자" });
    }

    for (const c of splitList(b.category)) {
      const id = `카테고리:${c}`;
      addNode(id, c, "카테고리");
      links.push({ source: bookId, target: id, type: "카테고리" });
    }

    for (const s of splitList(b.subject)) {
      const id = `주제:${s}`;
      addNode(id, s, "주제");
      links.push({ source: bookId, target: id, type: "주제" });
    }

    for (const g of splitList(b.genre)) {
      const id = `장르:${g}`;
      addNode(id, g, "장르");
      links.push({ source: bookId, target: id, type: "장르" });
    }

    if (norm(b.level)) {
      const id = `단계:${norm(b.level)}`;
      addNode(id, norm(b.level), "단계");
      links.push({ source: bookId, target: id, type: "단계" });
    }

    const div = normalizeDivision(b.division);
    if (div) {
      const id = `구분:${div}`;
      addNode(id, div, "구분");
      links.push({ source: bookId, target: id, type: "구분" });
    }
  }

  return { nodes, links };
}

/* ─────────────────────────────────────────────────────────────
   facet 칩 데이터(필터 칩 용)
   - ❗️ 이 함수가 없으면 "extractFacetList is not defined" 에러가 납니다.
────────────────────────────────────────────────────────────── */
function extractFacetList(books) {
  const sets = Object.fromEntries(CONFIG.FILTER.TYPES.map((t) => [t, new Set()]));
  for (const b of books) {
    splitList(b.category).forEach((v) => sets.카테고리?.add(v));
    splitList(b.subject).forEach((v) => sets.주제?.add(v));
    splitList(b.genre).forEach((v) => sets.장르?.add(v));
    if (norm(b.level)) sets.단계?.add(norm(b.level));
    const tr = norm(b.translator ?? b["역자"]);
    if (tr) sets.역자?.add(tr);
    if (norm(b.author)) sets.저자?.add(norm(b.author));
    const div = normalizeDivision(b.division);
    if (div) sets.구분?.add(div);
  }
  const sort = (s) => [...s].sort((a, b) => a.localeCompare(b, "ko"));
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, sort(v)]));
}

/* ─────────────────────────────────────────────────────────────
   링크(선) 범례 샘플 컴포넌트
   - [🛠️ EDIT ME] 선 스타일은 CONFIG.LINK_STYLE 에서 통일 관리
────────────────────────────────────────────────────────────── */
function LinkSwatch({ type }) {
  const color = CONFIG.LINK_STYLE.color[type] || "#9ca3af";
  const width = CONFIG.LINK_STYLE.width[type] || 1.5;
  const dash = CONFIG.LINK_STYLE.dash[type] || [];
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
}

// -----------------------------------------------------------------------------
// 페이지 컴포넌트
// -----------------------------------------------------------------------------
export default function BookMapPage() {
  const router = useRouter();

  // 데이터 상태
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 필터 상태(탭/칩)
  const [tab, setTab] = useState("전체"); // "전체" 또는 CONFIG.FILTER.TYPES 중 하나
  const [chip, setChip] = useState(null); // 해당 탭의 구체 값

  // 그래프 컨테이너/참조
  const wrapRef = useRef(null);
  const { width, height } = useSize(wrapRef);
  const graphRef = useRef(null);

  // 툴팁(도서 노드 hover)
  const [hover, setHover] = useState(null); // { node, x, y }

  // ✅ 라벨-충돌 억제용 set + 호버 노드 id 보관 (drawNode에서 참조)
  const labelBinsRef = useRef(new Set());
  const hoveredIdRef = useRef(null);
  useEffect(() => { hoveredIdRef.current = hover?.node?.id ?? null; }, [hover]);

  // 모바일 더블탭 판별 (700ms 이내 같은 노드 2회)
  const [lastTap, setLastTap] = useState({ id: null, ts: 0 });

  // CSR 전용 렌더 플래그
  const [isClient, setIsClient] = useState(false);
  useEffect(() => setIsClient(true), []);

  // 그래프 물리 엔진 준비 여부(스피너 제어)
  const [graphReady, setGraphReady] = useState(false);

  // 데이터 가져오기 (처음 마운트시 1회)
  useEffect(() => {
    setErr("");
    setLoading(true);
    fetch("/api/books?source=both&prefer=remote")
      .then(async (r) => {
        if (!r.ok) throw new Error(`API ${r.status}`);
        return r.json();
      })
      .then((raw) => {
        const normalized = (raw || []).map((b) => ({
          ...b,
          id: b?.id != null ? String(b.id) : null, // id 문자열 통일
        }));
        setBooks(normalized);
      })
      .catch((e) => setErr(e.message || "데이터 로드 실패"))
      .finally(() => setLoading(false));
  }, []);

  // 전체 그래프/칩
  const baseGraph = useMemo(() => buildGraph(books), [books]);
  const facetChips = useMemo(() => extractFacetList(books), [books]);

  // 필터 적용 그래프
  const { nodes, links } = useMemo(() => {
    if (tab === "전체") {
      const normalized = baseGraph.links.map((l) => {
        const [s, t] = getLinkEnds(l);
        return { ...l, source: s, target: t };
      });
      return { nodes: baseGraph.nodes, links: normalized };
    }

    if (!chip) {
      const keepLinks = baseGraph.links.filter((l) => l.type === tab);
      const used = new Set();
      keepLinks.forEach((l) => {
        const [s, t] = getLinkEnds(l);
        used.add(s);
        used.add(t);
      });
      const keepNodes = baseGraph.nodes.filter((n) => used.has(n.id));
      const normalized = keepLinks.map((l) => {
        const [s, t] = getLinkEnds(l);
        return { ...l, source: s, target: t };
      });
      return { nodes: keepNodes, links: normalized };
    }

    const attrId = `${tab}:${chip}`;
    const keepLinks = baseGraph.links.filter((l) => {
      if (l.type !== tab) return false;
      const [s, t] = getLinkEnds(l);
      return s === attrId || t === attrId;
    });
    const used = new Set([attrId]);
    keepLinks.forEach((l) => {
      const [s, t] = getLinkEnds(l);
      used.add(s);
      used.add(t);
    });
    const keepNodes = baseGraph.nodes.filter((n) => used.has(n.id));
    const normalized = keepLinks.map((l) => {
      const [s, t] = getLinkEnds(l);
      return { ...l, source: s, target: t };
    });
    return { nodes: keepNodes, links: normalized };
  }, [baseGraph, tab, chip]);

  // 그래프 내용/필터 변경 시: 엔진 안정화 전으로 표시(스피너 보이도록)
  useEffect(() => {
    setGraphReady(false);
  }, [tab, chip, nodes.length, links.length]);

  const nodeCount = nodes.length;
  const linkCount = links.length;

  // ---------------------------------------------------------------------------
  // ✨ 캔버스 렌더러: 노드(도트 + 라벨 LOD)
  //  - 라벨은 (호버 || 도서 || 줌 배율 충족) 일 때만 표기
  //  - 같은 프레임에서 가까운 라벨은 그리드 셀 단위로 하나만 표기(겹침 억제)
  //  - 원형 레이아웃에 맞춰 라벨을 바깥쪽으로 약간 밀어 배치
  // ---------------------------------------------------------------------------
  const drawNode = (node, ctx, scale) => {
    if (!node || node.x == null || node.y == null) return;

    const isBook = node.type === "book";
    const r = isBook ? 7 : 6;

    // 도트(점)
    ctx.beginPath();
    ctx.fillStyle = CONFIG.NODE_COLOR[node.type] || "#6b7280";
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fill();

    // ── 라벨 표시 조건(LOD)
    const hovered = hoveredIdRef.current && hoveredIdRef.current === node.id;
    const showLabel = hovered || isBook || scale >= CONFIG.LABEL.minScaleToShow;
    if (!showLabel) return;

    // ── 라벨 텍스트 준비(확대율에 따른 길이 가변 + 말줄임)
    const maxChars = Math.max(10, Math.floor(CONFIG.LABEL.maxCharsBase / Math.pow(scale, 0.4)));
    const raw = node.label || "";
    const text = raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw;

    // ── 원형 레이아웃에 맞춘 라벨 오프셋(중심에서 바깥쪽으로 밀어냄)
    const angle = Math.atan2(node.y, node.x);
    const off = r + 6;
    const lx = node.x + off * Math.cos(angle);
    const ly = node.y + off * Math.sin(angle);

    // ── 라벨-충돌 억제(그리드 셀 단위로 한 프레임에 하나만)
    const cell = CONFIG.LABEL.grid;
    const key = `${Math.round(lx / cell)},${Math.round(ly / cell)}`;
    if (!hovered && labelBinsRef.current.has(key)) return;
    labelBinsRef.current.add(key);

    // ── 실제 라벨 그리기
    ctx.font = `${Math.max(10, 12 / Math.pow(scale, 0.15))}px ui-sans-serif,-apple-system,BlinkMacSystemFont`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#374151";
    ctx.fillText(text, lx, ly);
  };

  // 드래그/호버 감지 범위(조금 넓게)
  const nodePointerAreaPaint = (node, color, ctx) => {
    if (!node || node.x == null || node.y == null) return;
    const r = node.type === "book" ? 11 : 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fill();
  };

  // 캔버스 렌더러: 링크(선)
  const drawLink = (l, ctx) => {
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
  };

  // ---------------------------------------------------------------------------
  // 호버(마우스 오버/포커스 유사) → 툴팁 표시
  // ---------------------------------------------------------------------------
  const handleHover = (node) => {
    if (!node || !graphRef.current) {
      setHover(null);
      return;
    }
    if (node.x == null || node.y == null) {
      setHover(null);
      return;
    }
    try {
      const p = graphRef.current.graph2ScreenCoords(node.x, node.y);
      setHover({ node, x: p.x, y: p.y });
    } catch {
      setHover({ node, x: node.x || 0, y: node.y || 0 });
    }
  };

  // ---------------------------------------------------------------------------
  // 클릭/탭 → 첫 탭은 툴팁, 700ms 내 동일 노드 두 번째 탭이면 상세 이동
  // ---------------------------------------------------------------------------
  const handleClick = (node) => {
    if (!node) return;

    if (node.type === "book" && node.bookId) {
      const now = Date.now();

      // 2번째 탭/클릭(700ms 이내): 상세 페이지 이동
      if (lastTap.id === node.id && now - lastTap.ts < 700) {
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

      // 1번째 탭/클릭: 툴팁만 띄움 + GA 프리뷰 오픈
      if (node.x != null && node.y != null) {
        try {
          const p = graphRef.current?.graph2ScreenCoords(node.x, node.y) || { x: node.x, y: node.y };
          setHover({ node, x: p.x, y: p.y });
        } catch {
          setHover({ node, x: node.x || 0, y: node.y || 0 });
        }
      }
      gaEvent?.("book_preview_open", {
        content_type: "book",
        item_id: node.bookId,
        item_name: node.label || "",
        method: "map_node",
      });
      setLastTap({ id: node.id, ts: now });
      return;
    }

    // 도서가 아닌 노드 → 툴팁 닫기
    setHover(null);
    setLastTap({ id: null, ts: 0 });
  };

  // ---------------------------------------------------------------------------
  // [🛠️ EDIT ME] 탭/칩 변경 헬퍼 + GA 이벤트
  // ---------------------------------------------------------------------------
  function handleTabChange(nextTab) {
    setTab(nextTab);
    setChip(null);
    gaEvent?.("map_tab_change", { tab: nextTab });
  }

  function handleChipChange(nextChip) {
    const newValue = nextChip === chip ? null : nextChip; // 토글
    setChip(newValue);
    gaEvent?.("map_chip_change", { tab, chip: newValue || "(전체)" });
  }

  // ---------------------------------------------------------------------------
  // [선택] 뷰포트/데이터 변경 시 자동 맞춤 (엔진 멈출 때도 한 번 더 맞춤)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!graphRef.current || !width || !height) return;
    const t = setTimeout(() => {
      try {
        graphRef.current.zoomToFit(CONFIG.FORCE.autoFitMs, CONFIG.FORCE.autoFitPadding);
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [width, height, nodeCount, linkCount, tab, chip]);

  // ---------------------------------------------------------------------------
  // ✨ d3Force 주입(링크 길이/강도, 반발력, 라디얼, 충돌)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!graphRef.current) return;
    const g = graphRef.current;

    // 링크 길이/강도 + 반발력
    const timer = setTimeout(() => {
      try {
        const lf = g.d3Force && g.d3Force("link");
        if (lf && typeof lf.distance === "function" && typeof lf.strength === "function") {
          lf.distance(CONFIG.FORCE.linkDistance).strength(CONFIG.FORCE.linkStrength);
        }
        const ch = g.d3Force && g.d3Force("charge");
        if (ch && typeof ch.strength === "function") {
          ch.strength(CONFIG.FORCE.chargeStrength);
        }
      } catch {}
    }, 100);

    return () => clearTimeout(timer);
  }, [nodeCount, linkCount]);

  // ✨ 라디얼(원형) + 충돌(forceCollide) 주입 — 사이즈/필터 상태 바뀔 때 갱신
  useEffect(() => {
    if (!graphRef.current || !width || !height) return;
    const g = graphRef.current;

    // 원 반지름(R) 계산
    const R = Math.max(40, Math.round(Math.min(width, height) / 2 - CONFIG.GLOBE.padding));

    // ① 라디얼(원형) 힘: 타입별 목표 반지름(동심원)
    const radial = d3
      .forceRadial((n) => {
        const ratio = CONFIG.GLOBE.ringRatio[n.type] ?? 0.85;
        return R * ratio;
      }, 0, 0)
      .strength(CONFIG.GLOBE.radialStrength);

    // ② 충돌: 점끼리 겹침 줄이기
    const collide = d3
      .forceCollide((n) => (n.type === "book" ? CONFIG.GLOBE.collideRadius.book : CONFIG.GLOBE.collideRadius.other))
      .strength(0.75);

    try {
      g.d3Force("radial", radial);
      g.d3Force("collide", collide);
    } catch {}
  }, [width, height, nodeCount, linkCount, tab, chip]);

  // ---------------------------------------------------------------------------
  // ✨ 원 경계 밖으로 나가는 노드 ‘클램프’ — 매 틱마다 살짝 보정
  // ---------------------------------------------------------------------------
  const clampToGlobe = () => {
    if (!graphRef.current) return;
    const W = width || 0;
    const H = height || 0;
    if (W <= 0 || H <= 0) return;

    const R = Math.max(40, Math.round(Math.min(W, H) / 2 - CONFIG.GLOBE.padding));
    const data = graphRef.current.graphData?.() || { nodes: [] };
    for (const n of data.nodes) {
      if (n?.x == null || n?.y == null) continue;
      const d = Math.hypot(n.x, n.y);
      if (d > R) {
        const k = R / (d || 1);
        n.x *= k; // 바깥으로 튀면 원 안쪽 경계로 붙임
        n.y *= k;
      }
    }
  };

  // 강제 리마운트 키(그래프 내부 상태 초기화용)
  const graphKey = `${tab}|${chip ?? "ALL"}|${nodeCount}|${linkCount}`;

  // 스피너 표시 여부 (데이터 로딩 or CSR 아님 or 엔진 미안정)
  const showSpinner =
    loading || !isClient || (!graphReady && (nodes.length > 0 || links.length > 0));

  // ---------------------------------------------------------------------------
  // 렌더
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        {/* 상단 타이틀 + 카운터 */}
        <div className="mb-2 flex items-center justify-between">
          <h1 className="text-2xl font-extrabold text-blue-600">BOOK MAP GRAPHIC VIEW</h1>
          <div className="text-xs text-gray-500">노드 {nodeCount}개 · 연결 {linkCount}개</div>
        </div>

        {/* 탭 */}
        <div className="mb-2 flex flex-wrap gap-2">
          {["전체", ...CONFIG.FILTER.TYPES].map((t) => (
            <button
              key={t}
              onClick={() => handleTabChange(t)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                tab === t ? "bg-gray-900 text-white border-gray-900" : "text-gray-700 border-gray-300 hover:bg-gray-100"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* 칩(하위 값) */}
        {CONFIG.FILTER.TYPES.includes(tab) && (
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              onClick={() => handleChipChange(null)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                chip == null ? "bg-blue-600 text-white border-blue-600" : "text-gray-700 border-gray-300 hover:bg-gray-100"
              }`}
            >
              전체
            </button>
            {(facetChips[tab] || []).map((v) => (
              <button
                key={v}
                onClick={() => handleChipChange(v)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  chip === v ? "bg-blue-600 text-white border-blue-600" : "text-gray-700 border-gray-300 hover:bg-gray-100"
                }`}
                title={v}
              >
                {v}
              </button>
            ))}
          </div>
        )}

        {/* 범례(노드 색 + 링크 스타일) */}
        <div className="mb-4 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm">
          {/* 노드(점) 범례 */}
          <div className="flex flex-wrap items-center gap-5">
            {[
              ["도서", "book"],
              ["저자", "저자"],
              ["역자", "역자"],
              ["카테고리", "카테고리"],
              ["주제", "주제"],
              ["장르", "장르"],
              ["단계", "단계"],
              ["구분", "구분"],
            ].map(([label, key]) => (
              <span key={label} className="inline-flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CONFIG.NODE_COLOR[key] }} />
                <span className="text-gray-700">{label}</span>
              </span>
            ))}
          </div>

          {/* 링크(선) 범례 */}
          <hr className="my-3 border-gray-200" />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {CONFIG.FILTER.TYPES.map((t) => (
              <span key={t} className="inline-flex items-center gap-2">
                <LinkSwatch type={t} /> {/* 작은 선 샘플 */}
                <span className="text-gray-700">{t}</span>
              </span>
            ))}
          </div>

          {/* 사용자 안내문 */}
          <p className="mt-2 text-xs text-gray-500">
            마우스(또는 모바일)로 줌 인/아웃 가능합니다. 도서(파란 점)와 속성 노드가 선으로 연결됩니다.
            유형(저자·역자·카테고리 등)에 따라 선의 색·굵기·점선 패턴이 다릅니다.
            (예: <span className="underline">역자·구분</span>은 점선)
            <br />
            <strong>팁:</strong> 도서 노드를 드래그하여 이동하고, 호버/터치로 미리보기를 확인하세요.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-7">
          {/* 좌측 패널(공지/NEW BOOK/이벤트) → 내부에서 높이 자동 조절 */}
          <aside className="hidden md:col-span-2 md:block">
            <LeftPanel books={books} stickyTop={CONFIG.STICKY_TOP} />
          </aside>

          {/* 그래프 영역 */}
          <section className="md:col-span-5">
            <div
              ref={wrapRef}
              className="relative rounded-2xl border border-gray-200 bg-white"
              // [🛠️ EDIT ME] 고정 높이 대신 뷰포트 기반 자동 높이
              style={{ minHeight: 520, height: "clamp(520px, calc(100vh - 220px), 900px)", overflow: "hidden" }}
            >
              {/* 로딩 스피너 오버레이 */}
              {showSpinner && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/65 backdrop-blur-[1px]">
                  <Loader text="노드 그래픽 뷰 로딩중입니다. 잠시만 기다려주세요" size={22} />
                </div>
              )}

              {err && (
                <div className="absolute inset-0 z-10 flex items-center justify-center text-red-600">
                  데이터 로드 오류: {err}
                </div>
              )}

              {/* 그래프 본체 */}
              {isClient && !loading && (
                <ForceGraph2D
                  key={graphKey}
                  ref={graphRef}
                  width={width || undefined}
                  height={height || undefined}
                  graphData={{ nodes, links }}
                  enableZoomPanInteraction={true}
                  enableNodeDrag={true}
                  nodeLabel={() => ""} // 기본 title 툴팁 끄기(브라우저)
                  nodeCanvasObject={drawNode} // 노드(도트+라벨 LOD)
                  nodePointerAreaPaint={nodePointerAreaPaint}
                  linkColor={() => "rgba(0,0,0,0)"} // 기본 링크 숨김
                  linkCanvasObject={drawLink} // 링크(선) 커스텀 렌더
                  linkCanvasObjectMode={() => "after"}
                  cooldownTime={CONFIG.FORCE.cooldownTime}
                  d3VelocityDecay={CONFIG.FORCE.d3VelocityDecay}
                  d3AlphaMin={CONFIG.FORCE.d3AlphaMin}
                  backgroundColor="#ffffff"
                  onNodeHover={handleHover}
                  onNodeClick={handleClick}
                  // 빈 배경 클릭/우클릭 → 툴팁 닫기
                  onBackgroundClick={() => {
                    setHover(null);
                    setLastTap({ id: null, ts: 0 });
                  }}
                  onBackgroundRightClick={() => {
                    setHover(null);
                    setLastTap({ id: null, ts: 0 });
                  }}
                  // (선택) 노드 우클릭 → 툴팁 닫기
                  onNodeRightClick={() => {
                    setHover(null);
                  }}
                  // ✨ 라벨-셀 비움: 프레임마다 중복 셀 초기화(라벨 충돌 억제)
                  onRenderFramePre={() => {
                    labelBinsRef.current.clear();
                  }}
                  // ✨ 엔진 틱마다 원 경계로 클램프(둥근 형태 유지)
                  onEngineTick={clampToGlobe}
                  // 엔진 안정화 뒤: 스피너 닫고, 보기 좋게 화면 맞춤(약간 지연)
                  onEngineStop={() => {
                    setGraphReady(true);
                    setTimeout(() => {
                      try {
                        graphRef.current?.zoomToFit?.(CONFIG.FORCE.autoFitMs, CONFIG.FORCE.autoFitPadding);
                      } catch {}
                    }, 500);
                  }}
                />
              )}

              {/* 툴팁 UI (도서 노드 전용) */}
              {hover?.node && hover.node.type === "book" && (
                <div
                  className="pointer-events-none absolute z-20 w-56 rounded-xl bg-gray-900/95 p-3 text-white shadow-2xl backdrop-blur-sm"
                  style={{
                    left: Math.max(8, Math.min((hover.x || 0) + 15, (width || 320) - 240)),
                    top: Math.max(8, Math.min((hover.y || 0) - 10, (height || 200) - 140)),
                    transition: "all 0.2s ease-out",
                  }}
                >
                  <div className="flex gap-3">
                    <div className="h-20 w-14 overflow-hidden rounded-md bg-gray-700 shrink-0 ring-1 ring-white/20">
                      {hover.node.image ? (
                        <img
                          src={hover.node.image}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="h-full w-full bg-gray-700 flex items-center justify-center">
                          <span className="text-xs text-gray-400">📚</span>
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm leading-tight line-clamp-2 mb-1">{hover.node.label}</div>
                      {hover.node.author && (
                        <div className="text-xs text-blue-200 truncate mb-0.5">👤 {hover.node.author}</div>
                      )}
                      {hover.node.publisher && (
                        <div className="text-[11px] text-gray-300 truncate">🏢 {hover.node.publisher}</div>
                      )}
                      <div className="mt-2 text-[10px] text-gray-400">더블탭(또는 더블클릭)으로 상세 보기</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ⬇️ 빌드 타임 프리렌더 방지: /map 은 요청 시 SSR로 렌더(데이터 의존/CSR 안전)
export async function getServerSideProps() {
  return { props: {} };
}

/* -----------------------------------------------------------------------------
   [🧩 고급] 새 타입 추가 가이드 (예: "시리즈")
   1) CONFIG.NODE_COLOR     에 '시리즈' 색 추가
   2) CONFIG.LINK_STYLE.*   에 '시리즈' 키 추가(color/width/dash)
   3) CONFIG.FILTER.TYPES   배열에 '시리즈' 추가(탭 노출)
   4) buildGraph() 안에서 도서의 series 값을 읽어 다음 로직 추가:
        for (const s of splitList(b.series)) {
          const id = `시리즈:${s}`;
          addNode(id, s, "시리즈");
          links.push({ source: bookId, target: id, type: "시리즈" });
        }
   5) extractFacetList() 에서도 sets.시리즈.add(...) 추가
   끝! 나머지는 자동으로 연동됩니다.
----------------------------------------------------------------------------- */

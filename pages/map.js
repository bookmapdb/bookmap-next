// pages/map.js
// -----------------------------------------------------------------------------
// ✅ BOOK MAP — ‘노드 안내 문구’ 복구 + 드래그 연쇄 반응 확실화 + 모바일 안정화
// - 드래그 시: d3AlphaTarget + d3ReheatSimulation 호출로 네트워크가 유기적으로 ‘따라 움직임’
// - 모바일: touch-action:none, overscroll-behavior:contain 로 풀다운/제스처 간섭 차단
// - 스피너: 초기 로딩시에만 노출 (엔진 실행 중 오버레이가 포인터를 가로채지 않음)
// - 안내문구(가이드) 블록 복구: 화면 상단 범례 아래에 노출
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
// react-force-graph-2d 내부는 d3-force-3d 기반 → 사용자 정의 force도 3D 버전 사용 권장
import { forceRadial, forceCollide } from "d3-force-3d";

import LeftPanel from "@/components/LeftPanel";
import Loader from "@/components/Loader";

// ForceGraph2D (CSR 전용)
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

// 설정
const CONFIG = Object.freeze({
  STICKY_TOP: 96,
  FORCE: Object.freeze({
    autoFitMs: 1000,
    autoFitPadding: 60,
    // ▶ 물리(연쇄 반응)
    cooldownTime: 4500,     // 초기 수렴 시간
    d3VelocityDecay: 0.08,  // 감속 낮게 → 관성 유지
    d3AlphaMin: 0.0001,
    // ▶ 드래그 가열 강도
    dragAlphaTarget: 0.35,
    // ▶ 연결/반발
    linkDistance: 70,
    linkStrength: 0.9,
    chargeStrength: -520,
    chargeDistanceMax: 650,
    // ▶ 장기적 움직임 유지(초기 force 주입 시 함께 세팅)
    alphaDecay: 0.02, // d3AlphaDecay(0.02) ~= 기본보다 느리게 식힘
  }),
  GLOBE: Object.freeze({
    padding: 90,
    radialStrength: 0.08,
    ringRatio: Object.freeze({
      book: 0.78, 저자: 0.95, 역자: 0.91,
      카테고리: 0.62, 주제: 0.70, 장르: 0.54, 단계: 0.44, 구분: 0.85,
    }),
    collideRadius: Object.freeze({ book: 18, other: 15 }),
    collideStrength: 0.65,
  }),
  LABEL: Object.freeze({
    minScaleToShow: 1.05,
    maxCharsBase: 26,
  }),
  NODE_COLOR: Object.freeze({
    book: "#2563eb", 저자: "#16a34a", 역자: "#0ea5e9",
    카테고리: "#f59e0b", 주제: "#a855f7", 장르: "#1d4ed8", 단계: "#f97316", 구분: "#ef4444",
  }),
  LINK_STYLE: Object.freeze({
    color: Object.freeze({
      카테고리: "#a855f7", 단계: "#f59e0b", 저자: "#10b981", 역자: "#06b6d4",
      주제: "#ef4444", 장르: "#3b82f6", 구분: "#ef4444",
    }),
    width: Object.freeze({
      카테고리: 1.6, 단계: 1.6, 저자: 2.2, 역자: 2.0, 주제: 2.0, 장르: 2.0, 구분: 1.8,
    }),
    dash: Object.freeze({
      카테고리: [], 단계: [], 저자: [], 역자: [5,5], 주제: [], 장르: [], 구분: [4,8],
    }),
  }),
  FILTER: Object.freeze({ TYPES: Object.freeze(["카테고리","단계","저자","역자","주제","장르","구분"]) }),
});

// 유틸
const norm = (v) => String(v ?? "").trim();
const splitList = (input) =>
  !input ? [] :
  String(input).replace(/[\/|·•，、・／]/g, ",").split(",").map(s=>s.trim()).filter(Boolean);
const normalizeDivision = (v) => {
  const s = norm(v); if (!s) return null;
  if (s.includes("번역")) return "번역서";
  if (s.includes("원서")) return "원서";
  if (s.includes("국외")||s.includes("해외")) return "국외서";
  if (s.includes("국내")) return "국내서";
  return s;
};

// 컨테이너 크기 훅
function useContainerSize(ref){
  const [size,setSize]=useState({width:0,height:0});
  useEffect(()=>{
    if(!ref.current) return;
    const el=ref.current;
    const ro=new ResizeObserver(()=>{
      const r=el.getBoundingClientRect();
      setSize({width:Math.round(r.width),height:Math.round(r.height)});
    });
    ro.observe(el);
    return ()=>ro.disconnect();
  },[ref]);
  return size;
}

// 링크 id 정규화
const getEnds=(l)=>{
  const s= typeof l.source==='object'? l.source?.id : l.source;
  const t= typeof l.target==='object'? l.target?.id : l.target;
  return [String(s??''), String(t??'')];
};

// 그래프 데이터 구성
const buildGraph=(books)=>{
  const nodes=[], links=[]; const byId=new Map();
  const addNode=(id,label,type,extra={})=>{
    if(byId.has(id)) return byId.get(id);
    const n={id,label,type,...extra}; byId.set(id,n); nodes.push(n); return n;
  };
  const addLink=(s,t,type)=>links.push({source:s,target:t,type});

  for(const b of books){
    if(!b?.id || !b?.title) continue;
    const bookId=`book:${b.id}`;
    addNode(bookId,b.title,"book",{bookId:String(b.id), image:b.image, author:b.author, publisher:b.publisher});
    [[norm(b.author),"저자"],[norm(b.translator||b["역자"]),"역자"],[norm(b.level),"단계"],[normalizeDivision(b.division),"구분"]]
    .forEach(([v,t])=>{ if(!v) return; const id=`${t}:${v}`; addNode(id,v,t); addLink(bookId,id,t); });
    [[splitList(b.category),"카테고리"],[splitList(b.subject),"주제"],[splitList(b.genre),"장르"]]
    .forEach(([arr,t])=>arr.forEach(v=>{ const id=`${t}:${v}`; addNode(id,v,t); addLink(bookId,id,t); }));
  }
  return {nodes,links};
};

const extractFacetList=(books)=>{
  const sets=Object.fromEntries(CONFIG.FILTER.TYPES.map(t=>[t,new Set()]));
  for(const b of books){
    splitList(b.category).forEach(v=>sets.카테고리.add(v));
    splitList(b.subject).forEach(v=>sets.주제.add(v));
    splitList(b.genre).forEach(v=>sets.장르.add(v));
    if(norm(b.level)) sets.단계.add(norm(b.level));
    const tr=norm(b.translator||b["역자"]); if(tr) sets.역자.add(tr);
    if(norm(b.author)) sets.저자.add(norm(b.author));
    const div=normalizeDivision(b.division); if(div) sets.구분.add(div);
  }
  const sort=(s)=>[...s].sort((a,b)=>a.localeCompare(b,"ko",{numeric:true}));
  return Object.fromEntries(Object.entries(sets).map(([k,v])=>[k,sort(v)]));
};

const LinkSwatch = React.memo(({type})=>{
  const c=CONFIG.LINK_STYLE.color[type]||"#9ca3af";
  const w=CONFIG.LINK_STYLE.width[type]||1.5;
  const d=CONFIG.LINK_STYLE.dash[type]||[];
  return (
    <svg width="52" height="14" className="shrink-0" aria-hidden="true">
      <line x1="3" y1="7" x2="49" y2="7" stroke={c} strokeWidth={w} strokeDasharray={d.join(",")} strokeLinecap="round"/>
    </svg>
  );
});

// 페이지
export default function BookMapPage(){
  const router=useRouter();

  // 상태
  const [books,setBooks]=useState([]);
  const [loading,setLoading]=useState(true);
  const [err,setErr]=useState("");
  const [tab,setTab]=useState("전체");
  const [chip,setChip]=useState(null);
  const [hover,setHover]=useState(null);
  const [lastTap,setLastTap]=useState({id:null,ts:0});
  const [isClient,setIsClient]=useState(false);
  const [isDragging,setIsDragging]=useState(false);

  // ref
  const wrapRef=useRef(null);
  const graphRef=useRef(null);
  const hoveredIdRef=useRef(null);

  // 성능
  const dTab=useDeferredValue(tab);
  const dChip=useDeferredValue(chip);

  const {width,height}=useContainerSize(wrapRef);

  useEffect(()=>setIsClient(true), []);

  // 데이터
  useEffect(()=>{
    const ac=new AbortController();
    setErr(""); setLoading(true);
    fetch("/api/books?source=both&prefer=remote", {signal:ac.signal})
      .then(r=>{ if(!r.ok) throw new Error(`API ${r.status}`); return r.json(); })
      .then(raw=>{
        const rows=Array.isArray(raw)?raw:[];
        setBooks(rows.filter(b=>b?.id && b?.title).map(b=>({...b,id:String(b.id)})));
      })
      .catch(e=>{ if(e.name!=="AbortError") setErr(e.message||"데이터 로드 실패"); })
      .finally(()=>setLoading(false));
    return ()=>ac.abort();
  },[]);

  const base=useMemo(()=>buildGraph(books),[books]);
  const facets=useMemo(()=>extractFacetList(books),[books]);

  // 필터
  const graph=useMemo(()=>{
    if(!base.nodes.length) return {nodes:[],links:[]};
    if(dTab==="전체"){
      return {
        nodes: base.nodes,
        links: base.links.map(l=>{ const [s,t]=getEnds(l); return {...l, source:s, target:t}; }),
      };
    }
    if(!dChip){
      const keep=base.links.filter(l=>l.type===dTab);
      const used=new Set(); keep.forEach(l=>{ const [s,t]=getEnds(l); used.add(s); used.add(t); });
      return {
        nodes: base.nodes.filter(n=>used.has(n.id)),
        links: keep.map(l=>{ const [s,t]=getEnds(l); return {...l, source:s, target:t}; }),
      };
    }
    const id=`${dTab}:${dChip}`;
    const keep=base.links.filter(l=>{ if(l.type!==dTab) return false; const [s,t]=getEnds(l); return s===id || t===id; });
    const used=new Set([id]); keep.forEach(l=>{ const [s,t]=getEnds(l); used.add(s); used.add(t); });
    return {
      nodes: base.nodes.filter(n=>used.has(n.id)),
      links: keep.map(l=>{ const [s,t]=getEnds(l); return {...l, source:s, target:t}; }),
    };
  },[base,dTab,dChip]);

  // 호버 id 동기화
  useEffect(()=>{ hoveredIdRef.current=hover?.node?.id ?? null; },[hover]);

  // 캔버스 렌더러
  const drawNode=useCallback((n,ctx,scale)=>{
    if(n.x==null||n.y==null) return;
    const isBook=n.type==="book"; const r=isBook?9:8;
    const isHovered=hoveredIdRef.current===n.id;

    ctx.beginPath(); ctx.arc(n.x,n.y,r,0,2*Math.PI);
    ctx.fillStyle=CONFIG.NODE_COLOR[n.type]||"#6b7280"; ctx.fill();

    const showLabel=isBook || isHovered || scale>=CONFIG.LABEL.minScaleToShow;
    if(!showLabel) return;

    const maxChars=Math.max(8, Math.floor(CONFIG.LABEL.maxCharsBase/Math.pow(scale,0.3)));
    const raw=n.label||""; const text=raw.length>maxChars?raw.slice(0,maxChars-1)+"…":raw;

    const font=Math.max(11, 14/Math.pow(scale,0.15));
    ctx.font=`${font}px ui-sans-serif, -apple-system, BlinkMacSystemFont`;
    ctx.textAlign="center"; ctx.textBaseline="middle";

    const angle=Math.atan2(n.y,n.x); const off=r+12;
    const x=n.x+off*Math.cos(angle); const y=n.y+off*Math.sin(angle);

    if(isHovered || scale<1.5){
      const m=ctx.measureText(text); const w=m.width+10; const h=font+8;
      ctx.fillStyle="rgba(255,255,255,0.95)";
      ctx.fillRect(x-w/2, y-h/2, w, h);
    }
    ctx.fillStyle="#374151"; ctx.fillText(text,x,y);
  },[]);

  const drawNodePointer=useCallback((n,color,ctx)=>{
    if(n.x==null||n.y==null) return;
    const r=n.type==="book"?16:14;
    ctx.fillStyle=color; ctx.beginPath(); ctx.arc(n.x,n.y,r,0,2*Math.PI); ctx.fill();
  },[]);

  const drawLink=useCallback((l,ctx)=>{
    if(!l.source||!l.target||l.source.x==null||l.target.x==null) return;
    const c=CONFIG.LINK_STYLE.color[l.type]||"#9ca3af";
    const w=CONFIG.LINK_STYLE.width[l.type]||1.5;
    const d=CONFIG.LINK_STYLE.dash[l.type]||[];
    ctx.save(); ctx.strokeStyle=c; ctx.lineWidth=w; if(d.length) ctx.setLineDash(d);
    ctx.beginPath(); ctx.moveTo(l.source.x,l.source.y); ctx.lineTo(l.target.x,l.target.y); ctx.stroke(); ctx.restore();
  },[]);

  // 인터랙션
  const handleHover=useCallback((node)=>{
    if(!node||!graphRef.current){ setHover(null); return; }
    try{
      const p=graphRef.current.graph2ScreenCoords(node.x,node.y);
      setHover({node, x:p.x, y:p.y});
    }catch{
      setHover({node, x:node.x||0, y:node.y||0});
    }
  },[]);

  const handleClick=useCallback((node)=>{
    if(!node) return;
    if(node.type==="book" && node.bookId){
      const now=Date.now();
      if(lastTap.id===node.id && now-lastTap.ts<600){
        gaEvent?.("book_detail_click",{content_type:"book", item_id:node.bookId, item_name:node.label||"", method:"map_node"});
        setLastTap({id:null,ts:0}); router.push(`/book/${node.bookId}`); return;
      }
      handleHover(node);
      gaEvent?.("book_preview_open",{content_type:"book", item_id:node.bookId, item_name:node.label||"", method:"map_node"});
      setLastTap({id:node.id, ts:now}); return;
    }
    setHover(null); setLastTap({id:null,ts:0});
  },[lastTap,router,handleHover]);

  // ★ 드래그 연쇄반응(공식 API만 사용)
  const onDragStart=useCallback((node)=>{
    setIsDragging(true);
    try{ graphRef.current?.d3AlphaTarget(CONFIG.FORCE.dragAlphaTarget)?.d3ReheatSimulation?.(); }catch{}
    if(node){ node.fx=node.x; node.fy=node.y; }
  },[]);
  const onDrag=useCallback((node)=>{
    try{ graphRef.current?.d3ReheatSimulation?.(); }catch{}
    if(node){ node.fx=node.x; node.fy=node.y; }
  },[]);
  const onDragEnd=useCallback((node)=>{
    setIsDragging(false);
    if(node){ node.fx=null; node.fy=null; }
    try{ graphRef.current?.d3AlphaTarget(0)?.d3ReheatSimulation?.(); }catch{}
  },[]);

  // 탭/칩
  const changeTab=useCallback((t)=>{ startTransition(()=>{setTab(t); setChip(null);}); gaEvent?.("map_tab_change",{tab:t}); },[]);
  const changeChip=useCallback((v)=>{ startTransition(()=>setChip((c)=>c===v?null:v)); gaEvent?.("map_chip_change",{tab, chip:v||"(전체)"}); },[tab]);

  const clearHover=useCallback(()=>{ setHover(null); setLastTap({id:null,ts:0}); },[]);

  // force 주입
  useEffect(()=>{
    if(!graphRef.current||!width||!height) return;
    const g=graphRef.current;
    const t=setTimeout(()=>{
      try{
        // 링크/반발
        g.d3Force("link")?.distance(CONFIG.FORCE.linkDistance)?.strength(CONFIG.FORCE.linkStrength);
        g.d3Force("charge")?.strength(CONFIG.FORCE.chargeStrength)?.distanceMax(CONFIG.FORCE.chargeDistanceMax);
        // 라디얼 & 충돌
        const R=Math.max(50, Math.min(width,height)/2 - CONFIG.GLOBE.padding);
        g.d3Force("radial",
          forceRadial(n => (CONFIG.GLOBE.ringRatio[n.type]??0.85)*R, 0, 0).strength(CONFIG.GLOBE.radialStrength)
        );
        g.d3Force("collide",
          forceCollide(n => n.type==="book"?CONFIG.GLOBE.collideRadius.book:CONFIG.GLOBE.collideRadius.other)
            .strength(CONFIG.GLOBE.collideStrength)
        );
        // 장기 움직임 유지
        g.d3AlphaDecay?.(CONFIG.FORCE.alphaDecay);
      }catch{}
    },150);
    return ()=>clearTimeout(t);
  },[width,height,graph.nodes?.length]);

  // 자동 맞춤
  useEffect(()=>{
    if(!graphRef.current||!width||!height||!graph.nodes?.length) return;
    const t=setTimeout(()=>{ try{ graphRef.current.zoomToFit(CONFIG.FORCE.autoFitMs, CONFIG.FORCE.autoFitPadding); }catch{} }, 450);
    return ()=>clearTimeout(t);
  },[width,height,graph.nodes?.length,dTab,dChip]);

  // 통계 & 스피너
  const nodeCount=graph.nodes.length;
  const linkCount=graph.links.length;
  const bookCount=graph.nodes.filter(n=>n.type==="book").length;
  const graphKey=`${dTab}|${dChip??"ALL"}|${nodeCount}`;
  const showSpinner = loading || !isClient; // ⬅️ 엔진 실행 중엔 오버레이 없음(포인터 차단 방지)

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
            {bookCount>0 && <div>도서 {bookCount.toLocaleString()}권</div>}
            {isDragging && <div className="text-blue-600 font-bold animate-pulse">🎯 드래그 중(연쇄 반응)</div>}
          </div>
        </header>

        {/* 탭 */}
        <nav className="mb-2" role="tablist" aria-label="카테고리 필터">
          <div className="flex flex-wrap gap-2">
            {["전체", ...CONFIG.FILTER.TYPES].map(t=>(
              <button
                key={t}
                role="tab"
                aria-selected={tab===t}
                onClick={()=>changeTab(t)}
                className={`px-4 py-2 rounded-full text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  tab===t ? "bg-blue-600 text-white shadow-md" : "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 hover:shadow-sm"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </nav>

        {/* 칩 */}
        {CONFIG.FILTER.TYPES.includes(tab) && (
          <div className="mb-3" role="group" aria-label={`${tab} 상세 필터`}>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              <button
                onClick={()=>changeChip(null)}
                aria-pressed={chip==null}
                className={`px-3 py-1.5 rounded-full text-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                  chip==null ? "bg-blue-100 text-blue-800 border-2 border-blue-300" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                전체
              </button>
              {(facets[tab]||[]).map(v=>(
                <button
                  key={v}
                  onClick={()=>changeChip(v)}
                  aria-pressed={chip===v}
                  title={v}
                  className={`px-3 py-1.5 rounded-full text-sm transition-all max-w-xs truncate focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                    chip===v ? "bg-blue-100 text-blue-800 border-2 border-blue-300" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 범례 */}
        <div className="mb-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm">
          {/* 노드 색 범례 */}
          <div className="flex flex-wrap items-center gap-5">
            {[
              ["도서","book"],["저자","저자"],["역자","역자"],["카테고리","카테고리"],
              ["주제","주제"],["장르","장르"],["단계","단계"],["구분","구분"],
            ].map(([label,key])=>(
              <span key={key} className="inline-flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{background:CONFIG.NODE_COLOR[key]}}/>
                <span className="text-gray-700">{label}</span>
              </span>
            ))}
          </div>
          {/* 링크 범례 */}
          <hr className="my-3 border-gray-200"/>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {CONFIG.FILTER.TYPES.map(t=>(
              <span key={t} className="inline-flex items-center gap-2">
                <LinkSwatch type={t}/>
                <span className="text-gray-700">{t}</span>
              </span>
            ))}
          </div>
        </div>

        {/* ✅ ‘노드 안내 문구’ (요청 복구) */}
        <div className="mb-5 rounded-xl border border-blue-100 bg-blue-50/50 p-4 text-sm text-gray-700">
          <div className="font-semibold text-blue-800 mb-1">🎯 실시간 물리 시뮬레이션 가이드</div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-y-1">
            <div><strong>드래그:</strong> 노드를 끌면 연결된 노드들이 실시간 반응</div>
            <div><strong>물리법칙:</strong> 관성·반발력·인력이 자연스럽게 적용</div>
            <div><strong>연쇄반응:</strong> 하나의 움직임이 전체 네트워크에 파급</div>
            <div><strong>확대/축소:</strong> 마우스 휠로 자유롭게 조작</div>
            <div><strong>도서노드:</strong> 더블클릭(더블탭)으로 상세 페이지 이동</div>
            <div><strong>키보드:</strong> ESC로 미리보기 닫기</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-7 gap-6">
          <aside className="hidden lg:block lg:col-span-2">
            <LeftPanel books={books} stickyTop={CONFIG.STICKY_TOP}/>
          </aside>

          {/* 그래프 영역 */}
          <main className="lg:col-span-5">
            <div
              ref={wrapRef}
              className="relative bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500"
              style={{
                minHeight:"600px",
                height:"clamp(600px, calc(100vh - 280px), 820px)",
                // 📱 모바일 제스처 간섭 방지
                touchAction:"none",
                overscrollBehavior:"contain",
              }}
              role="application"
              aria-label="도서 관계 그래프"
              tabIndex={0}
              id="graph-visualization"
            >
              {/* 초기 로딩에만 스피너 표시 (포인터 차단 방지) */}
              {showSpinner && (
                <div className="absolute inset-0 z-40 bg-white/88 backdrop-blur-[1px] flex items-center justify-center" role="status" aria-live="polite">
                  <Loader text="그래프 데이터를 불러오는 중…" size={24}/>
                </div>
              )}

              {/* 에러 */}
              {err && (
                <div className="absolute inset-0 z-40 flex items-center justify-center p-6" role="alert" aria-live="assertive">
                  <div className="bg-white rounded-lg border border-red-200 p-6 max-w-md w-full text-center shadow-lg">
                    <div className="text-red-600 text-lg font-semibold mb-2">⚠️ 데이터 로드 실패</div>
                    <p className="text-gray-600 text-sm mb-4 leading-relaxed">{err}</p>
                    <button onClick={()=>window.location.reload()} className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2">
                      다시 시도
                    </button>
                  </div>
                </div>
              )}

              {/* 그래프 */}
              {isClient && !loading && !err && graph.nodes.length>0 && (
                <ForceGraph2D
                  key={graphKey}
                  ref={graphRef}
                  width={width}
                  height={height}
                  graphData={graph}
                  enableZoomPanInteraction={true}
                  enableNodeDrag={true}
                  // 렌더
                  nodeLabel={()=>""}
                  nodeCanvasObject={drawNode}
                  nodePointerAreaPaint={drawNodePointer}
                  linkColor={()=>"transparent"}
                  linkCanvasObject={drawLink}
                  linkCanvasObjectMode={()=>"after"}
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
                />
              )}

              {/* 빈 상태 */}
              {!loading && !err && graph.nodes.length===0 && isClient && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                  <div className="text-center">
                    <div className="text-4xl mb-4">📚</div>
                    <div className="text-lg font-medium mb-2">데이터가 없습니다</div>
                    <div className="text-sm">선택한 필터에 해당하는 도서가 없습니다.</div>
                  </div>
                </div>
              )}

              {/* 도서 툴팁 */}
              {hover?.node?.type==="book" && (
                <div
                  className="pointer-events-none absolute z-30 bg-gray-900/95 text-white rounded-xl p-4 shadow-2xl backdrop-blur-sm border border-gray-700 max-w-sm"
                  style={{
                    left: Math.max(12, Math.min((hover.x||0)+20, (width||400)-320)),
                    top:  Math.max(12, Math.min((hover.y||0)-20, (height||300)-130)),
                    transform:"translateZ(0)", transition:"all 200ms ease",
                  }}
                  role="tooltip"
                >
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-16 h-20 bg-gray-700 rounded-lg overflow-hidden ring-1 ring-white/20">
                      {hover.node.image ? (
                        <img src={hover.node.image} alt="" className="w-full h-full object-cover" loading="lazy"
                          onError={(e)=>{ e.currentTarget.style.display="none"; }}/>
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

// SSR 방지 (CSR 가정)
export async function getServerSideProps(){ return { props:{} }; }

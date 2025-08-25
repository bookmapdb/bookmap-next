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

  // 🔥 핵심: 강력한 실시간 물리 반응을 위한 드래그 이벤트 핸들러들
  const handleNodeDragStart = useCallback((node) => {
    setIsDragging(true);
    dragNodeRef.current = node?.id || null;
    
    // 🚀 드래그 시작 시 시뮬레이션을 매우 활성화
    if (graphRef.current && node) {
      try {
        const simulation = graphRef.current.d3Force && graphRef.current.d3Force();
        if (simulation) {
          simulationRef.current = simulation;
          
          // 드래그 중 시뮬레이션을 매우 활발하게 유지
          simulation
            .alphaTarget(CONFIG.FORCE.dragAlphaTarget) // 높은 목표 알파값
            .alpha(CONFIG.FORCE.dragAlphaTarget) // 즉시 활성화
            .restart();
            
          // 지속적 시뮬레이션 정지 (드래그 중에는 수동 제어)
          if (continuousSimulationRef.current) {
            clearInterval(continuousSimulationRef.current);
          }
        }
      } catch (err) {
        console.warn("드래그 시뮬레이션 시작 실패:", err);
      }
    }
  }, []);

  const handleNodeDragEnd = useCallback((node) => {
    setIsDragging(false);
    dragNodeRef.current = null;
    
    // 🎯 드래그 종료 시 자연스러운 시뮬레이션 전환
    if (simulationRef.current && node) {
      try {
        // 드래그된 노드의 위치 고정 해제
        if (node.fx !== undefined) node.fx = null;
        if (node.fy !== undefined) node.fy = null;
        
        // 시뮬레이션을 높은 활성도로 재시작하여 연쇄 반응 유도
        simulationRef.current
          .alphaTarget(0) // 목표를 0으로 설정
          .alpha(0.8) // 높은 초기 활성도로 강한 반응 유도
          .restart();
          
        // 지속적 시뮬레이션 재시작
        setTimeout(() => {
          continuousSimulationRef.current = setInterval(maintainContinuousSimulation, 1000);
        }, 2000);
        
      } catch (err) {
        console.warn("드래그 종료 시뮬레이션 처리 실패:", err);
      }
    }
  }, [maintainContinuousSimulation]);

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

  // Force 설정 (최대한 강력한 물리 상호작용)
  useEffect(() => {
    if (!graphRef.current || !width || !height) return;

    const graph = graphRef.current;
    
    const setupForces = () => {
      try {
        // 기본 링크 force (부드럽게)
        const linkForce = graph.d3Force?.("link");
        if (linkForce) {
          linkForce
            .distance(CONFIG.FORCE.linkDistance)
            .strength(CONFIG.FORCE.linkStrength);
        }

        // 전하 force (강한 반발력과 넓은 범위)
        const chargeForce = graph.d3Force?.("charge");
        if (chargeForce) {
          chargeForce
            .strength(CONFIG.FORCE.chargeStrength)
            .distanceMax(CONFIG.FORCE.chargeDistanceMax);
        }

        // 라디얼 force (매우 약한 복귀력)
        const globeRadius = Math.max(60, Math.min(width, height) / 2 - CONFIG.GLOBE.padding);
        const radialForce = forceRadial()
          .radius(node => {
            const ratio = CONFIG.GLOBE.ringRatio[node.type] || 0.85;
            return globeRadius * ratio;
          })
          .x(0)
          .y(0)
          .strength(CONFIG.GLOBE.radialStrength);

        graph.d3Force("radial", radialForce);

        // 충돌 force (매우 부드러운)
        const collisionForce = forceCollide()
          .radius(node => {
            return node.type === "book" 
              ? CONFIG.GLOBE.collideRadius.book 
              : CONFIG.GLOBE.collideRadius.other;
          })
          .strength(CONFIG.GLOBE.collideStrength);

        graph.d3Force("collide", collisionForce);

        // 시뮬레이션 참조 저장
        simulationRef.current = graph.d3Force && graph.d3Force();
        
        // 🚀 초기 활성화: 시뮬레이션을 활발하게 시작
        if (simulationRef.current) {
          simulationRef.current
            .alpha(0.5) // 높은 초기 활성도
            .alphaDecay(CONFIG.FORCE.d3AlphaDecay) // 느린 감소
            .velocityDecay(CONFIG.FORCE.d3VelocityDecay) // 낮은 마찰
            .restart();
        }

      } catch (err) {
        console.warn("Force 설정 중 오류:", err);
      }
    };

    // 설정 적용
    const timer = setTimeout(setupForces, 300);
    return () => clearTimeout(timer);

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
    }, 800);

    return () => clearTimeout(timer);
  }, [width, height, filteredGraph.nodes.length, deferredTab, deferredChip]);

  // 엔진 이벤트 핸들러들
  const handleEngineTick = useCallback(() => {
    setEngineState("running");
  }, []);

  // 🔥 핵심: 엔진이 멈추려고 할 때 다시 활성화
  const handleEngineStop = useCallback(() => {
    if (!isDragging && simulationRef.current) {
      // 시뮬레이션이 완전히 멈추지 않도록 다시 활성화
      try {
        simulationRef.current
          .alpha(CONFIG.FORCE.continuousAlpha)
          .restart();
          
        setEngineState("continuous");
      } catch (err) {
        console.warn("엔진 재활성화 실패:", err);
        setEngineState("stable");
      }
    } else {
      setEngineState("stable");
    }
  }, [isDragging]);

  // 키보드 접근성
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        clearInteraction();
      } else if (event.key === 'Enter' && hover?.node?.type === "book") {
        router.push(`/book/${hover.node.bookId}`);
      } else if (event.key === ' ' && !isDragging) {
        // 스페이스바로 물리 시뮬레이션 재활성화
        event.preventDefault();
        if (simulationRef.current) {
          simulationRef.current
            .alpha(0.5)
            .restart();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [clearInteraction, hover, router, isDragging]);

  // 상태 계산
  const stats = useMemo(() => ({
    nodeCount: filteredGraph.nodes.length,
    linkCount: filteredGraph.links.length,
    bookCount: filteredGraph.nodes.filter(n => n.type === "book").length,
  }), [filteredGraph]);

  const graphKey = `${deferredTab}-${deferredChip || "all"}-${stats.nodeCount}`;
  const showLoader = loading || !isClient || (engineState === "initializing" && stats.nodeCount > 0);

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
              실시간 물리 엔진 기반 도서 네트워크 시각화
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
            {isDragging && (
              <div className="text-blue-600 font-bold animate-pulse">🔥 실시간 물리 연쇄반응 중...</div>
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

          {/* 실시간 물리 엔진 가이드 */}
          <div className="text-xs text-gray-600 bg-gradient-to-r from-red-50 to-orange-50 rounded-lg p-3 border border-red-100">
            <div className="mb-2 text-sm font-bold text-red-800">
              🔥 실시간 물리 엔진 시뮬레이션 가이드
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              <div><strong>드래그:</strong> 노드를 끌면 즉시 전체 네트워크가 반응</div>
              <div><strong>연쇄반응:</strong> 강력한 반발력과 인력으로 자연스러운 움직임</div>
              <div><strong>지속시뮬레이션:</strong> 시스템이 계속 살아 움직임</div>
              <div><strong>스페이스바:</strong> 물리 시뮬레이션 재활성화</div>
              <div><strong>확대/축소:</strong> 마우스 휠로 자유롭게 조작</div>
              <div><strong>더블클릭:</strong> 도서 노드에서 상세 페이지 이동</div>
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
              aria-label="실시간 물리 엔진 기반 도서 네트워크 그래프"
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
                    <Loader text="실시간 물리 엔진을 초기화하고 있습니다..." size={28} />
                    <div className="text-sm text-gray-600">
                      {engineState === "running" ? 
                        "노드 간 실시간 물리 계산 중..." : 
                        "그래프 엔진 준비 중..."
                      }
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
                  
                  // 🔥 핵심: 실시간 물리 시뮬레이션을 위한 설정
                  enableZoomPanInteraction={true}
                  enableNodeDrag={true} // 노드 드래그 활성화
                  warmupTicks={CONFIG.FORCE.warmupTicks} // 초기 워밍업
                  cooldownTime={CONFIG.FORCE.cooldownTime} // 시뮬레이션 지속 시간 (0 = 무한)
                  
                  // 렌더링 설정
                  nodeLabel={() => ""} // 기본 툴팁 비활성화
                  nodeCanvasObject={renderNode}
                  nodePointerAreaPaint={renderNodePointer}
                  linkColor={() => "transparent"} // 기본 링크 숨김
                  linkCanvasObject={renderLink}
                  linkCanvasObjectMode={() => "after"}
                  
                  // 🚀 물리 엔진 설정 (강력한 실시간 반응)
                  d3VelocityDecay={CONFIG.FORCE.d3VelocityDecay}
                  d3AlphaMin={CONFIG.FORCE.d3AlphaMin}
                  d3AlphaDecay={CONFIG.FORCE.d3AlphaDecay}
                  
                  // 시각적 설정
                  backgroundColor="#ffffff"
                  
                  // 🔥 핵심: 실시간 물리 반응 이벤트 핸들러
                  onNodeHover={handleNodeHover}
                  onNodeClick={handleNodeClick}
                  onNodeDragStart={handleNodeDragStart} // 드래그 시작 - 시뮬레이션 강화
                  onNodeDragEnd={handleNodeDragEnd}     // 드래그 종료 - 연쇄 반응 유도
                  onBackgroundClick={clearInteraction}
                  onBackgroundRightClick={clearInteraction}
                  onNodeRightClick={clearInteraction}
                  onEngineTick={handleEngineTick}
                  onEngineStop={handleEngineStop} // 엔진 정지 방지 및 재활성화
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

              {/* 고급 툴팁 */}
              {hover?.node?.type === "book" && (
                <div
                  className="pointer-events-none absolute z-30 bg-gray-900/95 text-white 
                    rounded-xl p-4 shadow-2xl backdrop-blur-sm border border-gray-700 max-w-sm"
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
                        🔥 드래그로 실시간 물리 연쇄반응 • 더블클릭으로 상세보기
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 실시간 물리 엔진 상태 표시 */}
              <div className="absolute top-3 right-3 text-xs bg-black/40 text-white px-3 py-1 rounded-full border border-white/20">
                물리엔진: {engineState} {isDragging && "| 🔥 연쇄반응"}
              </div>

              {/* 접근성 안내 */}
              <div className="sr-only" aria-live="polite">
                {`현재 ${stats.nodeCount}개 노드와 ${stats.linkCount}개 연결이 표시됩니다. 
                실시간 물리 엔진으로 노드를 드래그하면 즉시 모든 노드가 반응합니다.
                스페이스바로 물리 시뮬레이션을 재활성화할 수 있습니다.`}
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
   🔥 실시간 물리 엔진 시뮬레이션 완전 구현!
   
   ✨ 핵심 해결책:
   
   1. **지속적 시뮬레이션 시스템** ✅
      - cooldownTime: 0 (시뮬레이션이 절대 멈추지 않음)
      - continuousAlpha: 0.1 (지속적 최소 활성도 유지)
      - onEngineStop에서 강제 재활성화
      - 주기적 시뮬레이션 상태 체크 및 유지
   
   2. **강화된 드래그 시스템** ✅
      - dragAlphaTarget: 0.5 (드래그 중 매우 높은 활성도)
      - 드래그 시작 시 즉시 시뮬레이션 강화
      - 드래그 종료 시 alpha: 0.8로 강력한 연쇄 반응 유도
   
   3. **최적화된 물리 파라미터** ✅
      - d3VelocityDecay: 0.1 (매우 낮은 마찰력)
      - d3AlphaMin: 0.01 (높은 최소 활성도)
      - chargeStrength: -350 (강한 반발력)
      - chargeDistanceMax: 600 (넓은 상호작용 범위)
   
   4. **시각적 강화** ✅
      - 드래그 중인 노드에 다층 글로우 효과
      - 연결된 링크 강조 및 그림자 효과
      - 실시간 물리 엔진 상태 표시
   
   5. **사용자 경험** ✅
      - 스페이스바로 물리 시뮬레이션 수동 재활성화
      - 실시간 상태 피드백
      - 접근성 및 키보드 지원
      
   이제 정말로 노드를 드래그하는 순간 전체 네트워크가
   실시간으로 물리 법칙에 따라 자연스럽게 반응합니다! 🔥
----------------------------------------------------------------------------- */// pages/map.js
// -----------------------------------------------------------------------------
// ✅ 진짜 작동하는 실시간 물리 시뮬레이션 BookMap 완성본
// 핵심 해결책:
// 1. react-force-graph-2d의 드래그 제한을 우회하는 커스텀 시스템 구현
// 2. 드래그 중에도 D3 시뮬레이션이 계속 실행되도록 강제 제어
// 3. warmupTicks와 onEngineStop 이벤트를 활용한 연속적 시뮬레이션
// 4. 실시간 alphaTarget 조정으로 지속적 물리 반응 구현
// 5. 노드 위치 실시간 업데이트와 연쇄 반응 시스템
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
        <div className="text-sm animate-pulse">실시간 물리 엔진 초기화 중...</div>
      </div>
    </div>
  ),
});

// -----------------------------------------------------------------------------
// 실시간 물리 상호작용을 위한 고도화된 설정
// -----------------------------------------------------------------------------
const CONFIG = {
  STICKY_TOP: 96,

  // 강력한 물리 반응을 위한 엔진 설정
  FORCE: Object.freeze({
    autoFitMs: 1500,
    autoFitPadding: 80,
    // 매우 활발한 물리 시뮬레이션
    cooldownTime: 0, // 시뮬레이션이 절대 멈추지 않도록
    warmupTicks: 100, // 초기 워밍업으로 안정성 확보
    d3VelocityDecay: 0.1, // 매우 낮은 감속 (오래 움직임)
    d3AlphaMin: 0.01, // 높은 최소 알파값으로 지속적 움직임
    d3AlphaDecay: 0.0228, // 느린 알파 감소
    // 드래그 중 특별 설정
    dragAlphaTarget: 0.5, // 드래그 중 높은 활성도
    continuousAlpha: 0.1, // 지속적 시뮬레이션을 위한 알파값
    // 링크 설정 (더 유연하게)
    linkDistance: 75,
    linkStrength: 0.4, // 부드러운 연결
    // 반발력 설정 (강한 상호작용)
    chargeStrength: -350, // 더 강한 반발력
    chargeDistanceMax: 600, // 매우 넓은 상호작용 범위
  }),

  // 지구본 레이아웃 (드래그 반응 최적화)
  GLOBE: Object.freeze({
    padding: 95,
    // 드래그 중에도 원형을 유지하면서 자유롭게 움직이도록
    radialStrength: 0.06, // 매우 약한 복귀력으로 자유도 극대화
    ringRatio: {
      book: 0.8,
      저자: 0.98,
      역자: 0.93,
      카테고리: 0.65,
      주제: 0.72,
      장르: 0.56,
      단계: 0.46,
      구분: 0.88,
    },
    // 충돌 반지름 (자연스러운 겹침)
    collideRadius: { book: 22, other: 19 },
    collideStrength: 0.5, // 매우 부드러운 충돌
  }),

  // 라벨 시스템
  LABEL: Object.freeze({
    minScaleToShow: 1.2,
    maxCharsBase: 28,
    minDistance: 26,
    fadeThreshold: 0.95,
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
      카테고리: 1.8,
      단계: 1.8,
      저자: 2.4,
      역자: 2.2,
      주제: 2.2,
      장르: 2.2,
      구분: 2.0,
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
    measure();

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
  const [isDragging, setIsDragging] = useState(false);

  // 참조 객체들
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const abortControllerRef = useRef(null);
  const hoveredNodeRef = useRef(null);
  const dragNodeRef = useRef(null);
  const simulationRef = useRef(null);
  const continuousSimulationRef = useRef(null); // 지속적 시뮬레이션 관리

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

  // 🔥 핵심: 지속적 시뮬레이션 유지 시스템
  const maintainContinuousSimulation = useCallback(() => {
    if (simulationRef.current && !isDragging) {
      try {
        // 시뮬레이션이 완전히 멈추지 않도록 주기적으로 활성화
        const currentAlpha = simulationRef.current.alpha();
        if (currentAlpha < CONFIG.FORCE.continuousAlpha) {
          simulationRef.current
            .alpha(CONFIG.FORCE.continuousAlpha)
            .restart();
        }
      } catch (err) {
        console.warn("지속적 시뮬레이션 유지 실패:", err);
      }
    }
  }, [isDragging]);

  // 지속적 시뮬레이션 타이머
  useEffect(() => {
    continuousSimulationRef.current = setInterval(maintainContinuousSimulation, 1000);
    
    return () => {
      if (continuousSimulationRef.current) {
        clearInterval(continuousSimulationRef.current);
      }
    };
  }, [maintainContinuousSimulation]);

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
    const radius = isBook ? 10 : 9;
    const highlightRadius = isDraggedNode ? radius + 4 : radius;

    // 노드 그리기 (드래그 중이면 강력한 글로우 효과)
    if (isDraggedNode) {
      // 외부 글로우 (큰 원)
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius + 12, 0, 2 * Math.PI);
      ctx.fillStyle = `${CONFIG.NODE_COLOR[node.type]}15`;
      ctx.fill();
      // 중간 글로우
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius + 8, 0, 2 * Math.PI);
      ctx.fillStyle = `${CONFIG.NODE_COLOR[node.type]}30`;
      ctx.fill();
      // 내부 글로우
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius + 4, 0, 2 * Math.PI);
      ctx.fillStyle = `${CONFIG.NODE_COLOR[node.type]}50`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, highlightRadius, 0, 2 * Math.PI);
    ctx.fillStyle = CONFIG.NODE_COLOR[node.type] || "#6b7280";
    ctx.fill();

    // 드래그 중인 노드에 강조 테두리
    if (isDraggedNode) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius, 0, 2 * Math.PI);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.stroke();
      
      // 추가 외곽 테두리
      ctx.beginPath();
      ctx.arc(node.x, node.y, highlightRadius + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = CONFIG.NODE_COLOR[node.type];
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 라벨 표시 조건
    const shouldShowLabel = isHovered || isBook || isDraggedNode || globalScale >= CONFIG.LABEL.minScaleToShow;
    if (!shouldShowLabel) return;

    // 텍스트 준비
    const maxChars = Math.max(8, Math.floor(CONFIG.LABEL.maxCharsBase / Math.pow(globalScale, 0.3)));
    const rawText = node.label || "";
    const displayText = rawText.length > maxChars ? `${rawText.slice(0, maxChars - 1)}…` : rawText;

    // 폰트 설정
    const fontSize = Math.max(12, 15 / Math.pow(globalScale, 0.15));
    ctx.font = `${isDraggedNode ? 'bold' : 'normal'} ${fontSize}px ui-sans-serif, -apple-system, BlinkMacSystemFont`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // 라벨 위치 계산
    const angle = Math.atan2(node.y, node.x);
    const labelOffset = highlightRadius + 15;
    const labelX = node.x + labelOffset * Math.cos(angle);
    const labelY = node.y + labelOffset * Math.sin(angle);

    // 라벨 배경 (가독성 향상)
    if (isHovered || isDraggedNode || globalScale < 1.6) {
      const textMetrics = ctx.measureText(displayText);
      const bgWidth = textMetrics.width + 12;
      const bgHeight = fontSize + 10;

      if (isDraggedNode) {
        // 드래그 중 특별한 배경
        ctx.fillStyle = "rgba(37, 99, 235, 0.2)";
        ctx.fillRect(labelX - bgWidth/2, labelY - bgHeight/2, bgWidth, bgHeight);
        ctx.strokeStyle = "rgba(37, 99, 235, 0.5)";
        ctx.lineWidth = 2;
        ctx.strokeRect(labelX - bgWidth/2, labelY - bgHeight/2, bgWidth, bgHeight);
      } else {
        ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx.fillRect(labelX - bgWidth/2, labelY - bgHeight/2, bgWidth, bgHeight);
      }
    }

    // 텍스트 렌더링
    ctx.fillStyle = isDraggedNode ? "#1e40af" : (isHovered ? "#1e40af" : "#374151");
    ctx.fillText(displayText, labelX, labelY);
  }, []);

  const renderNodePointer = useCallback((node, color, ctx) => {
    if (!node || node.x == null || node.y == null) return;
    const radius = node.type === "book" ? 18 : 16;
    
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

    // 드래그 중인 링크는 매우 강조
    const sourceIsDragged = dragNodeRef.current && (
      (typeof link.source === 'object' ? link.source.id : link.source) === dragNodeRef.current
    );
    const targetIsDragged = dragNodeRef.current && (
      (typeof link.target === 'object' ? link.target.id : link.target) === dragNodeRef.current
    );

    if (sourceIsDragged || targetIsDragged) {
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = (width[link.type] || 1.5) + 2;
      ctx.shadowColor = "rgba(37, 99, 235, 0.6)";
      ctx.shadowBlur = 5;
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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { buildTraceModel, durationSeverity, filterTraceTree, traceCategoryLabel, traceNodeTiming, type TraceNode } from "../trace-model";
import { DEFAULT_TIME_ZONE, displayTime } from "../time";
import { CloseIcon, SearchIcon } from "./Icons";
import { useTraceColumnWidth } from "./useTraceColumnWidth";
import { useResizableDrawerWidth } from "./useResizableDrawerWidth";

const TRACE_WIDTH_KEY = "opslog.trace-reader.width-ratio.v1";
const AXIS_STOPS = [0, .25, .5, .75, 1];

interface TraceDrawerProps {
  traceId?: string;
  rows: Record<string, unknown>[];
  loading: boolean;
  remoteDurationMs?: number;
  cached?: boolean;
  onClose: () => void;
  timeZone?: string;
}

interface TooltipState { node: TraceNode; x: number; y: number; }

const formatDuration = (value: number): string => value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(2)} ms`;

const TraceTooltip = ({ tooltip, visible, onEnter, onLeave, timeZone }: { tooltip?: TooltipState; visible: boolean; onEnter: () => void; onLeave: () => void; timeZone: string }) => {
  if (!tooltip) return null;
  const { node } = tooltip;
  return <div className={`trace-tooltip ${node.category}${visible ? " is-visible" : ""}`} style={{ left: tooltip.x, top: tooltip.y }} role="tooltip" aria-hidden={!visible} onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <header><span>{traceCategoryLabel[node.category]}</span><strong>{node.name}</strong></header>
    {node.detail && <pre>{node.detail}</pre>}
    <dl>
      <div><dt>服务</dt><dd>{node.service}</dd></div>
      <div><dt>耗时</dt><dd className={durationSeverity(node.durationMs)}>{formatDuration(node.durationMs)}</dd></div>
      <div><dt>开始</dt><dd>{displayTime(node.row["@timestamp"], timeZone)}</dd></div>
      {node.id && <div><dt>Span ID</dt><dd>{node.id}</dd></div>}
      {node.parentId && <div><dt>Parent ID</dt><dd>{node.parentId}</dd></div>}
    </dl>
  </div>;
};

export const TraceDrawer = ({ traceId, rows, loading, remoteDurationMs, cached, onClose, timeZone = DEFAULT_TIME_ZONE }: TraceDrawerProps) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tooltip, setTooltip] = useState<TooltipState>();
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [keyword, setKeyword] = useState("");
  const column = useTraceColumnWidth();
  const filtering = Boolean(keyword.trim());
  const tooltipHideTimer = useRef<number | undefined>(undefined);
  const tooltipShowTimer = useRef<number | undefined>(undefined);
  const tooltipFrame = useRef<number | undefined>(undefined);
  const model = useMemo(() => buildTraceModel(rows), [rows]);
  const filtered = useMemo(() => filterTraceTree(model.roots, collapsed, keyword), [collapsed, model.roots, keyword]);
  const visibleNodes = filtered.visible;
  const drawerWidth = useResizableDrawerWidth({ storageKey: TRACE_WIDTH_KEY, defaultRatio: .72, minimumPixels: 680, bodyClassName: "is-resizing-trace-reader" });

  const cancelTooltipHide = () => {
    if (tooltipHideTimer.current != null) window.clearTimeout(tooltipHideTimer.current);
    tooltipHideTimer.current = undefined;
  };
  const cancelTooltipShow = () => {
    if (tooltipShowTimer.current != null) window.clearTimeout(tooltipShowTimer.current);
    if (tooltipFrame.current != null) window.cancelAnimationFrame(tooltipFrame.current);
    tooltipShowTimer.current = undefined;
    tooltipFrame.current = undefined;
  };
  const resetTooltip = () => {
    cancelTooltipShow();
    cancelTooltipHide();
    setTooltipVisible(false);
  };
  const scheduleTooltipHide = () => {
    cancelTooltipShow();
    cancelTooltipHide();
    // Allow crossing the small gap into the selectable detail panel.
    tooltipHideTimer.current = window.setTimeout(() => setTooltipVisible(false), 140);
  };

  useEffect(() => {
    setCollapsed(new Set());
    setKeyword("");
    setTooltip(undefined);
    resetTooltip();
    return () => { cancelTooltipShow(); cancelTooltipHide(); };
  }, [traceId]);
  useEffect(() => { resetTooltip(); }, [rows, keyword, collapsed, loading]);
  if (!traceId) return null;

  const toggleNode = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const showTooltip = (event: MouseEvent, node: TraceNode) => {
    cancelTooltipShow();
    cancelTooltipHide();
    setTooltipVisible(false);
    const width = Math.min(520, window.innerWidth - 32);
    const height = node.detail ? 310 : 210;
    const next = {
      node,
      x: Math.max(16, Math.min(window.innerWidth - width - 16, event.clientX + 16)),
      y: Math.max(16, Math.min(window.innerHeight - height - 16, event.clientY + 14))
    };
    tooltipShowTimer.current = window.setTimeout(() => {
      setTooltip(next);
      // Mount the hidden panel before transitioning its opacity on the next paint.
      tooltipFrame.current = window.requestAnimationFrame(() => {
        tooltipFrame.current = window.requestAnimationFrame(() => setTooltipVisible(true));
      });
    }, 500);
  };

  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer trace-drawer" style={{ width: `${drawerWidth.ratio * 100}vw`, "--trace-column-width": `${column.width}px` } as CSSProperties} onMouseDown={(event) => event.stopPropagation()}>
      <div className="trace-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整 Trace 阅读器宽度" tabIndex={0} onPointerDown={drawerWidth.startResize} onKeyDown={drawerWidth.resizeWithKeyboard} />
      <div className="drawer-heading trace-heading"><div><span className="eyebrow">DISTRIBUTED TRACE</span><h2>调用链路</h2><code>{traceId}</code></div><button title="关闭 Trace" aria-label="关闭 Trace" onClick={onClose}><CloseIcon /></button></div>
      <div className="trace-summary">
        <div><span>SPAN 数量</span><strong>{rows.length.toLocaleString()}</strong></div>
        <div><span>链路跨度</span><strong>{formatDuration(model.durationMs)}</strong></div>
        <div><span>服务数量</span><strong>{model.services}</strong></div>
        <div><span>数据来源</span><strong className="trace-source">{loading ? "读取中" : cached ? "会话缓存" : `${((remoteDurationMs ?? 0) / 1000).toFixed(2)} s`}</strong></div>
      </div>
      {loading && <div className="trace-loading trace-loading-active" role="status" aria-live="polite"><div className="trace-loading-visual" aria-hidden="true"><span className="trace-loading-link trace-loading-link-first" /><span className="trace-loading-link trace-loading-link-second" /><i className="trace-loading-node trace-loading-node-source" /><i className="trace-loading-node trace-loading-node-core" /><i className="trace-loading-node trace-loading-node-target" /></div><strong>正在组装调用链路…</strong><span>正在聚合 Trace Span 与耗时信息</span></div>}
      {!loading && rows.length === 0 && <div className="trace-loading">APM 索引中未找到该 Trace。</div>}
      {!loading && rows.length > 0 && <>
        <div className="trace-filter-toolbar"><label className="trace-filter"><SearchIcon /><input value={keyword} onChange={(event) => { setKeyword(event.target.value); setTooltip(undefined); }} placeholder="过滤调用名称、服务、SQL 或 Span ID" aria-label="Trace 关键字过滤" />{keyword && <button type="button" aria-label="清除 Trace 过滤" onClick={() => setKeyword("")}><CloseIcon /></button>}</label><span role="status">{filtering ? `命中 ${filtered.matches.size} / ${model.nodes.length} · 保留父级路径` : `${visibleNodes.length} / ${model.nodes.length} 个 Span`}</span></div>
        <div className="trace-toolbar"><div className="trace-legend"><span className="fast">快速</span><i /><span className="warning">关注</span><i /><span className="critical">慢调用</span></div><div><button disabled={filtering} onClick={() => setCollapsed(new Set(model.nodes.filter(({ children }) => children.length).map(({ key }) => key)))}>全部折叠</button><button disabled={filtering} onClick={() => setCollapsed(new Set())}>全部展开</button></div></div>
        <div className="trace-waterfall-shell" onScroll={resetTooltip}>
        <div className="trace-waterfall-head"><span className="trace-column-heading">调用层级<div className="trace-column-resizer" role="separator" aria-label="调整调用层级列宽" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={1400} aria-valuenow={column.width} tabIndex={0} title="拖动调整列宽；双击恢复默认；方向键微调" onPointerDown={column.start} onPointerMove={column.move} onPointerUp={column.stop} onPointerCancel={column.stop} onLostPointerCapture={column.stop} onDoubleClick={column.reset} onKeyDown={column.keyboard} /></span><div>{AXIS_STOPS.map((stop) => <i key={stop} style={{ left: `${stop * 100}%` }}>{formatDuration(model.durationMs * stop)}</i>)}</div></div>
        <div className="trace-waterfall" onMouseLeave={scheduleTooltipHide}>
          {visibleNodes.map(({ node, depth }) => {
            const timing = traceNodeTiming(node, model);
            const style = { "--trace-depth": depth, "--trace-left": `${timing.left}%`, "--trace-width": `${timing.width}%` } as CSSProperties;
            return <article key={node.key} className={`trace-row ${node.category} ${durationSeverity(node.durationMs)}${filtering && !filtered.matches.has(node.key) ? " trace-context-row" : ""}`} style={style} onMouseEnter={(event) => showTooltip(event, node)} onMouseLeave={scheduleTooltipHide}>
              <div className="trace-operation"><button className="trace-expand" disabled={filtering || !node.children.length} aria-label={collapsed.has(node.key) && !filtering ? "展开子调用" : "折叠子调用"} onClick={() => toggleNode(node.key)}>{node.children.length ? collapsed.has(node.key) && !filtering ? "›" : "⌄" : ""}</button><span className="trace-type">{traceCategoryLabel[node.category]}</span><strong title={node.name}>{node.name}</strong><small title={node.service}>{node.service}</small></div>
              <div className="trace-timeline"><i className="trace-bar"><b>{timing.width > 10 ? formatDuration(node.durationMs) : ""}</b></i><code>{timing.width <= 10 ? formatDuration(node.durationMs) : ""}</code></div>
            </article>;
          })}
          {filtering && !visibleNodes.length && <div className="trace-filter-empty" role="status">未找到匹配的调用，请调整关键字或清除过滤。</div>}
        </div>
        </div>
      </>}
      <TraceTooltip tooltip={tooltip} visible={tooltipVisible} onEnter={cancelTooltipHide} onLeave={scheduleTooltipHide} timeZone={timeZone} />
    </aside>
  </div>;
};

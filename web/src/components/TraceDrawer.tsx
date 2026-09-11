import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { buildTraceModel, durationSeverity, flattenTraceTree, traceCategoryLabel, traceNodeTiming, type TraceNode } from "../trace-model";
import { displayNairobiTime } from "../time";
import { CloseIcon } from "./Icons";
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
}

interface TooltipState { node: TraceNode; x: number; y: number; }

const formatDuration = (value: number): string => value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(2)} ms`;

const TraceTooltip = ({ tooltip, onEnter, onLeave }: { tooltip?: TooltipState; onEnter: () => void; onLeave: () => void }) => {
  if (!tooltip) return null;
  const { node } = tooltip;
  return <div className={`trace-tooltip ${node.category}`} style={{ left: tooltip.x, top: tooltip.y }} role="tooltip" onMouseEnter={onEnter} onMouseLeave={onLeave}>
    <header><span>{traceCategoryLabel[node.category]}</span><strong>{node.name}</strong></header>
    {node.detail && <pre>{node.detail}</pre>}
    <dl>
      <div><dt>服务</dt><dd>{node.service}</dd></div>
      <div><dt>耗时</dt><dd className={durationSeverity(node.durationMs)}>{formatDuration(node.durationMs)}</dd></div>
      <div><dt>开始</dt><dd>{displayNairobiTime(node.row["@timestamp"])}</dd></div>
      {node.id && <div><dt>Span ID</dt><dd>{node.id}</dd></div>}
      {node.parentId && <div><dt>Parent ID</dt><dd>{node.parentId}</dd></div>}
    </dl>
  </div>;
};

export const TraceDrawer = ({ traceId, rows, loading, remoteDurationMs, cached, onClose }: TraceDrawerProps) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [tooltip, setTooltip] = useState<TooltipState>();
  const tooltipHideTimer = useRef<number | undefined>(undefined);
  const model = useMemo(() => buildTraceModel(rows), [rows]);
  const visibleNodes = useMemo(() => flattenTraceTree(model.roots, collapsed), [collapsed, model.roots]);
  const drawerWidth = useResizableDrawerWidth({ storageKey: TRACE_WIDTH_KEY, defaultRatio: .72, minimumPixels: 680, bodyClassName: "is-resizing-trace-reader" });

  const cancelTooltipHide = () => {
    if (tooltipHideTimer.current != null) window.clearTimeout(tooltipHideTimer.current);
    tooltipHideTimer.current = undefined;
  };
  const scheduleTooltipHide = () => {
    cancelTooltipHide();
    tooltipHideTimer.current = window.setTimeout(() => setTooltip(undefined), 140);
  };

  useEffect(() => {
    setCollapsed(new Set());
    setTooltip(undefined);
    return cancelTooltipHide;
  }, [traceId]);
  if (!traceId) return null;

  const toggleNode = (key: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const showTooltip = (event: MouseEvent, node: TraceNode) => {
    cancelTooltipHide();
    const width = Math.min(520, window.innerWidth - 32);
    const height = node.detail ? 310 : 210;
    setTooltip({
      node,
      x: Math.max(16, Math.min(window.innerWidth - width - 16, event.clientX + 16)),
      y: Math.max(16, Math.min(window.innerHeight - height - 16, event.clientY + 14))
    });
  };

  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer trace-drawer" style={{ width: `${drawerWidth.ratio * 100}vw` }} onMouseDown={(event) => event.stopPropagation()}>
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
        <div className="trace-toolbar"><div className="trace-legend"><span className="fast">快速</span><i /><span className="warning">关注</span><i /><span className="critical">慢调用</span></div><div><button onClick={() => setCollapsed(new Set(model.nodes.filter(({ children }) => children.length).map(({ key }) => key)))}>全部折叠</button><button onClick={() => setCollapsed(new Set())}>全部展开</button></div></div>
        <div className="trace-waterfall-head"><span>调用层级</span><div>{AXIS_STOPS.map((stop) => <i key={stop} style={{ left: `${stop * 100}%` }}>{formatDuration(model.durationMs * stop)}</i>)}</div></div>
        <div className="trace-waterfall" onMouseLeave={scheduleTooltipHide}>
          {visibleNodes.map(({ node, depth }) => {
            const timing = traceNodeTiming(node, model);
            const style = { "--trace-depth": depth, "--trace-left": `${timing.left}%`, "--trace-width": `${timing.width}%` } as CSSProperties;
            return <article key={node.key} className={`trace-row ${node.category} ${durationSeverity(node.durationMs)}`} style={style} onMouseEnter={(event) => showTooltip(event, node)}>
              <div className="trace-operation"><button className="trace-expand" disabled={!node.children.length} aria-label={collapsed.has(node.key) ? "展开子调用" : "折叠子调用"} onClick={() => toggleNode(node.key)}>{node.children.length ? collapsed.has(node.key) ? "›" : "⌄" : ""}</button><span className="trace-type">{traceCategoryLabel[node.category]}</span><strong>{node.name}</strong><small>{node.service}</small></div>
              <div className="trace-timeline"><i className="trace-bar"><b>{timing.width > 10 ? formatDuration(node.durationMs) : ""}</b></i><code>{timing.width <= 10 ? formatDuration(node.durationMs) : ""}</code></div>
            </article>;
          })}
        </div>
      </>}
      <TraceTooltip tooltip={tooltip} onEnter={cancelTooltipHide} onLeave={scheduleTooltipHide} />
    </aside>
  </div>;
};

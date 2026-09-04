import { displayNairobiTime } from "../time";
import { CloseIcon } from "./Icons";

const field = (row: Record<string, unknown>, ...names: string[]): string => {
  for (const name of names) if (row[name] != null) return String(row[name]);
  return "—";
};

const duration = (row: Record<string, unknown>): number => {
  const raw = row["event.duration"] ?? row["span.duration.us"] ?? row["transaction.duration.us"] ?? 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return row["event.duration"] != null ? value / 1_000_000 : value / 1000;
};

const classify = (row: Record<string, unknown>): string => {
  const type = field(row, "span.type", "processor.event", "transaction.type").toLowerCase();
  const name = field(row, "span.name", "transaction.name").toLowerCase();
  if (type.includes("db") || name.includes("sql")) return "db";
  if (type.includes("http") || name.includes("http")) return "http";
  if (type.includes("redis")) return "redis";
  if (type.includes("external") || type.includes("rpc")) return "rpc";
  return "transaction";
};

export const TraceDrawer = ({ traceId, rows, loading, onClose }: { traceId?: string; rows: Record<string, unknown>[]; loading: boolean; onClose: () => void }) => {
  if (!traceId) return null;
  const maximum = Math.max(...rows.map(duration), 1);
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer trace-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <div className="drawer-heading"><div><span className="eyebrow">DISTRIBUTED TRACE</span><h2>调用链路</h2><code>{traceId}</code></div><button onClick={onClose}><CloseIcon /></button></div>
      <div className="trace-summary"><div><span>SPAN 数量</span><strong>{rows.length}</strong></div><div><span>最长耗时</span><strong>{maximum.toFixed(2)} ms</strong></div></div>
      {loading && <div className="trace-loading trace-loading-active" role="status" aria-live="polite">
        <div className="trace-loading-visual" aria-hidden="true">
          <span className="trace-loading-link trace-loading-link-first" /><span className="trace-loading-link trace-loading-link-second" />
          <i className="trace-loading-node trace-loading-node-source" /><i className="trace-loading-node trace-loading-node-core" /><i className="trace-loading-node trace-loading-node-target" />
        </div>
        <strong>正在组装调用链路…</strong>
        <span>正在聚合 Trace Span 与耗时信息</span>
      </div>}
      {!loading && rows.length === 0 && <div className="trace-loading">APM 索引中未找到该 Trace。</div>}
      <div className="trace-list">
        {rows.map((row, index) => {
          const ms = duration(row);
          const name = field(row, "span.name", "transaction.name", "name");
          return <article key={`${field(row, "span.id", "transaction.id")}-${index}`} className={`trace-item ${classify(row)}`}>
            <div className="trace-node"><i /></div>
            <div className="trace-content">
              <div><strong>{name}</strong><span>{field(row, "service.name", "service.node.name")}</span></div>
              <div className="duration-track"><i style={{ width: `${Math.max(2, (ms / maximum) * 100)}%` }} /></div>
              <footer><span>{displayNairobiTime(row["@timestamp"])}</span><code>{ms.toFixed(2)} ms</code></footer>
            </div>
          </article>;
        })}
      </div>
    </aside>
  </div>;
};

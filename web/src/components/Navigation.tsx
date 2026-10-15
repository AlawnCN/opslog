import { DEFAULT_TIME_ZONE, timeZoneOffsetLabel, timeZoneTitle } from "../time";
import type { Environment, LogKind } from "../types";

const items: Array<{ kind: LogKind; code: string; title: string; detail: string }> = [
  { kind: "transaction", code: "TXN", title: "交易日志", detail: "交易流水与调用轨迹" },
  { kind: "application", code: "APP", title: "应用服务日志", detail: "应用运行与异常信息" },
  { kind: "ecp", code: "ECP", title: "ECP 服务日志", detail: "平台服务与文件日志" },
  { kind: "generic", code: "ANY", title: "通用日志", detail: "已配置索引自由检索" }
];

export const Navigation = ({ active, onChange, environment, collapsed = false, onToggle }: { active: LogKind; onChange: (kind: LogKind) => void; environment?: Environment; collapsed?: boolean; onToggle?: () => void }) => {
  const timeZone = environment?.timeZone || DEFAULT_TIME_ZONE;
  const offsetLabel = environment && environment.sourceType !== "elk" && environment.timeZoneOffset
    ? `UTC ${environment.timeZoneOffset}`
    : timeZoneOffsetLabel(timeZone);
  return (
  <aside className={`sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="日志导航">
    <div className="sidebar-content">
    <div className="nav-caption">LOG DOMAINS</div>
    <nav id="log-domain-navigation" aria-label="日志页面">
      {items.map((item) => (
        <button type="button" key={item.kind} className={active === item.kind ? "active" : ""} aria-label={`${item.code} ${item.title}`} aria-current={active === item.kind ? "page" : undefined} title={item.title} onClick={() => onChange(item.kind)}>
          <span className="nav-code">{item.code}</span>
          <span className="nav-label"><strong>{item.title}</strong><small>{item.kind === "generic" && environment && environment.sourceType !== "elk" ? "已配置日志源自由检索" : item.detail}</small></span>
        </button>
      ))}
    </nav>
    <div className="timezone-card">
      <div className="timezone-compact" title={`${timeZone} · ${offsetLabel}`}><span>UTC</span><strong>{offsetLabel.replace(/^UTC\s*/, "")}</strong></div>
      <span>TIME REFERENCE</span>
      <strong>{timeZoneTitle(timeZone)}</strong>
      <small>{offsetLabel}{environment?.timeZoneSource === "ssh" ? " · SSH" : ""}</small>
    </div>
    </div>
    {onToggle && <button type="button" className="sidebar-toggle" aria-label={collapsed ? "展开导航" : "折叠导航"} title={collapsed ? "展开导航" : "折叠导航"} aria-expanded={!collapsed} aria-controls="log-domain-navigation" onClick={onToggle}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={collapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"} /></svg></button>}
  </aside>
  );
};

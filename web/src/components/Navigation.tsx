import { DEFAULT_TIME_ZONE, timeZoneOffsetLabel, timeZoneTitle } from "../time";
import type { Environment, LogKind } from "../types";

const items: Array<{ kind: LogKind; code: string; title: string; detail: string }> = [
  { kind: "transaction", code: "TXN", title: "交易日志", detail: "交易流水与调用轨迹" },
  { kind: "application", code: "APP", title: "应用服务日志", detail: "应用运行与异常信息" },
  { kind: "ecp", code: "ECP", title: "ECP 服务日志", detail: "平台服务与文件日志" },
  { kind: "generic", code: "ANY", title: "通用日志", detail: "已配置索引自由检索" }
];

export const Navigation = ({ active, onChange, environment }: { active: LogKind; onChange: (kind: LogKind) => void; environment?: Environment }) => {
  const timeZone = environment?.timeZone || DEFAULT_TIME_ZONE;
  const offsetLabel = environment?.sourceType === "ssh" && environment.timeZoneOffset
    ? `UTC ${environment.timeZoneOffset}`
    : timeZoneOffsetLabel(timeZone);
  return (
  <aside className="sidebar">
    <div className="nav-caption">LOG DOMAINS</div>
    <nav>
      {items.map((item) => (
        <button key={item.kind} className={active === item.kind ? "active" : ""} onClick={() => onChange(item.kind)}>
          <span className="nav-code">{item.code}</span>
          <span><strong>{item.title}</strong><small>{item.detail}</small></span>
        </button>
      ))}
    </nav>
    <div className="timezone-card">
      <span>TIME REFERENCE</span>
      <strong>{timeZoneTitle(timeZone)}</strong>
      <small>{offsetLabel}{environment?.timeZoneSource === "ssh" ? " · SSH" : ""}</small>
    </div>
  </aside>
  );
};

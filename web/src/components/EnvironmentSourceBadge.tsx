import type { EnvironmentSource } from "../types";

export const EnvironmentSourceBadge = ({ source, compact = false, trigger = false }: { source: EnvironmentSource; compact?: boolean; trigger?: boolean }) => <span className={`environment-source-badge is-${source}${compact ? " is-compact" : ""}${trigger ? " is-trigger" : ""}`} title={source === "local" ? "Local 本地日志源" : source === "ssh" ? "SSH 日志源" : "ELK 日志源"}>
  {source === "local" ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2.5" /><path d="M8 21h8m-4-4v4M7 8h4l1.5 2H17v4H7Z" /></svg> : source === "ssh"
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="m7 9 3 3-3 3M12.5 15h4" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2" /><circle cx="17.5" cy="6" r="2" /><circle cx="12" cy="17" r="2" /><path d="m7.8 7 7.7-.8M7.2 8.7l3.7 6.6M16.5 7.8l-3.4 7.4" /></svg>}
  <span className="sr-only">{source === "local" ? "Local 本地日志源" : source === "ssh" ? "SSH 日志源" : "ELK 日志源"}</span>
</span>;

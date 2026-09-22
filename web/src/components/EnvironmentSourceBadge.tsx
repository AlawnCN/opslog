import type { EnvironmentSource } from "../types";

export const EnvironmentSourceBadge = ({ source, compact = false, trigger = false }: { source: EnvironmentSource; compact?: boolean; trigger?: boolean }) => <span className={`environment-source-badge is-${source}${compact ? " is-compact" : ""}${trigger ? " is-trigger" : ""}`} title={source === "ssh" ? "SSH 日志源" : "ELK 日志源"}>
  {source === "ssh"
    ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="m7 9 3 3-3 3M12.5 15h4" /></svg>
    : <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2" /><circle cx="17.5" cy="6" r="2" /><circle cx="12" cy="17" r="2" /><path d="m7.8 7 7.7-.8M7.2 8.7l3.7 6.6M16.5 7.8l-3.4 7.4" /></svg>}
  <span className="sr-only">{source === "ssh" ? "SSH 日志源" : "ELK 日志源"}</span>
</span>;

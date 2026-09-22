import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { Environment } from "../types";
import { EnvironmentSourceBadge } from "./EnvironmentSourceBadge";

const summary = (environment: Environment): string => environment.sourceType === "ssh"
  ? `${environment.sshApplications.length} 个监控应用 · ${environment.timeZone}`
  : `${environment.kibanaUrl.replace(/^https?:\/\//, "").split("/")[0] || "未配置网关"} · ${environment.timeZone}`;
const searchable = (value: string): string => value.toLocaleLowerCase().replace(/[\s_/-]+/g, "");

export const EnvironmentPicker = ({ environments, value, onChange, disabled = false }: { environments: Environment[]; value: string; onChange: (value: string) => void; disabled?: boolean }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [style, setStyle] = useState<CSSProperties>();
  const hostRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selected = environments.find((item) => item.name === value);
  const filtered = useMemo(() => {
    const term = searchable(query);
    return term ? environments.filter((item) => searchable(`${item.name} ${item.sourceType} ${summary(item)}`).includes(term)) : environments;
  }, [environments, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node) && !panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(620, window.innerWidth - 24);
      setStyle({ position: "fixed", top: rect.bottom + 7, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), width, maxHeight: Math.min(520, window.innerHeight - rect.bottom - 18) });
    };
    place();
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  return <div ref={hostRef} className={`environment-picker${open ? " is-open" : ""}`}>
    <button ref={triggerRef} type="button" aria-haspopup="dialog" aria-expanded={open} disabled={disabled || !environments.length} onClick={() => setOpen((current) => !current)}>
      {selected && <EnvironmentSourceBadge source={selected.sourceType} trigger />}<span className="environment-picker-name">{selected?.name ?? "选择运行环境"}</span><i aria-hidden="true" />
    </button>
    {open && style && createPortal(<div ref={panelRef} className="environment-picker-panel" style={style} role="dialog" aria-label="选择运行环境">
      <div className="environment-picker-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input autoFocus value={query} placeholder="搜索环境名称、来源或地址" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} /></div>
      <div className="environment-picker-grid">{filtered.map((item) => <button type="button" className={item.name === value ? "is-selected" : undefined} key={item.name} onClick={() => { onChange(item.name); setOpen(false); setQuery(""); }}><EnvironmentSourceBadge source={item.sourceType} /><span className="environment-picker-copy"><strong>{item.name}</strong><small>{item.sourceType.toUpperCase()} · {summary(item)}</small></span>{item.name === value && <i>当前</i>}</button>)}{!filtered.length && <p>没有匹配的运行环境</p>}</div>
      <footer><span>共 {filtered.length} 个环境</span><small>环境顺序与配置页保持一致</small></footer>
    </div>, document.body)}
  </div>;
};

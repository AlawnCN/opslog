import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export interface SearchableSelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SearchableSelectProps {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  searchPlaceholder?: string;
}

const searchable = (value: string): string => value.toLocaleLowerCase().replace(/[\s_/-]+/g, "");

export const SearchableSelect = ({ value, options, onChange, ariaLabel, placeholder = "请选择", searchPlaceholder = "搜索…" }: SearchableSelectProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const hostRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const term = searchable(query);
    return term ? options.filter((option) => searchable(`${option.label} ${option.value} ${option.description ?? ""}`).includes(term)) : options;
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(320, rect.width), window.innerWidth - 16);
      const maxHeight = Math.min(360, Math.max(180, window.innerHeight - rect.bottom - 16));
      setMenuStyle({ position: "fixed", left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 5, width, maxHeight });
    };
    place();
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const choose = (nextValue: string) => { onChange(nextValue); setOpen(false); setQuery(""); };
  return <div ref={hostRef} className={`searchable-select${open ? " is-open" : ""}`}>
    <button ref={buttonRef} type="button" role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((current) => !current)}>
      <span className={selected ? undefined : "is-placeholder"}>{selected?.label ?? (value || placeholder)}</span><i aria-hidden="true" />
    </button>
    {open && menuStyle && createPortal(<div ref={menuRef} id={listId} className="searchable-select-menu" style={menuStyle}>
      <div className="searchable-select-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input ref={searchRef} value={query} aria-label={`搜索${ariaLabel}`} placeholder={searchPlaceholder} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); if (event.key === "Enter" && filtered[0]) choose(filtered[0].value); }} /></div>
      <div role="listbox" aria-label={ariaLabel}>{filtered.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "is-selected" : undefined} key={option.value} onClick={() => choose(option.value)}><span>{option.label}</span>{option.description && <small>{option.description}</small>}</button>)}{!filtered.length && <p>没有匹配项</p>}</div>
    </div>, document.body)}
  </div>;
};

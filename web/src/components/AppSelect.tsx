import React, { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface AppSelectOption {
  value: string;
  label: string;
  description?: string;
}

interface AppSelectProps {
  value: string;
  options: AppSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  leadingIcon?: ReactNode;
  menuMinWidth?: number;
}

export const AppSelect = ({ value, options, onChange, placeholder = "请选择", ariaLabel, disabled = false, className = "", menuClassName = "", leadingIcon, menuMinWidth = 190 }: AppSelectProps) => {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const hostRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const place = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const computed = getComputedStyle(button);
      const desiredHeight = Math.min(260, options.length * 47 + 10);
      const below = window.innerHeight - rect.bottom - 10;
      const above = rect.top - 10;
      const openDown = below >= Math.min(desiredHeight, 150) || below >= above;
      const maxHeight = Math.max(88, Math.min(desiredHeight, openDown ? below : above));
      const width = Math.min(Math.max(menuMinWidth, rect.width), Math.max(0, window.innerWidth - 16));
      setMenuStyle({
        position: "fixed", left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width,
        top: openDown ? rect.bottom + 5 : Math.max(8, rect.top - maxHeight - 5), maxHeight,
        "--select-font-family": computed.fontFamily,
        "--select-font-size": `${Math.max(11, Math.min(20, Number.parseFloat(computed.fontSize)))}px`
      } as CSSProperties);
    };
    place();
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length, menuMinWidth]);

  const menuReady = menuStyle !== undefined;
  useEffect(() => {
    if (open) menuRef.current?.children.item(highlighted)?.scrollIntoView({ block: "nearest" });
  }, [open, highlighted, menuReady]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      return;
    }
    if (event.key === "Tab") { setOpen(false); return; }
    if (!options.length) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault(); setOpen(true); setHighlighted(event.key === "Home" ? 0 : options.length - 1); return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && highlighted >= 0) choose(highlighted);
      else { setHighlighted(selectedIndex >= 0 ? selectedIndex : 0); setOpen(true); }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    setOpen(true);
    setHighlighted((current) => {
      const start = current >= 0 ? current : selectedIndex >= 0 ? selectedIndex : direction > 0 ? -1 : 0;
      return (start + direction + options.length) % options.length;
    });
  };

  return <div ref={hostRef} className={`app-select${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
    <button ref={buttonRef} type="button" role="combobox" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && highlighted >= 0 ? `${listId}-${highlighted}` : undefined} disabled={disabled || !options.length} onClick={() => { setHighlighted(selectedIndex >= 0 ? selectedIndex : 0); setOpen((current) => !current); }} onKeyDown={onKeyDown}>
      {leadingIcon}<span className={selected ? undefined : "is-placeholder"}>{selected?.label ?? placeholder}</span><i aria-hidden="true" />
    </button>
    {open && menuStyle && createPortal(<div ref={menuRef} id={listId} className={`app-select-menu${menuClassName ? ` ${menuClassName}` : ""}`} role="listbox" aria-label={ariaLabel} style={menuStyle}>
      {options.map((option, index) => <button id={`${listId}-${index}`} tabIndex={-1} type="button" role="option" aria-selected={option.value === value} className={`${option.value === value ? "is-selected" : ""}${index === highlighted ? " is-highlighted" : ""}`} key={option.value} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.description && <small>{option.description}</small>}
      </button>)}
    </div>, document.body)}
  </div>;
};

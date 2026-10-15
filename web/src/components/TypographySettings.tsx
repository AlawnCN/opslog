import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { defaultTypography, FONT_CATEGORIES, FONT_OPTIONS, fontFamily, readTypography, saveTypography, validCustomFont, type FontCategory } from "../typography-preferences";
import { AppSelect } from "./AppSelect";
import { CloseIcon } from "./Icons";

const FontSizeInput = ({ size, maximum, label, onChange }: { size: number; maximum: number; label: string; onChange: (size: number) => void }) => {
  const [text, setText] = useState(String(size));
  useEffect(() => setText(String(size)), [size]);
  return <input type="number" aria-label={label} min={10} max={maximum} value={text} onChange={event => {
    setText(event.target.value);
    const next = event.target.valueAsNumber;
    if (Number.isFinite(next) && next >= 10 && next <= maximum) onChange(next);
  }} onBlur={() => {
    const next = text.trim() ? Number(text) : size;
    const normalized = Math.round(Math.max(10, Math.min(maximum, Number.isFinite(next) ? next : size)));
    setText(String(normalized)); onChange(normalized);
  }} />;
};

const TypographyDialog = ({ onClose }: { onClose: () => void }) => {
  const [draft, setDraft] = useState(readTypography);
  const [active, setActive] = useState<FontCategory>("ui");
  const dialogRef = useRef<HTMLElement>(null);
  const category = FONT_CATEGORIES.find(item => item.id === active)!;
  const value = draft[active];
  const size = value.size ?? category.base;
  const setSize = (next: number) => setDraft(current => ({ ...current, [active]: { ...current[active], size: Math.max(10, Math.min(category.maximum, next)) } }));
  const invalid = FONT_CATEGORIES.some(({ id }) => draft[id].family === "custom" && !validCustomFont(draft[id].customFamily));
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopImmediatePropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? []);
      if (!items.length) return;
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); items.at(-1)!.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);
  const previewStyle: CSSProperties = { fontFamily: fontFamily(value, active), fontSize: size, lineHeight: 1.65 };
  return createPortal(<div className="typography-backdrop" onMouseDown={onClose}>
    <section className="typography-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label="字体设置" tabIndex={-1} onMouseDown={event => event.stopPropagation()}>
      <header><h2>字体设置</h2><button type="button" aria-label="关闭字体设置" title="关闭" onClick={onClose}><CloseIcon /></button></header>
      <div className="typography-workspace"><nav aria-label="字体类别">{FONT_CATEGORIES.map(item => <button type="button" key={item.id} title={item.description} aria-pressed={active === item.id} onClick={() => setActive(item.id)}><strong>{item.label}</strong></button>)}</nav>
        <div className="typography-detail"><div className="typography-section-heading"><h3>{category.label}</h3><button type="button" title={`重置${category.label}字体`} aria-label={`重置${category.label}字体`} onClick={() => setDraft(current => ({ ...current, [active]: defaultTypography()[active] }))}>重置</button></div>
          <label className="typography-field"><span>字体</span><AppSelect ariaLabel={`${category.label}字体`} value={value.family} options={[...FONT_OPTIONS]} onChange={family => setDraft(current => ({ ...current, [active]: { ...current[active], family: FONT_OPTIONS.find(item => item.value === family)!.value } }))} /></label>
          {value.family === "custom" && <label className="typography-field"><span title="使用系统已安装字体">字体名称</span><input aria-label="字体名称" value={value.customFamily} placeholder="Cascadia Code" maxLength={80} onChange={event => setDraft(current => ({ ...current, [active]: { ...current[active], customFamily: event.target.value } }))} /></label>}
          <label className="typography-field"><span>字号 {value.size === null && <small>默认</small>}</span><div className="typography-size"><button type="button" aria-label="减小字号" disabled={size <= 10} onClick={() => setSize(size - 1)}>−</button><FontSizeInput key={active} size={size} maximum={category.maximum} label={`${category.label}字号`} onChange={setSize} /><button type="button" aria-label="增大字号" disabled={size >= category.maximum} onClick={() => setSize(size + 1)}>+</button><span>px</span></div></label>
          <div className="typography-preview"><span>预览</span><div style={previewStyle}>{active === "log" ? <><div>INFO 2026-10-15 08:30:00</div><div>{'{ "logId": "TXN-001", "duration": 128 }'}</div><div>SELECT * FROM transactions;</div></> : active === "table" ? <><div>时间　　日志 ID　　耗时</div><div>08:30:00　TXN-001　128 ms</div></> : <><div>日志检索与链路分析</div><p>The quick brown fox jumps over the lazy dog.</p><div>Aa Bb Cc 0123456789</div></>}</div></div>
          {invalid && <p role="alert">字体名称无效</p>}
        </div>
      </div><footer><button type="button" className="typography-reset" title="重置所有类别的字体设置" onClick={() => setDraft(defaultTypography())}>全部重置</button><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={invalid} onClick={() => { saveTypography(draft); onClose(); }}>保存</button></footer>
    </section>
  </div>, document.body);
};

export const TypographySettings = () => {
  const [open, setOpen] = useState(false);
  return <><button className="typography-trigger" type="button" aria-label="字体设置" title="字体设置" onClick={() => setOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 19 6-14 6 14M5 14h8m4 5 3-8 3 8m-5-3h4" /></svg></button>{open && <TypographyDialog onClose={() => setOpen(false)} />}</>;
};

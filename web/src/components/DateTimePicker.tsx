import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface DateTimePickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const pad = (value: number) => String(value).padStart(2, "0");
const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const parseDateTime = (value: string): DateTimeParts => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match) {
    const [, year, month, day, hour, minute] = match.map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && hour <= 23 && minute <= 59) {
      return { year, month, day, hour, minute };
    }
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: now.getHours(), minute: now.getMinutes() };
};

const serializeDateTime = ({ year, month, day, hour, minute }: DateTimeParts) =>
  `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;

const displayDateTime = ({ year, month, day, hour, minute }: DateTimeParts) =>
  `${year}/${pad(month)}/${pad(day)}  ${pad(hour)}:${pad(minute)}`;

export function DateTimePicker({ label, value, onChange }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateTimeParts>(() => parseDateTime(value));
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const parsed = parseDateTime(value);
    return { year: parsed.year, month: parsed.month };
  });
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const positionPanel = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const width = 332;
    const panelHeight = panelRef.current?.offsetHeight || 390;
    const left = clamp(bounds.left, 8, Math.max(8, window.innerWidth - width - 8));
    const below = bounds.bottom + 8;
    const top = below + panelHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, bounds.top - panelHeight - 8);
    setPosition({ top, left });
  };

  useLayoutEffect(() => {
    if (!open) return;
    positionPanel();
    panelRef.current?.focus();
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const next = parseDateTime(value);
    setDraft(next);
    setVisibleMonth({ year: next.year, month: next.month });
    setOpen(true);
  };

  const moveMonth = (delta: number) => {
    const next = new Date(visibleMonth.year, visibleMonth.month - 1 + delta, 1);
    setVisibleMonth({ year: next.getFullYear(), month: next.getMonth() + 1 });
  };

  const firstDay = new Date(visibleMonth.year, visibleMonth.month - 1, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, index) =>
    new Date(visibleMonth.year, visibleMonth.month - 1, index - startOffset + 1)
  );

  const changeTime = (field: "hour" | "minute", text: string) => {
    const parsed = Number(text);
    setDraft((current) => ({ ...current, [field]: clamp(Number.isFinite(parsed) ? parsed : 0, 0, field === "hour" ? 23 : 59) }));
  };

  const apply = () => {
    onChange(serializeDateTime(draft));
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="filter-field date-time-field">
      <span>{label}</span>
      <button ref={triggerRef} type="button" className={`date-time-trigger${open ? " is-open" : ""}`} onClick={toggle} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label}，${displayDateTime(parseDateTime(value))}`}>
        <span>{displayDateTime(parseDateTime(value))}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/></svg>
      </button>
      {open && createPortal(
        <div ref={panelRef} className="date-time-popover" role="dialog" aria-label={label} tabIndex={-1} style={{ top: position.top, left: position.left }}>
          <div className="date-time-popover-header">
            <strong>{visibleMonth.year} 年 {visibleMonth.month} 月</strong>
            <div>
              <button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>
              <button type="button" aria-label="下个月" onClick={() => moveMonth(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>
            </div>
          </div>
          <div className="date-time-weekdays">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
          <div className="date-time-days">
            {days.map((date) => {
              const selected = date.getFullYear() === draft.year && date.getMonth() + 1 === draft.month && date.getDate() === draft.day;
              const outside = date.getMonth() + 1 !== visibleMonth.month;
              return <button key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`} type="button" className={`${selected ? "is-selected " : ""}${outside ? "is-outside" : ""}`} aria-label={`${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`} aria-pressed={selected} onClick={() => {
                setDraft((current) => ({ ...current, year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }));
                if (outside) setVisibleMonth({ year: date.getFullYear(), month: date.getMonth() + 1 });
              }}>{date.getDate()}</button>;
            })}
          </div>
          <div className="date-time-footer">
            <div className="date-time-clock"><span>时间</span><input type="number" min="0" max="23" value={pad(draft.hour)} onFocus={(event) => event.currentTarget.select()} onChange={(event) => changeTime("hour", event.target.value)} aria-label="小时"/><b>:</b><input type="number" min="0" max="59" value={pad(draft.minute)} onFocus={(event) => event.currentTarget.select()} onChange={(event) => changeTime("minute", event.target.value)} aria-label="分钟"/><span>24 小时制</span></div>
            <div className="date-time-actions"><button type="button" onClick={() => setOpen(false)}>取消</button><button type="button" className="confirm" onClick={apply}>确定</button></div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

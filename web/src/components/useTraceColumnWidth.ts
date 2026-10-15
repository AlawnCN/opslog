import { useRef, useState, type PointerEvent, type KeyboardEvent } from "react";

const KEY = "opslog.trace.operation-column-width.v1";
export const TRACE_COLUMN_DEFAULT = 460;
export const clampTraceColumnWidth = (width: number): number => Math.min(1400, Math.max(280, Math.round(width)));

export const useTraceColumnWidth = () => {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number.parseFloat(localStorage.getItem(KEY) ?? "");
      return Number.isFinite(saved) ? clampTraceColumnWidth(saved) : TRACE_COLUMN_DEFAULT;
    } catch { return TRACE_COLUMN_DEFAULT; }
  });
  const drag = useRef<{ id: number; x: number; width: number } | undefined>(undefined);
  const current = useRef(width);
  const update = (next: number) => { current.current = clampTraceColumnWidth(next); setWidth(current.current); };
  const save = () => { try { localStorage.setItem(KEY, String(current.current)); } catch { /* Optional persistence. */ } };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    drag.current = { id: event.pointerId, x: event.clientX, width: current.current };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.current.x) < 3) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    update(drag.current.width + event.clientX - drag.current.x);
  };
  const stop = () => { if (!drag.current) return; drag.current = undefined; save(); };
  const reset = () => { update(TRACE_COLUMN_DEFAULT); save(); };
  const fit = (next: number) => { update(next); save(); };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    update(event.key === "Home" ? 280 : event.key === "End" ? 1400 : current.current + (event.key === "ArrowLeft" ? -24 : 24)); save();
  };
  return { width, start, move, stop, reset, fit, keyboard };
};

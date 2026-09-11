import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

interface DrawerWidthOptions {
  storageKey: string;
  defaultRatio: number;
  minimumPixels: number;
  maximumRatio?: number;
  bodyClassName: string;
}

const clampRatio = (ratio: number, minimumPixels: number, maximumRatio: number): number => {
  const viewportWidth = typeof window === "undefined" ? 1600 : window.innerWidth;
  const minimum = Math.min(minimumPixels / viewportWidth, maximumRatio);
  return Math.min(maximumRatio, Math.max(minimum, ratio));
};

export const useResizableDrawerWidth = ({ storageKey, defaultRatio, minimumPixels, maximumRatio = .94, bodyClassName }: DrawerWidthOptions) => {
  const readRatio = () => {
    try {
      const saved = Number.parseFloat(localStorage.getItem(storageKey) ?? "");
      return clampRatio(Number.isFinite(saved) ? saved : defaultRatio, minimumPixels, maximumRatio);
    } catch { return defaultRatio; }
  };
  const [ratio, setRatio] = useState(readRatio);
  const [resizing, setResizing] = useState(false);
  const ratioRef = useRef(ratio);
  const startRef = useRef<{ pointerX: number; width: number } | undefined>(undefined);

  useEffect(() => { ratioRef.current = ratio; }, [ratio]);
  useEffect(() => {
    const constrain = () => setRatio((current) => clampRatio(current, minimumPixels, maximumRatio));
    window.addEventListener("resize", constrain);
    return () => window.removeEventListener("resize", constrain);
  }, [maximumRatio, minimumPixels]);
  useEffect(() => {
    if (!resizing) return;
    document.body.classList.add(bodyClassName);
    const move = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const next = clampRatio((start.width + start.pointerX - event.clientX) / window.innerWidth, minimumPixels, maximumRatio);
      ratioRef.current = next;
      setRatio(next);
    };
    const stop = () => {
      startRef.current = undefined;
      setResizing(false);
      try { localStorage.setItem(storageKey, String(ratioRef.current)); } catch { /* Persistence is optional. */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.classList.remove(bodyClassName);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [bodyClassName, maximumRatio, minimumPixels, resizing, storageKey]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    startRef.current = { pointerX: event.clientX, width: ratioRef.current * window.innerWidth };
    setResizing(true);
  };
  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const next = clampRatio((ratioRef.current * window.innerWidth + direction * 48) / window.innerWidth, minimumPixels, maximumRatio);
    ratioRef.current = next;
    setRatio(next);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* Keyboard resizing still works. */ }
  };
  return { ratio, startResize, resizeWithKeyboard };
};

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clampCustomMarkerWidthRatio } from "../custom-marker-layout";

interface CustomMarkerSectionResizeHandleProps {
  ratio: number;
  onChange: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}

interface ResizeStart {
  x: number;
  ratio: number;
  width: number;
}

export const CustomMarkerSectionResizeHandle = ({ ratio, onChange, onCommit }: CustomMarkerSectionResizeHandleProps) => {
  const startRef = useRef<ResizeStart | undefined>(undefined);
  const ratioRef = useRef(ratio);
  const [resizing, setResizing] = useState(false);
  ratioRef.current = ratio;

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const next = clampCustomMarkerWidthRatio(start.ratio + (start.x - event.clientX) / start.width);
      ratioRef.current = next;
      onChange(next);
    };
    const stop = () => {
      startRef.current = undefined;
      setResizing(false);
      onCommit(ratioRef.current);
    };
    document.body.classList.add("is-resizing-custom-marker-zone");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      document.body.classList.remove("is-resizing-custom-marker-zone");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [onChange, onCommit, resizing]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    event.preventDefault();
    startRef.current = { x: event.clientX, ratio, width };
    setResizing(true);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const next = clampCustomMarkerWidthRatio(ratio + direction * .03);
    onChange(next);
    onCommit(next);
  };

  return <div
    className={`custom-marker-section-resize${resizing ? " is-resizing" : ""}`}
    role="separator"
    aria-label="调整自定义标记区域宽度"
    aria-orientation="vertical"
    aria-valuemin={16}
    aria-valuemax={58}
    aria-valuenow={Math.round(ratio * 100)}
    tabIndex={0}
    title="左右拖动调整自定义标记区域宽度"
    onPointerDown={beginResize}
    onKeyDown={resizeWithKeyboard}
  ><i aria-hidden="true" /><span>自定义标记</span></div>;
};

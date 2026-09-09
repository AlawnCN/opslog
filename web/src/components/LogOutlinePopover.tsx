import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import {
  clampLogOutlineGeometry,
  defaultLogOutlineGeometry,
  moveLogOutlineGeometry,
  resizeLogOutlineGeometry,
  type LogOutlineGeometry,
  type LogOutlineResizeDirection
} from "../log-outline-geometry";
import type { LogHighlight, LogOutlineCategory, LogOutlineItem } from "../transaction-log-model";
import { CloseIcon } from "./Icons";
import { LogOutlineList } from "./LogOutlineList";

const CATEGORY_LABELS: Record<LogOutlineCategory, string> = {
  service: "微服务入口",
  call: "调用标记",
  sql: "SQL 语句",
  "failed-result": "失败线索",
  exception: "ERROR / 异常",
  structured: "结构块"
};

interface LogOutlinePopoverProps {
  category: LogOutlineCategory;
  items: LogOutlineItem[];
  content: string;
  highlights: LogHighlight[];
  wrapLines: boolean;
  boundsRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onJump: (position: number) => void;
  onWrapLinesChange: (wrapLines: boolean) => void;
  title?: string;
  eyebrow?: string;
  highlightMode?: "sql" | "all" | "none";
}

const OUTLINE_GEOMETRY_KEY = "opslog.transaction-log-outline.geometry.v1";
const RESIZE_DIRECTIONS: LogOutlineResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

interface OutlineInteraction {
  mode: "move" | "resize";
  direction?: LogOutlineResizeDirection;
  pointerX: number;
  pointerY: number;
  geometry: LogOutlineGeometry;
}

const readStoredGeometry = (): LogOutlineGeometry | undefined => {
  try {
    const parsed = JSON.parse(localStorage.getItem(OUTLINE_GEOMETRY_KEY) ?? "null") as Partial<LogOutlineGeometry> | null;
    if (!parsed || ![parsed.x, parsed.y, parsed.width, parsed.height].every(Number.isFinite)) return undefined;
    return parsed as LogOutlineGeometry;
  } catch {
    return undefined;
  }
};

const storeGeometry = (geometry: LogOutlineGeometry) => {
  try {
    localStorage.setItem(OUTLINE_GEOMETRY_KEY, JSON.stringify(geometry));
  } catch {
    // Moving and resizing remain available when local storage is disabled.
  }
};

export const LogOutlinePopover = ({
  category, items, content, highlights, wrapLines, boundsRef, onClose, onJump, onWrapLinesChange, title, eyebrow = "LOG OUTLINE", highlightMode
}: LogOutlinePopoverProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<LogOutlineGeometry>({ x: 8, y: 8, width: 380, height: 230 });
  const interactionRef = useRef<OutlineInteraction | undefined>(undefined);
  const [geometry, setGeometry] = useState(geometryRef.current);
  const [ready, setReady] = useState(false);
  const [interacting, setInteracting] = useState(false);

  const updateGeometry = (next: LogOutlineGeometry) => {
    geometryRef.current = next;
    setGeometry(next);
  };

  const measureBounds = () => {
    const bounds = boundsRef.current?.getBoundingClientRect();
    return bounds ? { width: bounds.width, height: bounds.height } : undefined;
  };

  useLayoutEffect(() => {
    const bounds = measureBounds();
    if (!bounds) return;
    updateGeometry(clampLogOutlineGeometry(readStoredGeometry() ?? defaultLogOutlineGeometry(bounds), bounds));
    setReady(true);
  }, [boundsRef]);

  useEffect(() => {
    const boundsElement = boundsRef.current;
    if (!boundsElement) return;
    const observer = new ResizeObserver(([entry]) => {
      const bounds = { width: entry.contentRect.width, height: entry.contentRect.height };
      updateGeometry(clampLogOutlineGeometry(geometryRef.current, bounds));
    });
    observer.observe(boundsElement);
    return () => observer.disconnect();
  }, [boundsRef]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || hostRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-log-outline-trigger], [data-custom-marker-id]")) return;
      onClose();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
    };
  }, [onClose]);

  useEffect(() => {
    if (!interacting) return;
    const interaction = interactionRef.current;
    const previousCursor = document.body.style.cursor;
    document.body.classList.add("is-adjusting-log-outline");
    document.body.style.cursor = interaction?.mode === "move" ? "grabbing" : `${interaction?.direction ?? "se"}-resize`;
    const move = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      const bounds = measureBounds();
      if (!interaction || !bounds) return;
      const deltaX = event.clientX - interaction.pointerX;
      const deltaY = event.clientY - interaction.pointerY;
      updateGeometry(interaction.mode === "move"
        ? moveLogOutlineGeometry(interaction.geometry, deltaX, deltaY, bounds)
        : resizeLogOutlineGeometry(interaction.geometry, interaction.direction ?? "se", deltaX, deltaY, bounds));
    };
    const stop = () => {
      storeGeometry(geometryRef.current);
      interactionRef.current = undefined;
      setInteracting(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      document.body.classList.remove("is-adjusting-log-outline");
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [interacting]);

  const beginInteraction = (
    event: ReactPointerEvent,
    mode: OutlineInteraction["mode"],
    direction?: LogOutlineResizeDirection
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = {
      mode,
      direction,
      pointerX: event.clientX,
      pointerY: event.clientY,
      geometry: geometryRef.current
    };
    setInteracting(true);
  };

  return <div
    className={`log-outline-popover${ready ? " is-ready" : ""}${interacting ? " is-adjusting" : ""}`}
    ref={hostRef}
    role="dialog"
    aria-label={`${title ?? CATEGORY_LABELS[category]}定位列表`}
    style={{ left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}
  >
    <header onPointerDown={(event) => beginInteraction(event, "move")}>
      <div><span>{eyebrow}</span><strong>{title ?? CATEGORY_LABELS[category]}</strong><small>{items.length.toLocaleString()} 个定位点</small></div>
      <div className="log-outline-header-actions" onPointerDown={(event) => event.stopPropagation()}>
        <label><input type="checkbox" checked={wrapLines} onChange={(event) => onWrapLinesChange(event.target.checked)} />自动换行</label>
        <button type="button" aria-label="关闭定位列表" title="关闭" onClick={onClose}><CloseIcon /></button>
      </div>
    </header>
    <LogOutlineList
      category={category}
      items={items}
      content={content}
      highlights={highlights}
      wrapLines={wrapLines}
      viewportHeight={wrapLines ? 0 : geometry.height}
      highlightMode={highlightMode}
      onJump={onJump}
    />
    <footer><span>拖动标题栏移动 · 拖动边缘缩放</span><span>点击条目定位日志行</span></footer>
    {RESIZE_DIRECTIONS.map((direction) => <i
      aria-hidden="true"
      className={`log-outline-resize-handle is-${direction}`}
      key={direction}
      onPointerDown={(event) => beginInteraction(event, "resize", direction)}
    />)}
  </div>;
};

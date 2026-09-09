import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { combineCustomLogMarkers, reorderCustomLogMarkers, type CustomLogMarker } from "../custom-log-markers";
import { MoreIcon } from "./Icons";
import { CustomLogMarkerEditor } from "./CustomLogMarkerEditor";

interface CustomLogMarkerShelfProps {
  markers: CustomLogMarker[];
  activeMarkerId?: string;
  onChange: (markers: CustomLogMarker[]) => void;
  onOpen: (marker: CustomLogMarker) => void;
}

export interface CustomLogMarkerShelfHandle {
  closeTopLayer: () => boolean;
}

interface MarkerDrag {
  id: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  targetId?: string;
  action?: "before" | "combine" | "after" | "delete";
}

export const CustomLogMarkerShelf = forwardRef<CustomLogMarkerShelfHandle, CustomLogMarkerShelfProps>(({ markers, activeMarkerId, onChange, onOpen }, ref) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragRef = useRef<MarkerDrag | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const [capacity, setCapacity] = useState(3);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [editing, setEditing] = useState<{ marker: CustomLogMarker; aliasOnly: boolean }>();
  const [drag, setDrag] = useState<MarkerDrag>();

  useImperativeHandle(ref, () => ({
    closeTopLayer: () => {
      if (editing) {
        setEditing(undefined);
        return true;
      }
      if (overflowOpen) {
        setOverflowOpen(false);
        return true;
      }
      return false;
    }
  }), [editing, overflowOpen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setCapacity(Math.max(1, Math.floor((entry.contentRect.width - 44) / 116))));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      const host = hostRef.current;
      if (!current || !host) return;
      const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 6;
      if (!moved) return;
      suppressClickRef.current = true;
      const hostBounds = host.getBoundingClientRect();
      const overflowBounds = host.querySelector<HTMLElement>(".custom-marker-overflow-menu")?.getBoundingClientRect();
      const bounds = overflowBounds ? {
        left: Math.min(hostBounds.left, overflowBounds.left),
        right: Math.max(hostBounds.right, overflowBounds.right),
        top: Math.min(hostBounds.top, overflowBounds.top),
        bottom: Math.max(hostBounds.bottom, overflowBounds.bottom)
      } : hostBounds;
      const outside = event.clientX < bounds.left - 48 || event.clientX > bounds.right + 48 || event.clientY < bounds.top - 48 || event.clientY > bounds.bottom + 48;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-custom-marker-id]");
      let targetId: string | undefined;
      let action: MarkerDrag["action"] = outside ? "delete" : undefined;
      if (!outside && target?.dataset.customMarkerId && target.dataset.customMarkerId !== current.id) {
        targetId = target.dataset.customMarkerId;
        const targetBounds = target.getBoundingClientRect();
        const position = (event.clientX - targetBounds.left) / targetBounds.width;
        action = position < .25 ? "before" : position > .75 ? "after" : "combine";
      }
      const next = { ...current, x: event.clientX, y: event.clientY, targetId, action };
      dragRef.current = next;
      setDrag(next);
    };
    const stop = () => {
      const current = dragRef.current;
      if (current?.action === "delete") onChange(markers.filter(({ id }) => id !== current.id));
      else if (current?.targetId && current.action === "combine") onChange(combineCustomLogMarkers(markers, current.id, current.targetId));
      else if (current?.targetId && (current.action === "before" || current.action === "after")) onChange(reorderCustomLogMarkers(markers, current.id, current.targetId, current.action === "after"));
      dragRef.current = undefined;
      setDrag(undefined);
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [drag, markers, onChange]);

  useEffect(() => {
    if (!overflowOpen) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !hostRef.current?.contains(event.target)) setOverflowOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [overflowOpen]);

  const beginDrag = (event: ReactPointerEvent, marker: CustomLogMarker) => {
    if (event.button !== 0) return;
    const next = { id: marker.id, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY };
    dragRef.current = next;
    setDrag(next);
  };

  const chooseMarker = (marker: CustomLogMarker) => {
    if (suppressClickRef.current) return;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => onOpen(marker), 190);
  };

  const editAlias = (marker: CustomLogMarker) => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    setEditing({ marker, aliasOnly: true });
  };

  const visible = markers.slice(0, capacity);
  const overflow = markers.slice(capacity);
  const markerButton = (marker: CustomLogMarker, inOverflow = false) => <button
    type="button"
    className={`custom-marker-tag${marker.kind === "combine" ? " is-combine" : ""}${activeMarkerId === marker.id ? " is-active" : ""}${drag?.id === marker.id ? " is-dragging" : ""}${drag?.targetId === marker.id ? ` is-drop-${drag.action}` : ""}`}
    data-custom-marker-id={marker.id}
    key={marker.id}
    title={`${marker.kind === "combine" ? `${marker.rules.length} 个组合条件` : marker.rules[0].regex ? "正则标记" : "普通标记"} · 双击改名 · 右键编辑`}
    onPointerDown={(event) => beginDrag(event, marker)}
    onClick={() => { setOverflowOpen(false); chooseMarker(marker); }}
    onDoubleClick={() => editAlias(marker)}
    onContextMenu={(event) => { event.preventDefault(); setOverflowOpen(false); setEditing({ marker, aliasOnly: false }); }}
  ><i aria-hidden="true">{marker.kind === "combine" ? marker.rules.length : marker.rules[0].regex ? ".*" : "#"}</i><span>{marker.label}</span>{inOverflow && <small>{marker.kind === "combine" ? "组合" : marker.rules[0].regex ? "正则" : "文本"}</small>}</button>;

  return <div className="custom-marker-shelf" ref={hostRef}>
    <div className="custom-marker-track" aria-label="自定义日志标记">{visible.map((marker) => markerButton(marker))}</div>
    {overflow.length > 0 && <div className="custom-marker-overflow"><button type="button" className={overflowOpen ? "is-active" : undefined} aria-label={`查看其余 ${overflow.length} 个自定义标记`} onClick={() => setOverflowOpen((open) => !open)}><MoreIcon /><b>+{overflow.length}</b></button>{overflowOpen && <div className="custom-marker-overflow-menu">{overflow.map((marker) => markerButton(marker, true))}</div>}</div>}
    {drag && suppressClickRef.current && <div className={`custom-marker-drag-ghost${drag.action === "delete" ? " is-delete" : ""}`} style={{ left: drag.x, top: drag.y }}>{drag.action === "delete" ? "松开删除" : markers.find(({ id }) => id === drag.id)?.label}</div>}
    {editing && <CustomLogMarkerEditor marker={editing.marker} aliasOnly={editing.aliasOnly} onCancel={() => setEditing(undefined)} onDelete={() => { onChange(markers.filter(({ id }) => id !== editing.marker.id)); setEditing(undefined); }} onSave={(updated) => { onChange(markers.map((marker) => marker.id === updated.id ? updated : marker)); setEditing(undefined); }} />}
  </div>;
});

CustomLogMarkerShelf.displayName = "CustomLogMarkerShelf";

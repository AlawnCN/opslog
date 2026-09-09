import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { errorMessage, saveCustomLogMarkerExport } from "../api";
import {
  customLogMarkerExportName,
  MAX_CUSTOM_LOG_MARKER_IMPORT_BYTES,
  mergeCustomLogMarkerImport,
  serializeCustomLogMarkers
} from "../custom-log-marker-transfer";
import {
  cloneCustomLogMarker,
  combineCustomLogMarkers,
  createEmptyCustomLogMarker,
  MAX_CUSTOM_LOG_MARKERS,
  reorderCustomLogMarkers,
  type CustomLogMarker
} from "../custom-log-markers";
import { CustomLogMarkerContextMenu } from "./CustomLogMarkerContextMenu";
import { CustomLogMarkerEditor } from "./CustomLogMarkerEditor";
import { MoreIcon } from "./Icons";

interface CustomLogMarkerShelfProps {
  markers: CustomLogMarker[];
  activeMarkerId?: string;
  widthRatio: number;
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

interface MarkerEditorState {
  marker: CustomLogMarker;
  aliasOnly: boolean;
  isNew: boolean;
}

interface MarkerMenuState {
  x: number;
  y: number;
  markerId?: string;
}

interface MarkerTransferNotice {
  tone: "info" | "error";
  text: string;
}

export const CustomLogMarkerShelf = forwardRef<CustomLogMarkerShelfHandle, CustomLogMarkerShelfProps>(({
  markers, activeMarkerId, widthRatio, onChange, onOpen
}, ref) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragRef = useRef<MarkerDrag | undefined>(undefined);
  const importInputRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markersRef = useRef(markers);
  const onChangeRef = useRef(onChange);
  const suppressClickRef = useRef(false);
  const [capacity, setCapacity] = useState(3);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [editing, setEditing] = useState<MarkerEditorState>();
  const [menu, setMenu] = useState<MarkerMenuState>();
  const [drag, setDrag] = useState<MarkerDrag>();
  const [transferNotice, setTransferNotice] = useState<MarkerTransferNotice>();
  const draggingId = drag?.id;
  markersRef.current = markers;
  onChangeRef.current = onChange;

  useImperativeHandle(ref, () => ({
    closeTopLayer: () => {
      if (menu) {
        setMenu(undefined);
        return true;
      }
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
  }), [editing, menu, overflowOpen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setCapacity(Math.max(1, Math.floor((entry.contentRect.width - 44) / 116))));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!draggingId) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      const host = hostRef.current;
      if (!current || !host) return;
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) <= 6) return;
      suppressClickRef.current = true;
      const hostBounds = host.getBoundingClientRect();
      const overflowBounds = host.querySelector<HTMLElement>(".custom-marker-overflow-menu")?.getBoundingClientRect();
      const bounds = overflowBounds ? {
        left: Math.min(hostBounds.left, overflowBounds.left), right: Math.max(hostBounds.right, overflowBounds.right),
        top: Math.min(hostBounds.top, overflowBounds.top), bottom: Math.max(hostBounds.bottom, overflowBounds.bottom)
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
      const currentMarkers = markersRef.current;
      if (current?.action === "delete") onChangeRef.current(currentMarkers.filter(({ id }) => id !== current.id));
      else if (current?.targetId && current.action === "combine") onChangeRef.current(combineCustomLogMarkers(currentMarkers, current.id, current.targetId));
      else if (current?.targetId && (current.action === "before" || current.action === "after")) {
        onChangeRef.current(reorderCustomLogMarkers(currentMarkers, current.id, current.targetId, current.action === "after"));
      }
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
  }, [draggingId]);

  useEffect(() => {
    if (!overflowOpen && !menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (menu && !event.target.closest(".custom-marker-context-menu")) {
        setMenu(undefined);
      }
      if (overflowOpen && !event.target.closest(".custom-marker-overflow")) setOverflowOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, overflowOpen]);

  const beginDrag = (event: ReactPointerEvent, marker: CustomLogMarker) => {
    if (event.button !== 0) return;
    setMenu(undefined);
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
    setEditing({ marker, aliasOnly: true, isNew: false });
  };

  const openEditor = (marker: CustomLogMarker, isNew = false) => {
    setMenu(undefined);
    setOverflowOpen(false);
    setEditing({ marker, aliasOnly: false, isNew });
  };

  const createMarker = () => openEditor(createEmptyCustomLogMarker(), true);
  const menuMarker = menu?.markerId ? markers.find(({ id }) => id === menu.markerId) : undefined;
  const visible = markers.slice(0, capacity);
  const overflow = markers.slice(capacity);

  const showTransferNotice = (notice: MarkerTransferNotice) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setTransferNotice(notice);
    noticeTimerRef.current = setTimeout(() => setTransferNotice(undefined), 4200);
  };

  const exportMarkers = async (selected: CustomLogMarker[], label?: string) => {
    setMenu(undefined);
    try {
      const path = await saveCustomLogMarkerExport(customLogMarkerExportName(label), serializeCustomLogMarkers(selected));
      showTransferNotice({ tone: "info", text: path ? `标记已导出：${path}` : `已导出 ${selected.length} 个标记` });
    } catch (error) {
      showTransferNotice({ tone: "error", text: `导出失败：${errorMessage(error)}` });
    }
  };

  const importMarkers = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > MAX_CUSTOM_LOG_MARKER_IMPORT_BYTES) {
      showTransferNotice({ tone: "error", text: "导入失败：标记文件不能超过 1 MB" });
      return;
    }
    try {
      const result = mergeCustomLogMarkerImport(markers, await file.text());
      if (result.imported) onChange(result.markers);
      const details = [
        result.duplicates ? `跳过重复 ${result.duplicates} 个` : "",
        result.invalid ? `忽略无效 ${result.invalid} 个` : "",
        result.overflow ? `容量不足 ${result.overflow} 个` : ""
      ].filter(Boolean).join("，");
      showTransferNotice({
        tone: result.imported ? "info" : "error",
        text: result.imported ? `已导入 ${result.imported} 个标记${details ? `，${details}` : ""}` : `没有导入新标记${details ? `：${details}` : ""}`
      });
    } catch (error) {
      showTransferNotice({ tone: "error", text: `导入失败：${errorMessage(error)}` });
    }
  };

  const markerButton = (marker: CustomLogMarker, inOverflow = false) => <button
    type="button"
    className={`custom-marker-tag${activeMarkerId === marker.id ? " is-active" : ""}${drag?.id === marker.id ? " is-dragging" : ""}${drag?.targetId === marker.id ? ` is-drop-${drag.action}` : ""}`}
    data-custom-marker-id={marker.id}
    key={marker.id}
    title={`${marker.rules.length} 个查询子项 · 双击改名 · 右键操作`}
    onPointerDown={(event) => beginDrag(event, marker)}
    onClick={() => { setOverflowOpen(false); chooseMarker(marker); }}
    onDoubleClick={() => editAlias(marker)}
  ><i aria-hidden="true">{marker.rules.length > 1 ? marker.rules.length : marker.rules[0].regex ? ".*" : "#"}</i><span>{marker.label}</span>{inOverflow && <small>{marker.rules.length} 个子项</small>}</button>;

  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(".custom-marker-editor")) return;
    if (event.target instanceof Element && event.target.closest(".custom-marker-overflow > button")) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const markerId = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-custom-marker-id]")?.dataset.customMarkerId : undefined;
    setOverflowOpen(false);
    setMenu({ x: event.clientX, y: event.clientY, markerId });
  };

  const saveEditor = (updated: CustomLogMarker) => {
    if (!editing) return;
    onChange(editing.isNew ? [...markers, updated] : markers.map((marker) => marker.id === updated.id ? updated : marker));
    setEditing(undefined);
  };

  return <div className="custom-marker-shelf" ref={hostRef} style={{ flexBasis: `${widthRatio * 100}%` }} onContextMenu={openContextMenu}>
    <input ref={importInputRef} className="custom-marker-file-input" type="file" accept="application/json,.json" onChange={(event) => void importMarkers(event)} />
    <div className="custom-marker-track" aria-label="自定义日志标记">
      {visible.map((marker) => markerButton(marker))}
      {!markers.length && <span className="custom-marker-empty">右键新建标记</span>}
    </div>
    {overflow.length > 0 && <div className="custom-marker-overflow"><button type="button" className={overflowOpen ? "is-active" : undefined} aria-label={`查看其余 ${overflow.length} 个自定义标记`} onClick={() => setOverflowOpen((open) => !open)}><MoreIcon /><b>+{overflow.length}</b></button>{overflowOpen && <div className="custom-marker-overflow-menu">{overflow.map((marker) => markerButton(marker, true))}</div>}</div>}
    {drag && suppressClickRef.current && <div className={`custom-marker-drag-ghost${drag.action === "delete" ? " is-delete" : ""}`} style={{ left: drag.x, top: drag.y }}>{drag.action === "delete" ? "松开删除" : markers.find(({ id }) => id === drag.id)?.label}</div>}
    {menu && <CustomLogMarkerContextMenu
      x={menu.x} y={menu.y} markerLabel={menuMarker?.label} cloneDisabled={markers.length >= MAX_CUSTOM_LOG_MARKERS} exportAllDisabled={!markers.length}
      onCreate={createMarker}
      onImport={() => { setMenu(undefined); importInputRef.current?.click(); }}
      onExportAll={() => void exportMarkers(markers)}
      onExportMarker={() => { if (menuMarker) void exportMarkers([menuMarker], menuMarker.label); }}
      onEdit={() => menuMarker && openEditor(menuMarker)}
      onClone={() => { if (menuMarker) onChange(cloneCustomLogMarker(markers, menuMarker.id)); setMenu(undefined); }}
      onDelete={() => { if (menuMarker) onChange(markers.filter(({ id }) => id !== menuMarker.id)); setMenu(undefined); }}
    />}
    {editing && <CustomLogMarkerEditor
      marker={editing.marker} aliasOnly={editing.aliasOnly} creating={editing.isNew} onCancel={() => setEditing(undefined)}
      onDelete={editing.isNew ? undefined : () => { onChange(markers.filter(({ id }) => id !== editing.marker.id)); setEditing(undefined); }}
      onSave={saveEditor}
    />}
    {transferNotice && <div className={`custom-marker-transfer-notice ${transferNotice.tone}`} role="status">{transferNotice.text}</div>}
  </div>;
});

CustomLogMarkerShelf.displayName = "CustomLogMarkerShelf";

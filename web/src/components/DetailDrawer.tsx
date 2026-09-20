import { CloseIcon } from "./Icons";
import { displayNairobiTime } from "../time";
import { useResizableDrawerWidth } from "./useResizableDrawerWidth";

export const DetailDrawer = ({ row, onClose }: { row?: Record<string, unknown>; onClose: () => void }) => {
  const drawerWidth = useResizableDrawerWidth({ storageKey: "opslog.record-inspector.width-ratio.v1", defaultRatio: .46, minimumPixels: 420, bodyClassName: "is-resizing-record-inspector" });
  if (!row) return null;
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer detail-drawer" style={{ width: `${drawerWidth.ratio * 100}vw` }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="trace-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整字段详情窗口宽度" tabIndex={0} onPointerDown={drawerWidth.startResize} onKeyDown={drawerWidth.resizeWithKeyboard} />
      <div className="drawer-heading"><div><span className="eyebrow">RECORD INSPECTOR</span><h2>日志完整字段</h2></div><button onClick={onClose}><CloseIcon /></button></div>
      <div className="detail-grid">
        {Object.entries(row).map(([key, value]) => {
          const shown = key.includes("timestamp") || key === "@timestamp" ? displayNairobiTime(value) : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value ?? "—");
          return <div key={key}><dt>{key}</dt><dd>{shown}</dd></div>;
        })}
      </div>
    </aside>
  </div>;
};

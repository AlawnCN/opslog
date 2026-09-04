import { CloseIcon } from "./Icons";
import { displayNairobiTime } from "../time";

export const DetailDrawer = ({ row, onClose }: { row?: Record<string, unknown>; onClose: () => void }) => {
  if (!row) return null;
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>
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

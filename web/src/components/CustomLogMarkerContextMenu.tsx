import { useLayoutEffect, useRef, useState } from "react";

interface CustomLogMarkerContextMenuProps {
  x: number;
  y: number;
  markerLabel?: string;
  cloneDisabled?: boolean;
  exportAllDisabled?: boolean;
  onCreate: () => void;
  onImport: () => void;
  onExportAll: () => void;
  onExportMarker: () => void;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
}

export const CustomLogMarkerContextMenu = ({
  x, y, markerLabel, cloneDisabled, exportAllDisabled, onCreate, onImport, onExportAll, onExportMarker, onEdit, onClone, onDelete
}: CustomLogMarkerContextMenuProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const bounds = hostRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))
    });
    hostRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [x, y]);

  return <div
    className="custom-marker-context-menu"
    ref={hostRef}
    role="menu"
    aria-label={markerLabel ? `${markerLabel}操作菜单` : "创建自定义标记"}
    style={{ left: position.x, top: position.y }}
    onPointerDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => event.preventDefault()}
  >
    {markerLabel ? <>
      <header><span>MARKER ACTIONS</span><strong>{markerLabel}</strong></header>
      <button type="button" role="menuitem" onClick={onEdit}><i>✎</i><span><b>编辑</b><small>修改标记与查询子项</small></span></button>
      <button type="button" role="menuitem" disabled={cloneDisabled} onClick={onClone}><i>⧉</i><span><b>克隆</b><small>复制为独立的新标记</small></span></button>
      <button type="button" role="menuitem" onClick={onExportMarker}><i>⇧</i><span><b>导出当前标记</b><small>保存为可分享的 JSON 文件</small></span></button>
      <button type="button" role="menuitem" className="danger" onClick={onDelete}><i>×</i><span><b>删除</b><small>移除当前自定义标记</small></span></button>
    </> : <>
      <header><span>CREATE MARKER</span><strong>新建自定义标记</strong></header>
      <button type="button" role="menuitem" onClick={onCreate}><i>#</i><span><b>新建标记</b><small>可添加一个或多个查询子项</small></span></button>
      <button type="button" role="menuitem" onClick={onImport}><i>⇩</i><span><b>导入标记</b><small>追加 OpsLog 标记 JSON 文件</small></span></button>
      <button type="button" role="menuitem" disabled={exportAllDisabled} onClick={onExportAll}><i>⇧</i><span><b>导出全部标记</b><small>备份或分享当前标记集合</small></span></button>
    </>}
  </div>;
};

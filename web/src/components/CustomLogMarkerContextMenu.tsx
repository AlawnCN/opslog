import { useLayoutEffect, useRef, useState } from "react";

interface CustomLogMarkerContextMenuProps {
  x: number;
  y: number;
  markerLabel?: string;
  cloneDisabled?: boolean;
  onCreateSingle: () => void;
  onCreateCombine: () => void;
  onEdit: () => void;
  onClone: () => void;
  onDelete: () => void;
}

export const CustomLogMarkerContextMenu = ({
  x, y, markerLabel, cloneDisabled, onCreateSingle, onCreateCombine, onEdit, onClone, onDelete
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
      <button type="button" role="menuitem" onClick={onEdit}><i>✎</i><span><b>编辑</b><small>修改标签与查询条件</small></span></button>
      <button type="button" role="menuitem" disabled={cloneDisabled} onClick={onClone}><i>⧉</i><span><b>克隆</b><small>复制为独立的新标签</small></span></button>
      <button type="button" role="menuitem" className="danger" onClick={onDelete}><i>×</i><span><b>删除</b><small>移除当前自定义标记</small></span></button>
    </> : <>
      <header><span>CREATE MARKER</span><strong>新建自定义标记</strong></header>
      <button type="button" role="menuitem" onClick={onCreateSingle}><i>#</i><span><b>普通标签</b><small>一个文本或正则查询条件</small></span></button>
      <button type="button" role="menuitem" onClick={onCreateCombine}><i>∑</i><span><b>Combine 标签</b><small>组合多个可排序的查询条件</small></span></button>
    </>}
  </div>;
};

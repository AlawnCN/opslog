import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { ColumnsIcon } from "./Icons";

interface ColumnSelectorProps {
  columns: string[];
  selected: Set<string>;
  labels: Record<string, string>;
  onToggle: (column: string) => void;
  onReorder: (source: string, target: string, after: boolean) => void;
  onSelectAll: () => void;
  onReset: () => void;
}

interface DropTarget {
  column: string;
  after: boolean;
}

export const ColumnSelector = ({ columns, selected, labels, onToggle, onReorder, onSelectAll, onReset }: ColumnSelectorProps) => {
  const container = useRef<HTMLDetailsElement>(null);
  const optionElements = useRef(new Map<string, HTMLDivElement>());
  const dragSession = useRef<{ column: string; pointerId: number; startY: number; didMove: boolean } | undefined>(undefined);
  const dropTargetRef = useRef<DropTarget | undefined>(undefined);
  const [draggingColumn, setDraggingColumn] = useState<string>();
  const [dropTarget, setDropTarget] = useState<DropTarget>();
  const [menuMaxHeight, setMenuMaxHeight] = useState<number>();

  const setCurrentDropTarget = (target: DropTarget | undefined) => {
    dropTargetRef.current = target;
    setDropTarget(target);
  };

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) container.current?.removeAttribute("open");
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") container.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (!draggingColumn) return;
    document.body.classList.add("is-reordering-columns");
    const move = (event: PointerEvent) => {
      const session = dragSession.current;
      if (!session || event.pointerId !== session.pointerId) return;
      if (Math.abs(event.clientY - session.startY) > 2) session.didMove = true;
      const candidates = columns.filter((column) => column !== session.column && selected.has(column));
      let target: DropTarget | undefined;
      for (const column of candidates) {
        const bounds = optionElements.current.get(column)?.getBoundingClientRect();
        if (bounds && event.clientY < bounds.top + bounds.height / 2) {
          target = { column, after: false };
          break;
        }
        if (bounds) target = { column, after: true };
      }
      setCurrentDropTarget(target);
    };
    const stop = (event: PointerEvent) => {
      const session = dragSession.current;
      const target = dropTargetRef.current;
      if (session?.pointerId === event.pointerId && session.didMove && target && session.column !== target.column) {
        onReorder(session.column, target.column, target.after);
      }
      dragSession.current = undefined;
      setDraggingColumn(undefined);
      setCurrentDropTarget(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.body.classList.remove("is-reordering-columns");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [columns, draggingColumn, onReorder, selected]);

  const startPointerReorder = (event: ReactPointerEvent<HTMLDivElement>, column: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragSession.current = { column, pointerId: event.pointerId, startY: event.clientY, didMove: false };
    setDraggingColumn(column);
  };

  const fitMenuBelowSelector = () => {
    const summary = container.current?.querySelector("summary");
    if (!container.current?.open || !summary) return;
    const roomBelow = window.innerHeight - summary.getBoundingClientRect().bottom - 16;
    setMenuMaxHeight(Math.max(180, Math.floor(roomBelow)));
  };

  useEffect(() => {
    window.addEventListener("resize", fitMenuBelowSelector);
    return () => window.removeEventListener("resize", fitMenuBelowSelector);
  }, []);

  const placeMenu = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) {
      setMenuMaxHeight(undefined);
      return;
    }
    fitMenuBelowSelector();
  };

  return (
    <details ref={container} className="column-selector" onToggle={placeMenu}>
      <summary><ColumnsIcon /><span>显示字段</span><strong>{selected.size}/{columns.length}</strong></summary>
      <div className="column-menu" style={menuMaxHeight ? { maxHeight: `${menuMaxHeight}px` } : undefined}>
        <header><span>选择表格字段</span><small>拖动六点把手调整已选字段的表头顺序</small></header>
        <div className="column-options">
          {columns.map((column) => {
            const checked = selected.has(column);
            const placement = dropTarget?.column === column ? (dropTarget.after ? " drop-after" : " drop-before") : "";
            return <div className={`column-option${checked ? " is-selected" : ""}${draggingColumn === column ? " is-dragging" : ""}${placement}`} key={column} ref={(element) => { if (element) optionElements.current.set(column, element); else optionElements.current.delete(column); }} onPointerDown={checked ? (event) => { if (!(event.target as HTMLElement).closest("input")) startPointerReorder(event, column); } : undefined}>
              <input type="checkbox" checked={checked} disabled={checked && selected.size === 1} onChange={() => onToggle(column)} />
              <span className={`column-drag-grip${checked ? "" : " is-disabled"}`} title={checked ? "按住并上下拖动排序" : undefined} aria-hidden="true" />
              <span className="column-option-copy"><strong>{labels[column] ?? column}</strong><small>{column}</small></span>
            </div>;
          })}
        </div>
        <footer><button type="button" onClick={onSelectAll}>全选</button><button type="button" onClick={onReset}>恢复默认</button></footer>
      </div>
    </details>
  );
};

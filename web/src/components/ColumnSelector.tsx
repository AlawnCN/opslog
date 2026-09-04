import { useEffect, useRef } from "react";
import { ColumnsIcon } from "./Icons";

interface ColumnSelectorProps {
  columns: string[];
  selected: Set<string>;
  labels: Record<string, string>;
  onToggle: (column: string) => void;
  onMove: (column: string, direction: -1 | 1) => void;
  onSelectAll: () => void;
  onReset: () => void;
}

export const ColumnSelector = ({ columns, selected, labels, onToggle, onMove, onSelectAll, onReset }: ColumnSelectorProps) => {
  const container = useRef<HTMLDetailsElement>(null);

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

  return (
    <details ref={container} className="column-selector">
      <summary><ColumnsIcon /><span>显示字段</span><strong>{selected.size}/{columns.length}</strong></summary>
      <div className="column-menu">
        <header><span>选择表格字段</span><small>自动记忆当前日志类型</small></header>
        <div className="column-options">
          {columns.map((column) => {
            const checked = selected.has(column);
            const selectedOrder = columns.filter((candidate) => selected.has(candidate));
            const position = selectedOrder.indexOf(column);
            return <div className="column-option" key={column}>
              <label>
                <input type="checkbox" checked={checked} disabled={checked && selected.size === 1} onChange={() => onToggle(column)} />
                <span><strong>{labels[column] ?? column}</strong><small>{column}</small></span>
              </label>
              {checked && <div className="column-order">
                <button type="button" title="向上移动" aria-label={`${labels[column] ?? column}向上移动`} disabled={position === 0} onClick={() => onMove(column, -1)}>↑</button>
                <button type="button" title="向下移动" aria-label={`${labels[column] ?? column}向下移动`} disabled={position === selectedOrder.length - 1} onClick={() => onMove(column, 1)}>↓</button>
              </div>}
            </div>;
          })}
        </div>
        <footer><button type="button" onClick={onSelectAll}>全选</button><button type="button" onClick={onReset}>恢复默认</button></footer>
      </div>
    </details>
  );
};

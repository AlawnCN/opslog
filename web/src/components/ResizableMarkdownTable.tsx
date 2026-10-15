import { useEffect, useRef, type ReactNode } from "react";
import { fitTableColumn } from "../table-auto-width";

export const ResizableMarkdownTable = ({ children }: { children: ReactNode }) => {
  const ref = useRef<HTMLTableElement>(null);
  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    const controls = Array.from(table.tHead?.rows[0]?.cells ?? []).map((cell, index) => {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "column-resizer";
      handle.title = "拖拽调整列宽；双击自适应内容";
      handle.setAttribute("aria-label", `调整 ${cell.textContent?.trim() || index + 1} 列宽`);
      let start: { x: number; width: number } | undefined;
      const applyWidth = (width: number) => {
        for (const row of Array.from(table.rows)) {
          const target = row.cells[index];
          if (target) Object.assign(target.style, { width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` });
        }
      };
      handle.onpointerdown = event => {
        if (event.button !== 0) return;
        start = { x: event.clientX, width: cell.getBoundingClientRect().width };
      };
      handle.onpointermove = event => {
        if (!start || Math.abs(event.clientX - start.x) < 3) return;
        if (!handle.hasPointerCapture(event.pointerId)) handle.setPointerCapture(event.pointerId);
        applyWidth(Math.max(80, Math.min(3000, start.width + event.clientX - start.x)));
      };
      handle.onpointerup = handle.onpointercancel = () => { start = undefined; };
      handle.ondblclick = () => fitTableColumn(table, index);
      handle.onkeydown = event => {
        if (event.key === "Enter") { event.preventDefault(); fitTableColumn(table, index); }
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault(); applyWidth(Math.max(80, Math.min(3000, cell.getBoundingClientRect().width + (event.key === "ArrowLeft" ? -20 : 20))));
        }
      };
      cell.append(handle);
      return handle;
    });
    return () => controls.forEach(control => control.remove());
  }, [children]);
  return <div className="markdown-table-scroll"><table className="resizable-markdown-table" ref={ref}>{children}</table></div>;
};

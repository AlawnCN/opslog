import { memo, useMemo, useState } from "react";
import { logHighlightClassName } from "../log-highlight-presentation";
import { createOutlinePreviewSegments, indexOutlineHighlights, indexSqlOutlineHighlights } from "../log-outline-preview";
import type { LogHighlight, LogOutlineCategory, LogOutlineItem } from "../transaction-log-model";

const OUTLINE_ROW_HEIGHT = 43;

interface LogOutlineListProps {
  category: LogOutlineCategory;
  items: LogOutlineItem[];
  content: string;
  highlights: LogHighlight[];
  wrapLines: boolean;
  viewportHeight: number;
  highlightMode?: "sql" | "all" | "none";
  onJump: (position: number) => void;
}

const linePreview = (content: string, item: LogOutlineItem): string =>
  content.slice(item.from, item.to).trim() || "（空行）";

export const LogOutlineList = memo(({
  category, items, content, highlights, wrapLines, viewportHeight, highlightMode, onJump
}: LogOutlineListProps) => {
  const [scrollTop, setScrollTop] = useState(0);
  const firstVisibleIndex = Math.max(0, Math.floor(scrollTop / OUTLINE_ROW_HEIGHT) - 4);
  const visibleRowCount = Math.ceil(viewportHeight / OUTLINE_ROW_HEIGHT) + 10;
  const visibleItems = useMemo(
    () => items.slice(firstVisibleIndex, firstVisibleIndex + visibleRowCount),
    [firstVisibleIndex, items, visibleRowCount]
  );
  const highlightsByItem = useMemo(
    () => highlightMode === "all"
      ? indexOutlineHighlights(items, highlights)
      : highlightMode !== "none" && category === "sql"
        ? indexSqlOutlineHighlights(items, highlights)
        : new Map<number, LogHighlight[]>(),
    [category, highlightMode, highlights, items]
  );
  const contentWidthCharacters = useMemo(() => items.reduce(
    (maximum, item) => Math.max(maximum, Math.min(32768, item.to - item.from + (item.detail?.length ?? 0) + 16)),
    96
  ), [items]);

  const renderPreview = (item: LogOutlineItem) => {
    const semanticHighlights = highlightsByItem.get(item.from);
    const segments = semanticHighlights
      ? createOutlinePreviewSegments(content, item, semanticHighlights)
      : [{ text: linePreview(content, item) }];
    return segments.map((segment, index) => <span className={segment.kind ? logHighlightClassName(segment.kind) : undefined} key={`${index}-${segment.kind ?? "plain"}`}>{segment.text}</span>);
  };

  const renderItem = (item: LogOutlineItem, index: number, virtualized: boolean) => <button
    type="button"
    key={`${item.from}-${index}`}
    style={virtualized ? { transform: `translateY(${index * OUTLINE_ROW_HEIGHT}px)` } : undefined}
    onClick={() => onJump(item.from)}
  >
    <span className="log-outline-line">L{item.line}</span>
    <span className="log-outline-preview">{renderPreview(item)}</span>
    {item.detail && <span className="log-outline-detail">{item.detail}</span>}
  </button>;

  return <div className="log-outline-list" onScroll={wrapLines ? undefined : (event) => setScrollTop(event.currentTarget.scrollTop)}>
    {items.length === 0 && <div className="log-outline-empty">当前日志没有可定位的内容</div>}
    {items.length > 0 && <div
      className={`log-outline-window${wrapLines ? " is-wrapped" : ""}`}
      style={wrapLines ? undefined : { height: items.length * OUTLINE_ROW_HEIGHT, width: `max(100%, ${contentWidthCharacters}ch)` }}
    >
      {wrapLines
        ? items.map((item, index) => renderItem(item, index, false))
        : visibleItems.map((item, visibleIndex) => renderItem(item, firstVisibleIndex + visibleIndex, true))}
    </div>}
  </div>;
});

import type { LogHighlight, LogHighlightKind, LogOutlineItem } from "./transaction-log-model";

export interface LogOutlinePreviewSegment {
  text: string;
  kind?: LogHighlightKind;
}

const SQL_HIGHLIGHT_PRIORITY: Partial<Record<LogHighlightKind, number>> = {
  "sql-muted": 1,
  "sql-keyword": 2,
  "sql-table": 3
};

const isSqlHighlight = (highlight: LogHighlight): boolean => SQL_HIGHLIGHT_PRIORITY[highlight.kind] !== undefined;

const trimmedRange = (content: string, item: LogOutlineItem): [number, number] => {
  let from = item.from;
  let to = item.to;
  while (from < to && /\s/.test(content[from])) from += 1;
  while (to > from && /\s/.test(content[to - 1])) to -= 1;
  return [from, to];
};

export const createOutlinePreviewSegments = (
  content: string,
  item: LogOutlineItem,
  highlights: LogHighlight[]
): LogOutlinePreviewSegment[] => {
  const [from, to] = trimmedRange(content, item);
  if (from >= to) return [{ text: "（空行）" }];
  if (highlights.length === 0) return [{ text: content.slice(from, to) }];

  const boundaries = new Set<number>([from, to]);
  highlights.forEach((highlight) => {
    boundaries.add(Math.max(from, highlight.from));
    boundaries.add(Math.min(to, highlight.to));
  });
  const positions = [...boundaries].sort((left, right) => left - right);
  const segments: LogOutlinePreviewSegment[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const segmentFrom = positions[index], segmentTo = positions[index + 1];
    if (segmentFrom >= segmentTo) continue;
    const active = highlights
      .filter((highlight) => highlight.from <= segmentFrom && highlight.to >= segmentTo)
      .sort((left, right) => (SQL_HIGHLIGHT_PRIORITY[right.kind] ?? 0) - (SQL_HIGHLIGHT_PRIORITY[left.kind] ?? 0))[0];
    const kind = active?.kind;
    const previous = segments.at(-1);
    const text = content.slice(segmentFrom, segmentTo);
    if (previous && previous.kind === kind) previous.text += text;
    else segments.push({ text, kind });
  }
  return segments;
};

export const indexSqlOutlineHighlights = (
  items: LogOutlineItem[],
  highlights: LogHighlight[]
): Map<number, LogHighlight[]> => {
  const highlightsByItem = new Map<number, LogHighlight[]>();
  if (items.length === 0) return highlightsByItem;
  let itemIndex = 0;
  for (const highlight of highlights) {
    if (!isSqlHighlight(highlight)) continue;
    while (itemIndex < items.length && items[itemIndex].to <= highlight.from) itemIndex += 1;
    const item = items[itemIndex];
    if (!item || highlight.to <= item.from || highlight.from >= item.to) continue;
    const current = highlightsByItem.get(item.from) ?? [];
    current.push(highlight);
    highlightsByItem.set(item.from, current);
  }
  return highlightsByItem;
};

export const createSqlOutlinePreviews = (
  content: string,
  items: LogOutlineItem[],
  highlights: LogHighlight[]
): Map<number, LogOutlinePreviewSegment[]> => {
  const previews = new Map<number, LogOutlinePreviewSegment[]>();
  const highlightsByItem = indexSqlOutlineHighlights(items, highlights);
  items.forEach((item) => previews.set(item.from, createOutlinePreviewSegments(content, item, highlightsByItem.get(item.from) ?? [])));
  return previews;
};

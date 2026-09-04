import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CloseIcon, SearchIcon } from "./Icons";

const findMatches = (content: string, query: string): number[] => {
  if (!query) return [];
  const source = content.toLocaleLowerCase();
  const matches: number[] = [];
  let from = 0;
  while (true) {
    const match = source.indexOf(query, from);
    if (match < 0) return matches;
    matches.push(match);
    from = match + query.length;
  }
};

const highlightMatches = (
  content: string,
  query: string,
  matches: number[],
  activeMatch: number,
  markElements: Array<HTMLElement | null>
): ReactNode => {
  if (!query) return content;
  const segments: ReactNode[] = [];
  let from = 0;
  matches.forEach((match, index) => {
    segments.push(content.slice(from, match));
    segments.push(<mark className={index === activeMatch ? "active-match" : undefined} key={`${match}-${index}`} ref={(element) => { markElements[index] = element; }}>{content.slice(match, match + query.length)}</mark>);
    from = match + query.length;
  });
  segments.push(content.slice(from));
  return segments;
};

interface TransactionLogDrawerProps {
  logId?: string;
  content: string;
  loading: boolean;
  onClose: () => void;
}

export const TransactionLogDrawer = ({ logId, content, loading, onClose }: TransactionLogDrawerProps) => {
  const [keyword, setKeyword] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [wrapLines, setWrapLines] = useState(false);
  const markElements = useRef<Array<HTMLElement | null>>([]);
  const query = keyword.trim().toLocaleLowerCase();
  const matches = useMemo(() => findMatches(content, query), [content, query]);
  const visibleActiveMatch = matches.length ? Math.min(activeMatch, matches.length - 1) : 0;
  const highlightedContent = useMemo(
    () => highlightMatches(content, query, matches, visibleActiveMatch, markElements.current),
    [content, query, matches, visibleActiveMatch]
  );

  useEffect(() => {
    setKeyword("");
  }, [logId]);

  useEffect(() => {
    setActiveMatch(0);
    markElements.current = [];
  }, [content, query]);

  useEffect(() => {
    if (!query || matches.length === 0) return;
    markElements.current[visibleActiveMatch]?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }, [matches.length, query, visibleActiveMatch]);

  const moveMatch = (direction: -1 | 1) => {
    if (matches.length === 0) return;
    setActiveMatch((current) => (current + direction + matches.length) % matches.length);
  };

  if (!logId) return null;
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer log-reader-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <div className="drawer-heading"><div><span className="eyebrow">TRANSACTION LOG</span><h2>日志阅读器</h2><code>{logId}</code></div><button title="关闭阅读器" aria-label="关闭阅读器" onClick={onClose}><CloseIcon /></button></div>
      <div className="log-reader-controls">
        <label className="log-reader-search"><SearchIcon /><input autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } }} placeholder="查询日志内容" aria-label="查询日志内容" /></label>
        {query && <span className={matches.length ? "match-count" : "match-count no-match"}>{matches.length ? `${visibleActiveMatch + 1} / ${matches.length}` : "未找到匹配内容"}</span>}
        <div className="match-navigation"><button disabled={!matches.length} title="上一个命中（Shift + Enter）" onClick={() => moveMatch(-1)}>上一个</button><button disabled={!matches.length} title="下一个命中（Enter）" onClick={() => moveMatch(1)}>下一个</button></div>
        <label className="wrap-toggle"><input type="checkbox" checked={wrapLines} onChange={(event) => setWrapLines(event.target.checked)} />自动换行</label>
        {keyword && <button className="clear-reader-search" onClick={() => setKeyword("")}>清除</button>}
      </div>
      {loading && <div className="log-reader-status log-reader-loading" role="status" aria-live="polite"><div className="log-reader-loading-visual" aria-hidden="true"><i /><i /><i /><i /><b /></div><strong>正在读取日志文件…</strong><span>正在从交易日志索引加载文本内容</span></div>}
      {!loading && !content && <div className="log-reader-status">当前时间范围内未找到日志内容。</div>}
      {!loading && content && <div className={`log-reader-body${wrapLines ? " wrap-lines" : ""}`}><pre>{highlightedContent}</pre></div>}
    </aside>
  </div>;
};

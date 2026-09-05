import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { analyzeTransactionLog, findLogMatchesInLowercase, MAX_LOG_SEARCH_MATCHES } from "../transaction-log-analysis";
import { CloseIcon, SearchIcon } from "./Icons";
import { StructuredLogViewer, type StructuredLogViewerHandle } from "./StructuredLogViewer";

const READER_WIDTH_KEY = "opslog.transaction-log-reader.width-ratio.v1";
const DEFAULT_READER_WIDTH_RATIO = .5;

const clampReaderWidthRatio = (ratio: number): number => {
  const viewportWidth = typeof window === "undefined" ? 1600 : window.innerWidth;
  const maximum = viewportWidth <= 900 ? .94 : .88;
  const minimum = Math.min(520 / viewportWidth, maximum);
  return Math.min(maximum, Math.max(minimum, ratio));
};

const readReaderWidthRatio = (): number => {
  try {
    const saved = Number.parseFloat(localStorage.getItem(READER_WIDTH_KEY) ?? "");
    return clampReaderWidthRatio(Number.isFinite(saved) ? saved : DEFAULT_READER_WIDTH_RATIO);
  } catch {
    return DEFAULT_READER_WIDTH_RATIO;
  }
};

interface TransactionLogDrawerProps {
  logId?: string;
  content: string;
  loading: boolean;
  remoteDurationMs?: number;
  cached?: boolean;
  onClose: () => void;
}

export const TransactionLogDrawer = ({ logId, content, loading, remoteDurationMs, cached, onClose }: TransactionLogDrawerProps) => {
  const [keyword, setKeyword] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [wrapLines, setWrapLines] = useState(false);
  const [widthRatio, setWidthRatio] = useState(readReaderWidthRatio);
  const [isResizing, setIsResizing] = useState(false);
  const viewerRef = useRef<StructuredLogViewerHandle>(null);
  const resizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const widthRatioRef = useRef(widthRatio);
  const deferredKeyword = useDeferredValue(keyword);
  const query = deferredKeyword.trim();
  const searchableContent = useMemo(() => content.toLocaleLowerCase(), [content]);
  const analyzed = useMemo(() => {
    const startedAt = performance.now();
    const value = analyzeTransactionLog(content);
    return { value, durationMs: performance.now() - startedAt };
  }, [content]);
  const analysis = analyzed.value;
  const matches = useMemo(() => findLogMatchesInLowercase(searchableContent, query), [query, searchableContent]);
  const visibleActiveMatch = matches.length ? Math.min(activeMatch, matches.length - 1) : 0;

  useEffect(() => {
    setKeyword("");
  }, [logId]);

  useEffect(() => {
    widthRatioRef.current = widthRatio;
  }, [widthRatio]);

  useEffect(() => {
    const constrainWidth = () => setWidthRatio((current) => clampReaderWidthRatio(current));
    window.addEventListener("resize", constrainWidth);
    return () => window.removeEventListener("resize", constrainWidth);
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    document.body.classList.add("is-resizing-log-reader");
    const updateWidth = (width: number) => {
      const next = clampReaderWidthRatio(width / window.innerWidth);
      widthRatioRef.current = next;
      setWidthRatio(next);
    };
    const move = (event: PointerEvent) => {
      const start = resizeStart.current;
      if (start) updateWidth(start.width + start.pointerX - event.clientX);
    };
    const stop = () => {
      resizeStart.current = null;
      setIsResizing(false);
      try {
        localStorage.setItem(READER_WIDTH_KEY, String(widthRatioRef.current));
      } catch {
        // The reader remains resizable if storage is disabled.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.classList.remove("is-resizing-log-reader");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [isResizing]);

  useEffect(() => {
    setActiveMatch(0);
  }, [content, query]);

  const moveMatch = (direction: -1 | 1) => {
    if (matches.length === 0) return;
    setActiveMatch((current) => (current + direction + matches.length) % matches.length);
  };

  const resizeReader = (width: number) => {
    const next = clampReaderWidthRatio(width / window.innerWidth);
    widthRatioRef.current = next;
    setWidthRatio(next);
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStart.current = { pointerX: event.clientX, width: widthRatioRef.current * window.innerWidth };
    setIsResizing(true);
  };

  const adjustReaderWidth = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") resizeReader(widthRatioRef.current * window.innerWidth + 48);
    else if (event.key === "ArrowRight") resizeReader(widthRatioRef.current * window.innerWidth - 48);
    else return;
    event.preventDefault();
    try {
      localStorage.setItem(READER_WIDTH_KEY, String(widthRatioRef.current));
    } catch {
      // Keyboard resizing still applies for this view.
    }
  };

  if (!logId) return null;
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer log-reader-drawer" style={{ width: `${widthRatio * 100}vw` }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="log-reader-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整日志阅读器宽度" aria-valuemin={Math.round(Math.min(520 / window.innerWidth, .88) * 100)} aria-valuemax={88} aria-valuenow={Math.round(widthRatio * 100)} tabIndex={0} onPointerDown={startResize} onKeyDown={adjustReaderWidth} />
      <div className="drawer-heading"><div><span className="eyebrow">TRANSACTION LOG</span><h2>日志阅读器</h2><code>{logId}</code></div><button title="关闭阅读器" aria-label="关闭阅读器" onClick={onClose}><CloseIcon /></button></div>
      <div className="log-reader-controls">
        <label className="log-reader-search"><SearchIcon /><input autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } }} placeholder="查询日志内容" aria-label="查询日志内容" /></label>
        {query && <span className={matches.length ? "match-count" : "match-count no-match"}>{matches.length ? `${visibleActiveMatch + 1} / ${matches.length === MAX_LOG_SEARCH_MATCHES ? `${MAX_LOG_SEARCH_MATCHES}+` : matches.length}` : "未找到匹配内容"}</span>}
        <div className="match-navigation"><button disabled={!matches.length} title="上一个命中（Shift + Enter）" onClick={() => moveMatch(-1)}>上一个</button><button disabled={!matches.length} title="下一个命中（Enter）" onClick={() => moveMatch(1)}>下一个</button></div>
        <label className="wrap-toggle"><input type="checkbox" checked={wrapLines} onChange={(event) => setWrapLines(event.target.checked)} />自动换行</label>
        {keyword && <button className="clear-reader-search" onClick={() => setKeyword("")}>清除</button>}
      </div>
      {!loading && content && <div className="log-reader-insights" aria-label="日志分析摘要">
        <span className="reader-performance" title="远程时间包含 Kibana 查询、VPN 传输和正文接收">{cached ? <><b>缓存</b> 即时加载</> : <><b>{((remoteDurationMs ?? 0) / 1000).toFixed(2)}s</b> 远程</>} · <b>{analyzed.durationMs.toFixed(0)}ms</b> 解析</span>
        <span><b>{analysis.stats.lines.toLocaleString()}</b> 行</span>
        <span title="不同底色表示不同微服务区段，入口行可单独折叠"><b>{analysis.stats.services}</b> 微服务</span>
        <span><b>{analysis.stats.calls}</b> 调用标记</span>
        <span><b>{analysis.stats.sql}</b> SQL</span>
        <span className={analysis.stats.failedResults ? "has-errors" : undefined} title="只统计响应、结果或错误上下文中的非成功消息码"><b>{analysis.stats.failedResults}</b> 失败线索</span>
        <span className={analysis.stats.exceptions ? "has-errors" : undefined}><b>{analysis.stats.exceptions}</b> ERROR/异常</span>
        <span><b>{analysis.stats.structured}</b> 结构块</span>
        <div className="log-reader-fold-actions"><button onClick={() => viewerRef.current?.foldAll()}>全部折叠</button><button onClick={() => viewerRef.current?.unfoldAll()}>全部展开</button></div>
      </div>}
      {loading && <div className="log-reader-status log-reader-loading" role="status" aria-live="polite"><div className="log-reader-loading-visual" aria-hidden="true"><i /><i /><i /><i /><b /></div><strong>正在读取日志文件…</strong><span>正在从交易日志索引加载文本内容</span></div>}
      {!loading && !content && <div className="log-reader-status">当前时间范围内未找到日志内容。</div>}
      {!loading && content && <div className="log-reader-body"><StructuredLogViewer ref={viewerRef} analysis={analysis} content={content} matches={matches} activeMatch={visibleActiveMatch} queryLength={query.length} wrapLines={wrapLines} /></div>}
    </aside>
  </div>;
};

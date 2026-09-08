import { forwardRef, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { readLogReaderPreferences, storeLogReaderPreferences, type LogReaderPreferences } from "../log-reader-preferences";
import { analyzeTransactionLog, findLogMatchesInLowercase, MAX_LOG_SEARCH_MATCHES } from "../transaction-log-analysis";
import type { LogOutlineCategory } from "../transaction-log-model";
import { CloseIcon, SearchIcon } from "./Icons";
import { LogOutlinePopover } from "./LogOutlinePopover";
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

export interface TransactionLogDrawerHandle {
  closeTopLayer: () => void;
  focusSearch: () => void;
}

export const TransactionLogDrawer = forwardRef<TransactionLogDrawerHandle, TransactionLogDrawerProps>(({ logId, content, loading, remoteDurationMs, cached, onClose }, ref) => {
  const [keyword, setKeyword] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [readerPreferences, setReaderPreferences] = useState(readLogReaderPreferences);
  const [widthRatio, setWidthRatio] = useState(readReaderWidthRatio);
  const [isResizing, setIsResizing] = useState(false);
  const [outlineCategory, setOutlineCategory] = useState<LogOutlineCategory>();
  const viewerRef = useRef<StructuredLogViewerHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const logReaderBodyRef = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const widthRatioRef = useRef(widthRatio);
  const deferredKeyword = useDeferredValue(keyword);
  const wrapLines = readerPreferences.wrapLines;
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

  useImperativeHandle(ref, () => ({
    closeTopLayer: () => {
      if (outlineCategory) {
        setOutlineCategory(undefined);
        return;
      }
      onClose();
    },
    focusSearch: () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }), [onClose, outlineCategory]);

  useEffect(() => {
    setKeyword("");
    setOutlineCategory(undefined);
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

  const toggleOutline = (category: LogOutlineCategory) => {
    setOutlineCategory((current) => current === category ? undefined : category);
  };

  const updateReaderPreferences = (change: Partial<LogReaderPreferences>) => {
    setReaderPreferences((current) => {
      const next = { ...current, ...change };
      storeLogReaderPreferences(next);
      return next;
    });
  };

  const applyFoldMode = (foldMode: LogReaderPreferences["foldMode"]) => {
    updateReaderPreferences({ foldMode });
    if (foldMode === "folded") viewerRef.current?.foldAll();
    else viewerRef.current?.unfoldAll();
  };

  const jumpFromOutline = (position: number) => {
    setOutlineCategory(undefined);
    viewerRef.current?.jumpTo(position);
  };

  if (!logId) return null;
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer log-reader-drawer" style={{ width: `${widthRatio * 100}vw` }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="log-reader-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整日志阅读器宽度" aria-valuemin={Math.round(Math.min(520 / window.innerWidth, .88) * 100)} aria-valuemax={88} aria-valuenow={Math.round(widthRatio * 100)} tabIndex={0} onPointerDown={startResize} onKeyDown={adjustReaderWidth} />
      <div className="drawer-heading"><div><span className="eyebrow">TRANSACTION LOG</span><h2>日志阅读器</h2><code>{logId}</code></div><button title="关闭阅读器" aria-label="关闭阅读器" onClick={onClose}><CloseIcon /></button></div>
      <div className="log-reader-controls">
        <label className="log-reader-search"><SearchIcon /><input ref={searchInputRef} autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } }} placeholder="查询日志内容" aria-label="查询日志内容" aria-keyshortcuts="Meta+F Alt+F" /></label>
        {query && <span className={matches.length ? "match-count" : "match-count no-match"}>{matches.length ? `${visibleActiveMatch + 1} / ${matches.length === MAX_LOG_SEARCH_MATCHES ? `${MAX_LOG_SEARCH_MATCHES}+` : matches.length}` : "未找到匹配内容"}</span>}
        <div className="match-navigation"><button disabled={!matches.length} title="上一个命中（Shift + Enter）" onClick={() => moveMatch(-1)}>上一个</button><button disabled={!matches.length} title="下一个命中（Enter）" onClick={() => moveMatch(1)}>下一个</button></div>
        <label className="wrap-toggle"><input type="checkbox" checked={wrapLines} onChange={(event) => updateReaderPreferences({ wrapLines: event.target.checked })} />自动换行</label>
        {keyword && <button className="clear-reader-search" onClick={() => setKeyword("")}>清除</button>}
      </div>
      {!loading && content && <div className="log-reader-insights-shell" onPointerDown={(event) => event.stopPropagation()}>
        <div className="log-reader-insights" aria-label="日志分析摘要">
          <span className="reader-performance" title="远程时间包含 Kibana 查询、VPN 传输和正文接收">{cached ? <><b>缓存</b> 即时加载</> : <><b>{((remoteDurationMs ?? 0) / 1000).toFixed(2)}s</b> 远程</>} · <b>{analyzed.durationMs.toFixed(0)}ms</b> 解析</span>
          <span><b>{analysis.stats.lines.toLocaleString()}</b> 行</span>
          <button type="button" data-log-outline-trigger className={outlineCategory === "service" ? "is-active" : undefined} title="查看微服务入口 Outline" onClick={() => toggleOutline("service")}><b>{analysis.stats.services}</b> 微服务</button>
          <button type="button" data-log-outline-trigger className={outlineCategory === "call" ? "is-active" : undefined} title="查看调用标记 Outline" onClick={() => toggleOutline("call")}><b>{analysis.stats.calls}</b> 调用标记</button>
          <button type="button" data-log-outline-trigger className={outlineCategory === "sql" ? "is-active" : undefined} title="查看 SQL Outline" onClick={() => toggleOutline("sql")}><b>{analysis.stats.sql}</b> SQL</button>
          <button type="button" data-log-outline-trigger className={`${analysis.stats.failedResults ? "has-errors" : ""}${outlineCategory === "failed-result" ? " is-active" : ""}`} title="查看失败线索 Outline" onClick={() => toggleOutline("failed-result")}><b>{analysis.stats.failedResults}</b> 失败线索</button>
          <button type="button" data-log-outline-trigger className={`${analysis.stats.exceptions ? "has-errors" : ""}${outlineCategory === "exception" ? " is-active" : ""}`} title="查看异常 Outline" onClick={() => toggleOutline("exception")}><b>{analysis.stats.exceptions}</b> ERROR/异常</button>
          <button type="button" data-log-outline-trigger className={outlineCategory === "structured" ? "is-active" : undefined} title="查看结构块 Outline" onClick={() => toggleOutline("structured")}><b>{analysis.stats.structured}</b> 结构块</button>
          <div className="log-reader-fold-actions"><button title="折叠全部结构，并在下次打开日志时继续使用" onClick={() => applyFoldMode("folded")}>全部折叠</button><button title="展开全部结构，并在下次打开日志时继续使用" onClick={() => applyFoldMode("expanded")}>全部展开</button></div>
        </div>
      </div>}
      {loading && <div className="log-reader-status log-reader-loading" role="status" aria-live="polite"><div className="log-reader-loading-visual" aria-hidden="true"><i /><i /><i /><i /><b /></div><strong>正在读取日志文件…</strong><span>正在从交易日志索引加载文本内容</span></div>}
      {!loading && !content && <div className="log-reader-status">当前时间范围内未找到日志内容。</div>}
      {!loading && content && <div className="log-reader-body" ref={logReaderBodyRef}>
        <StructuredLogViewer ref={viewerRef} analysis={analysis} content={content} matches={matches} activeMatch={visibleActiveMatch} queryLength={query.length} wrapLines={wrapLines} foldMode={readerPreferences.foldMode} />
        {outlineCategory && <LogOutlinePopover
          boundsRef={logReaderBodyRef}
          category={outlineCategory}
          items={analysis.outline[outlineCategory]}
          content={content}
          highlights={analysis.highlights}
          wrapLines={readerPreferences.outlineWrapLines}
          onClose={() => setOutlineCategory(undefined)}
          onJump={jumpFromOutline}
          onWrapLinesChange={(outlineWrapLines) => updateReaderPreferences({ outlineWrapLines })}
        />}
      </div>}
    </aside>
  </div>;
});

TransactionLogDrawer.displayName = "TransactionLogDrawer";

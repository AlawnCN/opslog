import { forwardRef, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { readCustomMarkerWidthRatio, storeCustomMarkerWidthRatio } from "../custom-marker-layout";
import { buildCustomLogMarkerOutline, createCustomLogMarker, MAX_CUSTOM_LOG_MARKERS, readCustomLogMarkers, storeCustomLogMarkers, type CustomLogMarker } from "../custom-log-markers";
import { readLogReaderPreferences, storeLogReaderPreferences, type LogReaderPreferences } from "../log-reader-preferences";
import { analyzeTransactionLog } from "../transaction-log-analysis";
import { createPortableLogDocument } from "../portable-log-export";
import { portableLogFilename } from "../portable-log-export-data";
import { errorMessage, savePortableLogHtml } from "../api";
import { findPlainLogMatchesInLowercase, findRegexLogMatches, MAX_LOG_SEARCH_MATCHES } from "../transaction-log-search";
import type { LogOutlineCategory } from "../transaction-log-model";
import { CloseIcon, DownloadIcon, MarkerAddIcon, SearchIcon } from "./Icons";
import { CustomLogMarkerShelf, type CustomLogMarkerShelfHandle } from "./CustomLogMarkerShelf";
import { CustomMarkerSectionResizeHandle } from "./CustomMarkerSectionResizeHandle";
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
  const [customMarkers, setCustomMarkers] = useState(readCustomLogMarkers);
  const [customMarkerWidthRatio, setCustomMarkerWidthRatio] = useState(readCustomMarkerWidthRatio);
  const [activeCustomMarkerId, setActiveCustomMarkerId] = useState<string>();
  const [exportingPortable, setExportingPortable] = useState(false);
  const [portableExportNotice, setPortableExportNotice] = useState<string>();
  const viewerRef = useRef<StructuredLogViewerHandle>(null);
  const customMarkerShelfRef = useRef<CustomLogMarkerShelfHandle>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const logReaderBodyRef = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const widthRatioRef = useRef(widthRatio);
  const deferredKeyword = useDeferredValue(keyword);
  const wrapLines = readerPreferences.wrapLines;
  const regexSearch = readerPreferences.regexSearch;
  const query = regexSearch ? deferredKeyword : deferredKeyword.trim();
  const searchableContent = useMemo(() => content.toLocaleLowerCase(), [content]);
  const analyzed = useMemo(() => {
    const startedAt = performance.now();
    const value = analyzeTransactionLog(content);
    return { value, durationMs: performance.now() - startedAt };
  }, [content]);
  const analysis = analyzed.value;
  const searchResult = useMemo(() => regexSearch
    ? findRegexLogMatches(content, query)
    : { matches: findPlainLogMatchesInLowercase(searchableContent, query) }, [content, query, regexSearch, searchableContent]);
  const markerQuery = keyword.trim();
  const markerQueryError = regexSearch ? findRegexLogMatches("", markerQuery).error : undefined;
  const matches = searchResult.matches;
  const visibleActiveMatch = matches.length ? Math.min(activeMatch, matches.length - 1) : 0;
  const activeCustomMarker = customMarkers.find(({ id }) => id === activeCustomMarkerId);
  const customOutline = useMemo(
    () => activeCustomMarker ? buildCustomLogMarkerOutline(content, activeCustomMarker) : undefined,
    [activeCustomMarker, content]
  );

  useImperativeHandle(ref, () => ({
    closeTopLayer: () => {
      if (customMarkerShelfRef.current?.closeTopLayer()) return;
      if (outlineCategory) {
        setOutlineCategory(undefined);
        return;
      }
      if (activeCustomMarkerId) {
        setActiveCustomMarkerId(undefined);
        return;
      }
      onClose();
    },
    focusSearch: () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }), [activeCustomMarkerId, onClose, outlineCategory]);

  useEffect(() => {
    setKeyword("");
    setOutlineCategory(undefined);
    setActiveCustomMarkerId(undefined);
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
  }, [content, query, regexSearch]);

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
    setActiveCustomMarkerId(undefined);
    setOutlineCategory((current) => current === category ? undefined : category);
  };

  const replaceCustomMarkers = useCallback((markers: CustomLogMarker[]) => {
    const boundedMarkers = markers.slice(0, MAX_CUSTOM_LOG_MARKERS);
    setCustomMarkers(boundedMarkers);
    storeCustomLogMarkers(boundedMarkers);
    setActiveCustomMarkerId((current) => current && boundedMarkers.some(({ id }) => id === current) ? current : undefined);
  }, []);

  const addCustomMarker = () => {
    if (!markerQuery || markerQueryError || customMarkers.length >= MAX_CUSTOM_LOG_MARKERS) return;
    const marker = createCustomLogMarker(markerQuery, regexSearch);
    replaceCustomMarkers([...customMarkers, marker]);
  };

  const openCustomMarker = (marker: CustomLogMarker) => {
    setOutlineCategory(undefined);
    setActiveCustomMarkerId((current) => current === marker.id ? undefined : marker.id);
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
    setActiveCustomMarkerId(undefined);
    viewerRef.current?.jumpTo(position);
  };

  const exportPortableReader = async () => {
    if (exportingPortable || !content || !logId) return;
    const activeLogId = logId;
    setExportingPortable(true);
    setPortableExportNotice(undefined);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const filename = portableLogFilename(activeLogId);
      const html = await createPortableLogDocument({
        logId: activeLogId,
        content,
        analysis,
        customMarkers,
        initiallyFolded: readerPreferences.foldMode === "folded",
        initialWrapLines: readerPreferences.wrapLines,
        initialOutlineWrapLines: readerPreferences.outlineWrapLines
      });
      const path = await savePortableLogHtml(filename, html);
      setPortableExportNotice(path ? `离线阅读页已保存：${path}` : `已导出 ${filename}`);
    } catch (error) {
      setPortableExportNotice(`导出失败：${errorMessage(error)}`);
    } finally {
      setExportingPortable(false);
    }
  };

  if (!logId) return null;
  return <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="drawer log-reader-drawer" style={{ width: `${widthRatio * 100}vw` }} onMouseDown={(event) => event.stopPropagation()}>
      <div className="log-reader-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整日志阅读器宽度" aria-valuemin={Math.round(Math.min(520 / window.innerWidth, .88) * 100)} aria-valuemax={88} aria-valuenow={Math.round(widthRatio * 100)} tabIndex={0} onPointerDown={startResize} onKeyDown={adjustReaderWidth} />
      <div className="drawer-heading"><div><span className="eyebrow">TRANSACTION LOG</span><h2>日志阅读器</h2><div className="log-reader-title-line"><code>{logId}</code><button type="button" className="portable-log-export" disabled={loading || !content || exportingPortable} aria-busy={exportingPortable} title="导出可在浏览器中离线打开的只读日志页面" onClick={() => void exportPortableReader()}>{exportingPortable ? <span className="button-spinner" aria-hidden="true" /> : <DownloadIcon />}<span>{exportingPortable ? "正在生成阅读页…" : "导出阅读页"}</span></button></div>{portableExportNotice && <span className="portable-log-export-notice" role="status">{portableExportNotice}</span>}</div><button title="关闭阅读器" aria-label="关闭阅读器" onClick={onClose}><CloseIcon /></button></div>
      <div className="log-reader-controls">
        <div className={`log-reader-search-group${searchResult.error ? " has-error" : ""}`}>
          <label className="log-reader-search"><SearchIcon /><input ref={searchInputRef} autoFocus value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); } }} placeholder={regexSearch ? "输入正则表达式查询日志" : "查询日志内容"} aria-label="查询日志内容" aria-keyshortcuts="Meta+F Alt+F" aria-invalid={Boolean(searchResult.error)} aria-describedby={searchResult.error ? "log-reader-search-error" : undefined} /></label>
          <button type="button" className={`regex-search-toggle${regexSearch ? " is-active" : ""}`} aria-pressed={regexSearch} aria-label="使用正则表达式查询" title={regexSearch ? "关闭正则表达式查询" : "启用正则表达式查询（不区分大小写）"} onClick={() => updateReaderPreferences({ regexSearch: !regexSearch })}><span aria-hidden="true">.*</span></button>
          <button type="button" className="add-custom-marker" disabled={!markerQuery || Boolean(markerQueryError) || customMarkers.length >= MAX_CUSTOM_LOG_MARKERS} aria-label="将当前查询添加为自定义标记" title={customMarkers.length >= MAX_CUSTOM_LOG_MARKERS ? `最多保存 ${MAX_CUSTOM_LOG_MARKERS} 个自定义标记` : "保存为自定义标记"} onClick={addCustomMarker}><MarkerAddIcon /></button>
        </div>
        {query && <span id={searchResult.error ? "log-reader-search-error" : undefined} className={matches.length && !searchResult.error ? "match-count" : "match-count no-match"}>{searchResult.error ?? (matches.length ? `${visibleActiveMatch + 1} / ${matches.length === MAX_LOG_SEARCH_MATCHES ? `${MAX_LOG_SEARCH_MATCHES}+` : matches.length}` : "未找到匹配内容")}</span>}
        <div className="match-navigation"><button disabled={!matches.length} title="上一个命中（Shift + Enter）" onClick={() => moveMatch(-1)}>上一个</button><button disabled={!matches.length} title="下一个命中（Enter）" onClick={() => moveMatch(1)}>下一个</button></div>
        <label className="wrap-toggle"><input type="checkbox" checked={wrapLines} onChange={(event) => updateReaderPreferences({ wrapLines: event.target.checked })} />自动换行</label>
        {keyword && <button className="clear-reader-search" onClick={() => setKeyword("")}>清除</button>}
      </div>
      {!loading && content && <div className="log-reader-insights-shell" onPointerDown={(event) => event.stopPropagation()}>
        <div className="log-reader-insights" aria-label="日志分析摘要">
          <div className="built-in-marker-track">
            <span className="reader-performance" title="远程时间包含 Kibana 查询、VPN 传输和正文接收">{cached ? <><b>缓存</b> 即时加载</> : <><b>{((remoteDurationMs ?? 0) / 1000).toFixed(2)}s</b> 远程</>} · <b>{analyzed.durationMs.toFixed(0)}ms</b> 解析</span>
            <span><b>{analysis.stats.lines.toLocaleString()}</b> 行</span>
            <button type="button" data-log-outline-trigger className={outlineCategory === "service" ? "is-active" : undefined} title="查看微服务入口 Outline" onClick={() => toggleOutline("service")}><b>{analysis.stats.services}</b> 微服务</button>
            <button type="button" data-log-outline-trigger className={outlineCategory === "call" ? "is-active" : undefined} title="查看调用标记 Outline" onClick={() => toggleOutline("call")}><b>{analysis.stats.calls}</b> 调用标记</button>
            <button type="button" data-log-outline-trigger className={outlineCategory === "sql" ? "is-active" : undefined} title="查看 SQL Outline" onClick={() => toggleOutline("sql")}><b>{analysis.stats.sql}</b> SQL</button>
            <button type="button" data-log-outline-trigger className={`${analysis.stats.failedResults ? "has-errors" : ""}${outlineCategory === "failed-result" ? " is-active" : ""}`} title="查看失败线索 Outline" onClick={() => toggleOutline("failed-result")}><b>{analysis.stats.failedResults}</b> 失败线索</button>
            <button type="button" data-log-outline-trigger className={`${analysis.stats.exceptions ? "has-errors" : ""}${outlineCategory === "exception" ? " is-active" : ""}`} title="查看异常 Outline" onClick={() => toggleOutline("exception")}><b>{analysis.stats.exceptions}</b> ERROR/异常</button>
            <button type="button" data-log-outline-trigger className={outlineCategory === "structured" ? "is-active" : undefined} title="查看结构块 Outline" onClick={() => toggleOutline("structured")}><b>{analysis.stats.structured}</b> 结构块</button>
          </div>
          <CustomMarkerSectionResizeHandle ratio={customMarkerWidthRatio} onChange={setCustomMarkerWidthRatio} onCommit={storeCustomMarkerWidthRatio} />
          <CustomLogMarkerShelf ref={customMarkerShelfRef} markers={customMarkers} activeMarkerId={activeCustomMarkerId} widthRatio={customMarkerWidthRatio} onChange={replaceCustomMarkers} onOpen={openCustomMarker} />
          <div className="log-reader-fold-actions"><button title="折叠全部结构，并在下次打开日志时继续使用" onClick={() => applyFoldMode("folded")}>全部折叠</button><button title="展开全部结构，并在下次打开日志时继续使用" onClick={() => applyFoldMode("expanded")}>全部展开</button></div>
        </div>
      </div>}
      {loading && <div className="log-reader-status log-reader-loading" role="status" aria-live="polite"><div className="log-reader-loading-visual" aria-hidden="true"><i /><i /><i /><i /><b /></div><strong>正在读取日志文件…</strong><span>正在从交易日志索引加载文本内容</span></div>}
      {!loading && !content && <div className="log-reader-status">当前时间范围内未找到日志内容。</div>}
      {!loading && content && <div className="log-reader-body" ref={logReaderBodyRef}>
        <StructuredLogViewer ref={viewerRef} analysis={analysis} content={content} matches={matches} activeMatch={visibleActiveMatch} wrapLines={wrapLines} foldMode={readerPreferences.foldMode} />
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
        {activeCustomMarker && customOutline && <LogOutlinePopover
          boundsRef={logReaderBodyRef}
          category="call"
          title={activeCustomMarker.label}
          eyebrow={`CUSTOM MARKER · ${activeCustomMarker.rules.length} ${activeCustomMarker.rules.length === 1 ? "RULE" : "RULES"}`}
          items={customOutline.items}
          content={content}
          highlights={customOutline.highlights}
          highlightMode="all"
          wrapLines={readerPreferences.outlineWrapLines}
          onClose={() => setActiveCustomMarkerId(undefined)}
          onJump={jumpFromOutline}
          onWrapLinesChange={(outlineWrapLines) => updateReaderPreferences({ outlineWrapLines })}
        />}
      </div>}
    </aside>
  </div>;
});

TransactionLogDrawer.displayName = "TransactionLogDrawer";

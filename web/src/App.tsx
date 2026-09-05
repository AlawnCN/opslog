import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { desktopMode, errorMessage, exportLogs, importEnvironmentConfig, loadEnvironments, searchLogs } from "./api";
import { initialFilters, initialPageSize, PAGE_SIZE_KEY, PAGE_SIZES } from "./app-defaults";
import { DataTable } from "./components/DataTable";
import { FilterPanel } from "./components/FilterPanel";
import { Header } from "./components/Header";
import { Navigation } from "./components/Navigation";
import { TraceDrawer } from "./components/TraceDrawer";
import { keepLoadingFeedbackVisible, MINIMUM_LOADING_FEEDBACK_MS } from "./loading-feedback";
import { OpsLogSessionCache, searchCacheKey } from "./opslog-session-cache";
import { nairobiLocal, toUtcIso } from "./time";
import type { Environment, LogKind, SearchFilters, SearchRequest, SearchResponse } from "./types";
import { useLogResources } from "./use-log-resources";

const TransactionLogDrawer = lazy(() => import("./components/TransactionLogDrawer")
  .then(({ TransactionLogDrawer: component }) => ({ default: component })));

export default function App() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentName, setEnvironmentName] = useState("");
  const [kind, setKind] = useState<LogKind>("transaction");
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [selectedRangeDays, setSelectedRangeDays] = useState<number | null>(1);
  const [result, setResult] = useState<SearchResponse>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [loading, setLoading] = useState(false);
  const [searchPerformance, setSearchPerformance] = useState<{ durationMs: number; cached: boolean }>();
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string }>();
  const controller = useRef<AbortController | undefined>(undefined);
  const searchRunId = useRef(0);
  const sessionCache = useRef(new OpsLogSessionCache());

  const environment = environments.find((item) => item.name === environmentName);

  const reloadEnvironments = async () => {
    try {
      const items = await loadEnvironments();
      const selected = items.some((item) => item.name === environmentName) ? environmentName : (items[0]?.name ?? "");
      setEnvironments(items);
      setEnvironmentName(selected);
      setFilters((current) => ({ ...current, index: items.find((item) => item.name === selected)?.applogIndex ?? "" }));
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    }
  };

  useEffect(() => {
    void reloadEnvironments();
  }, []);

  const importConfig = async (file: File) => {
    try {
      const path = await importEnvironmentConfig(await file.text());
      await reloadEnvironments();
      setNotice({ tone: "info", text: `环境配置已导入：${path}` });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    }
  };

  useEffect(() => {
    setResult(undefined);
    setSearchPerformance(undefined);
    setPage(1);
    if (kind === "generic" && environment) setFilters((current) => ({ ...current, index: environment.applogIndex }));
  }, [kind, environmentName]);

  const request = useMemo<SearchRequest | undefined>(() => {
    if (!environmentName) return undefined;
    try {
      const { startLocal, endLocal, minDurationMs, ...fields } = filters;
      return {
        ...fields,
        environment: environmentName,
        kind,
        startTime: toUtcIso(startLocal),
        endTime: toUtcIso(endLocal),
        page,
        pageSize,
        minDurationMs: minDurationMs ? Number(minDurationMs) : undefined
      };
    } catch {
      return undefined;
    }
  }, [environmentName, filters, kind, page, pageSize]);
  const logResources = useLogResources({ environmentName, request, cache: sessionCache.current, onNotice: setNotice });

  const runSearch = async (targetPage = 1, targetPageSize = pageSize, forceRefresh = false) => {
    if (!request) { setNotice({ tone: "error", text: "请选择环境并填写有效时间范围" }); return; }
    const runId = ++searchRunId.current;
    controller.current?.abort();
    const nextRequest = { ...request, page: targetPage, pageSize: targetPageSize };
    const cacheKey = searchCacheKey(nextRequest);
    if (forceRefresh) sessionCache.current.clearSearch();
    const cached = forceRefresh ? undefined : sessionCache.current.getSearch(cacheKey);
    const startedAt = performance.now();
    if (cached) {
      setLoading(true);
      setNotice(undefined);
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.search);
      if (runId !== searchRunId.current) return;
      setPage(targetPage);
      setPageSize(targetPageSize);
      setResult(cached);
      setSearchPerformance({ durationMs: 0, cached: true });
      setLoading(false);
      return;
    }
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setNotice(undefined);
    try {
      const response = await searchLogs(nextRequest, nextController.signal);
      const remoteDurationMs = performance.now() - startedAt;
      sessionCache.current.saveSearch(cacheKey, response);
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.search);
      if (runId !== searchRunId.current) return;
      setPage(targetPage);
      setPageSize(targetPageSize);
      setResult(response);
      setSearchPerformance({ durationMs: remoteDurationMs, cached: false });
      if (response.truncated) setNotice({ tone: "info", text: "已达到 10,000 条交互查询深度，请增加筛选条件或使用导出。" });
    } catch (error) {
      if (runId === searchRunId.current) {
        await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.search);
      }
      if (runId === searchRunId.current && !(error instanceof Error && error.name === "AbortError")) {
        setNotice({ tone: "error", text: errorMessage(error) });
      }
    } finally {
      if (runId === searchRunId.current) setLoading(false);
    }
  };

  const updateFilter = (field: keyof SearchFilters, value: string) => {
    if (field === "startLocal" || field === "endLocal") {
      setSelectedRangeDays(null);
    }
    setFilters((current) => ({ ...current, [field]: value }));
  };
  const changePageSize = (next: number) => {
    localStorage.setItem(PAGE_SIZE_KEY, String(next));
    void runSearch(1, next, true);
  };
  const setRange = (days: number) => {
    const end = new Date();
    setSelectedRangeDays(days);
    setFilters((current) => ({ ...current, startLocal: nairobiLocal(new Date(end.getTime() - days * 86_400_000)), endLocal: nairobiLocal(end) }));
  };
  const exportCurrent = async () => {
    if (!request) return;
    setLoading(true);
    try {
      const path = await exportLogs({ ...request, page: 1 });
      if (path) setNotice({ tone: "info", text: `CSV 已保存：${path}` });
    }
    catch (error) { setNotice({ tone: "error", text: errorMessage(error) }); }
    finally { setLoading(false); }
  };
  return <div className="app-shell">
    <Header environments={environments} selected={environmentName} onSelect={setEnvironmentName} loading={loading} desktopMode={desktopMode} onImportConfig={importConfig} />
    <Navigation active={kind} onChange={setKind} />
    <main>
      <FilterPanel kind={kind} filters={filters} environment={environment} loading={loading} selectedRangeDays={selectedRangeDays} onChange={updateFilter} onSearch={() => runSearch(1, pageSize, true)} onExport={exportCurrent} onRange={setRange} />
      {notice && <div className={`notice ${notice.tone}`}><i />{notice.text}<button onClick={() => setNotice(undefined)}>×</button></div>}
      <DataTable kind={kind} result={result} loading={loading} queryPerformance={searchPerformance} onTransactionLog={logResources.downloadLog} onReadTransactionLog={logResources.openLog} onTrace={logResources.openTrace} />
      {result && <div className="pagination"><span>第 <strong>{page}</strong> 页 · 每页 <select value={pageSize} disabled={loading} onChange={(event) => changePageSize(Number(event.target.value))}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size} 条</option>)}</select></span><div><button disabled={loading || page <= 1} onClick={() => runSearch(page - 1)}>上一页</button><button disabled={loading || !result.hasMore} onClick={() => runSearch(page + 1)}>下一页</button></div></div>}
    </main>
    <TraceDrawer traceId={logResources.trace?.id} rows={logResources.trace?.rows ?? []} loading={logResources.trace?.loading ?? false} remoteDurationMs={logResources.trace?.remoteDurationMs} cached={logResources.trace?.cached} onClose={logResources.closeTrace} />
    {logResources.transactionLog && <Suspense fallback={null}><TransactionLogDrawer logId={logResources.transactionLog.id} content={logResources.transactionLog.content} loading={logResources.transactionLog.loading} remoteDurationMs={logResources.transactionLog.remoteDurationMs} cached={logResources.transactionLog.cached} onClose={logResources.closeLog} /></Suspense>}
  </div>;
}

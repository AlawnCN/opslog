import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopMode, errorMessage, exportLogs, importEnvironmentConfig, loadEnvironmentConfiguration, loadEnvironments, loadWebRuntimeInfo, searchLogs, releaseSshConnections } from "./api";
import { initialFilters, initialPageSize, PAGE_SIZE_KEY, PAGE_SIZES } from "./app-defaults";
import { DataTable } from "./components/DataTable";
import { AppSelect } from "./components/AppSelect";
import { FilterPanel, type FilterPanelHandle } from "./components/FilterPanel";
import { Header } from "./components/Header";
import { EnvironmentConfigurationDialog } from "./components/EnvironmentConfigurationDialog";
import { Navigation } from "./components/Navigation";
import { TraceDrawer } from "./components/TraceDrawer";
import { UpdateDialog } from "./components/UpdateDialog";
import { keepLoadingFeedbackVisible, MINIMUM_LOADING_FEEDBACK_MS } from "./loading-feedback";
import { OpsLogSessionCache, searchCacheKey } from "./opslog-session-cache";
import { DEFAULT_TIME_ZONE, rollingTimeZoneRange, toUtcIso, zonedLocal } from "./time";
import type { Environment, EnvironmentConfiguration, LogKind, SearchFilters, SearchRequest, SearchResponse } from "./types";
import { useAppUpdater } from "./use-app-updater";
import { useLogResources } from "./use-log-resources";
import { isEditableFocusTarget, isQueryFocusShortcut } from "./keyboard-shortcuts";
import { useLanShare } from "./use-lan-share";
import { classifySearchWarnings } from "./search-warnings";
import { parseSshHostKeyChallenge, trustSshHostKey, type SshHostKeyChallenge } from "./ssh-host-key";
import { SshHostKeyDialog } from "./components/SshHostKeyDialog";
import type { TransactionLogDrawerHandle } from "./components/TransactionLogDrawer";

const TransactionLogDrawer = lazy(() => import("./components/TransactionLogDrawer")
  .then(({ TransactionLogDrawer: component }) => ({ default: component })));

export default function App() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentName, setEnvironmentName] = useState("");
  const connectionEnvironment = useRef("");
  useEffect(() => {
    const previous = connectionEnvironment.current;
    connectionEnvironment.current = environmentName;
    if (previous && previous !== environmentName) {
      void releaseSshConnections(previous).catch((error: unknown) => {
        console.warn("SSH 旧环境连接释放失败；将按空闲超时回收", errorMessage(error));
      });
    }
  }, [environmentName]);
  const [kind, setKind] = useState<LogKind>("transaction");
  const [filters, setFilters] = useState<SearchFilters>(initialFilters);
  const [selectedRangeDays, setSelectedRangeDays] = useState<number | null>(1);
  const [result, setResult] = useState<SearchResponse>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchPerformance, setSearchPerformance] = useState<{ durationMs: number; cached: boolean }>();
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string }>();
  const [pendingHostKey, setPendingHostKey] = useState<(SshHostKeyChallenge & { page: number; pageSize: number; environment: string })>();
  const [hostKeyBusy, setHostKeyBusy] = useState(false);
  const [canImportConfig, setCanImportConfig] = useState(desktopMode);
  const [environmentConfigOpen, setEnvironmentConfigOpen] = useState(false);
  const [environmentConfiguration, setEnvironmentConfiguration] = useState<EnvironmentConfiguration[]>([]);
  const [environmentConfigLoading, setEnvironmentConfigLoading] = useState(false);
  const [environmentConfigSaving, setEnvironmentConfigSaving] = useState(false);
  const [environmentConfigError, setEnvironmentConfigError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);
  const searchRunId = useRef(0);
  const sessionCache = useRef(new OpsLogSessionCache());
  const filterPanelRef = useRef<FilterPanelHandle>(null);
  const transactionLogDrawerRef = useRef<TransactionLogDrawerHandle>(null);
  const previousTimeZoneRef = useRef(DEFAULT_TIME_ZONE);

  useEffect(() => () => { controller.current?.abort(); }, []);

  const environment = environments.find((item) => item.name === environmentName);
  const environmentTimeZone = environment?.timeZone || DEFAULT_TIME_ZONE;
  const notifyCurrentVersion = useCallback(() => {
    setNotice({ tone: "info", text: "当前已是最新版本。" });
  }, []);
  const notifyUpdateError = useCallback((message: string) => {
    setNotice({ tone: "error", text: `检查更新失败：${message}` });
  }, []);
  const appUpdater = useAppUpdater({
    enabled: desktopMode,
    onCurrent: notifyCurrentVersion,
    onError: notifyUpdateError
  });
  const lanShare = useLanShare(desktopMode);

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
    if (!desktopMode) {
      void loadWebRuntimeInfo().then((runtime) => setCanImportConfig(runtime.canImportConfig));
    }
  }, []);

  const openEnvironmentConfiguration = async () => {
    setEnvironmentConfigOpen(true);
    setEnvironmentConfigLoading(true);
    setEnvironmentConfigError(undefined);
    try {
      setEnvironmentConfiguration(await loadEnvironmentConfiguration());
    } catch (error) {
      setEnvironmentConfigError(errorMessage(error));
    } finally {
      setEnvironmentConfigLoading(false);
    }
  };

  const saveEnvironmentConfiguration = async (items: EnvironmentConfiguration[]) => {
    setEnvironmentConfigSaving(true);
    setEnvironmentConfigError(undefined);
    try {
      const path = await importEnvironmentConfig(JSON.stringify(items, null, 2));
      setEnvironmentConfiguration(items);
      await reloadEnvironments();
      setEnvironmentConfigOpen(false);
      setNotice({ tone: "info", text: `运行环境配置已保存：${path}` });
    } catch (error) {
      setEnvironmentConfigError(errorMessage(error));
    } finally {
      setEnvironmentConfigSaving(false);
    }
  };

  useEffect(() => {
    setResult(undefined);
    ++searchRunId.current;
    controller.current?.abort();
    controller.current = undefined;
    setLoading(false);
    setSearching(false);
    setSearchPerformance(undefined);
    setPage(1);
    if (environment) setFilters((current) => {
      const previousTimeZone = previousTimeZoneRef.current;
      const range = selectedRangeDays
        ? rollingTimeZoneRange(selectedRangeDays, environmentTimeZone)
        : {
            startLocal: zonedLocal(new Date(toUtcIso(current.startLocal, previousTimeZone)), environmentTimeZone),
            endLocal: zonedLocal(new Date(toUtcIso(current.endLocal, previousTimeZone)), environmentTimeZone)
          };
      previousTimeZoneRef.current = environmentTimeZone;
      return {
        ...current,
        ...range,
        ...(kind === "generic" ? { index: environment.applogIndex } : {}),
        application: environment.sourceType === "ssh" ? environment.sshApplications[0] ?? "" : "",
        ...(environment.sourceType === "ssh" ? { traceId: "" } : {})
      };
    });
  }, [kind, environmentName, environmentTimeZone]);

  const request = useMemo<SearchRequest | undefined>(() => {
    if (!environmentName) return undefined;
    try {
      const { startLocal, endLocal, minDurationMs, ...fields } = filters;
      return {
        ...fields,
        environment: environmentName,
        kind,
        startTime: toUtcIso(startLocal, environmentTimeZone),
        endTime: toUtcIso(endLocal, environmentTimeZone),
        page,
        pageSize,
        minDurationMs: minDurationMs ? Number(minDurationMs) : undefined
      };
    } catch {
      return undefined;
    }
  }, [environmentName, environmentTimeZone, filters, kind, page, pageSize]);
  const logResources = useLogResources({ environmentName, request, cache: sessionCache.current, onNotice: setNotice });

  useEffect(() => {
    const handleKeyboardShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      if (event.key === "Escape") {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && isEditableFocusTarget(activeElement)) {
          event.preventDefault();
          activeElement.blur();
          return;
        }
        if (appUpdater.state.visible) {
          event.preventDefault();
          appUpdater.dismissUpdater();
          return;
        }
        if (environmentConfigOpen) {
          event.preventDefault();
          // The configuration dialog owns Escape and its unsaved-draft guard.
          return;
        }
        if (logResources.transactionLog) {
          event.preventDefault();
          transactionLogDrawerRef.current?.closeTopLayer();
          return;
        }
        if (logResources.trace) {
          event.preventDefault();
          logResources.closeTrace();
        }
        return;
      }

      if (!isQueryFocusShortcut(event) || appUpdater.state.visible || logResources.trace) return;
      event.preventDefault();
      if (logResources.transactionLog) transactionLogDrawerRef.current?.focusSearch();
      else filterPanelRef.current?.focusQuery();
    };

    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, [appUpdater, environmentConfigOpen, environmentConfigSaving, logResources]);

  const runSearch = async (targetPage = 1, targetPageSize = pageSize, forceRefresh = false, refreshSelectedRange = false) => {
    let activeRequest = request;
    if (activeRequest && refreshSelectedRange && selectedRangeDays !== null) {
      const range = rollingTimeZoneRange(selectedRangeDays, environmentTimeZone);
      setFilters((current) => ({ ...current, ...range }));
      activeRequest = { ...activeRequest, startTime: toUtcIso(range.startLocal, environmentTimeZone), endTime: toUtcIso(range.endLocal, environmentTimeZone) };
    }
    if (!activeRequest) { setNotice({ tone: "error", text: "请选择环境并填写有效时间范围" }); return; }
    const runId = ++searchRunId.current;
    setSearching(true);
    controller.current?.abort();
    const nextRequest = { ...activeRequest, page: targetPage, pageSize: targetPageSize };
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
      const challenge = cached.warnings?.map(parseSshHostKeyChallenge).find(Boolean);
      if (challenge) setPendingHostKey({ ...challenge, environment: environmentName, page: targetPage, pageSize: targetPageSize });
      const { failures } = classifySearchWarnings(cached.warnings);
      if (failures.length && !challenge) setNotice({ tone: "error", text: `部分服务器查询失败，结果不完整：${failures.join("；")}` });
      setSearchPerformance({ durationMs: 0, cached: true });
      setLoading(false);
      setSearching(false);
      return;
    }
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setNotice(undefined);
    try {
      const response = await searchLogs(nextRequest, nextController.signal);
      if (runId !== searchRunId.current || nextController.signal.aborted) return;
      const challenge = response.warnings?.map(parseSshHostKeyChallenge).find(Boolean);
      const remoteDurationMs = performance.now() - startedAt;
      if (!challenge) sessionCache.current.saveSearch(cacheKey, response);
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.search);
      if (runId !== searchRunId.current) return;
      setPage(targetPage);
      setPageSize(targetPageSize);
      setResult(response);
      setSearchPerformance({ durationMs: remoteDurationMs, cached: false });
      const { failures } = classifySearchWarnings(response.warnings);
      if (challenge) setPendingHostKey({ ...challenge, environment: environmentName, page: targetPage, pageSize: targetPageSize });
      else if (failures.length) setNotice({ tone: "error", text: `部分服务器查询失败，结果不完整：${failures.join("；")}` });
      else if (response.truncated) setNotice({ tone: "info", text: "已达到 10,000 条交互查询深度，请增加筛选条件或使用导出。" });
    } catch (error) {
      if (runId === searchRunId.current) {
        await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.search);
      }
      if (runId === searchRunId.current && !(error instanceof Error && error.name === "AbortError")) {
        const message = errorMessage(error);
        const challenge = parseSshHostKeyChallenge(message);
        if (challenge) setPendingHostKey({ ...challenge, environment: environmentName, page: targetPage, pageSize: targetPageSize });
        else setNotice({ tone: "error", text: message });
      }
    } finally {
      if (runId === searchRunId.current) {
        controller.current = undefined;
        setLoading(false);
        setSearching(false);
      }
    }
  };

  const cancelSearch = () => {
    ++searchRunId.current;
    controller.current?.abort();
    controller.current = undefined;
    setLoading(false);
    setSearching(false);
    setNotice({ tone: "info", text: "查询已终止，可调整条件后重新查询。" });
  };

  const approveHostKey = async () => {
    const pending = pendingHostKey;
    if (!pending) return;
    setHostKeyBusy(true);
    try {
      const items = await loadEnvironmentConfiguration();
      const next = items.map((item) => item.name === pending.environment ? {
        ...item,
        sshServers: trustSshHostKey(item.sshServers ?? [], pending)
      } : item);
      if (!items.some((item) => item.name === pending.environment)) throw new Error("运行环境已变更，请重新查询");
      await importEnvironmentConfig(JSON.stringify(next));
      await reloadEnvironments();
      setPendingHostKey(undefined);
      setNotice(undefined);
      void runSearch(pending.page, pending.pageSize, true);
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setHostKeyBusy(false);
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
    setSelectedRangeDays(days);
    setFilters((current) => ({ ...current, ...rollingTimeZoneRange(days, environmentTimeZone) }));
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
    <Header environments={environments} selected={environmentName} onSelect={setEnvironmentName} loading={loading} desktopMode={desktopMode} canImportConfig={canImportConfig} lanShare={lanShare} onConfigure={() => void openEnvironmentConfiguration()} updateAvailable={appUpdater.state.phase === "available" || appUpdater.state.phase === "error"} updateBusy={appUpdater.state.phase === "checking" || appUpdater.state.phase === "downloading" || appUpdater.state.phase === "installing"} onCheckForUpdates={appUpdater.checkForUpdates} />
    <Navigation active={kind} onChange={setKind} environment={environment} />
    <main>
      <FilterPanel ref={filterPanelRef} kind={kind} filters={filters} environment={environment} loading={loading} searching={searching} onCancel={cancelSearch} selectedRangeDays={selectedRangeDays} onChange={updateFilter} onSearch={() => runSearch(1, pageSize, true, true)} onExport={exportCurrent} onRange={setRange} />
      {notice && <div className={`notice ${notice.tone}`}><i />{notice.text}<button onClick={() => setNotice(undefined)}>×</button></div>}
      <DataTable kind={kind} result={result} loading={loading} queryPerformance={searchPerformance} onTransactionLog={logResources.downloadLog} onReadTransactionLog={logResources.openLog} onTrace={logResources.openTrace} traceEnabled={environment?.sourceType !== "ssh"} timeZone={environmentTimeZone} />
      {result && <div className="pagination"><span>第 <strong>{page}</strong> 页 · 每页 <AppSelect value={String(pageSize)} disabled={loading} ariaLabel="每页记录数" options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} 条` }))} onChange={(value) => changePageSize(Number(value))} /></span><div><button disabled={loading || page <= 1} onClick={() => runSearch(page - 1)}>上一页</button><button disabled={loading || !result.hasMore} onClick={() => runSearch(page + 1)}>下一页</button></div></div>}
    </main>
    <TraceDrawer traceId={logResources.trace?.id} rows={logResources.trace?.rows ?? []} loading={logResources.trace?.loading ?? false} remoteDurationMs={logResources.trace?.remoteDurationMs} cached={logResources.trace?.cached} onClose={logResources.closeTrace} timeZone={environmentTimeZone} />
    {logResources.transactionLog && <Suspense fallback={null}><TransactionLogDrawer ref={transactionLogDrawerRef} logId={logResources.transactionLog.id} content={logResources.transactionLog.content} loading={logResources.transactionLog.loading} remoteDurationMs={logResources.transactionLog.remoteDurationMs} cached={logResources.transactionLog.cached} onClose={logResources.closeLog} /></Suspense>}
    {environmentConfigOpen && <EnvironmentConfigurationDialog environments={environmentConfiguration} activeEnvironmentName={environmentName} loading={environmentConfigLoading} saving={environmentConfigSaving} error={environmentConfigError} onClose={() => setEnvironmentConfigOpen(false)} onSave={(items) => void saveEnvironmentConfiguration(items)} />}
    {pendingHostKey && <SshHostKeyDialog challenge={pendingHostKey} busy={hostKeyBusy} onCancel={() => setPendingHostKey(undefined)} onConfirm={() => void approveHostKey()} />}
    <UpdateDialog state={appUpdater.state} onInstall={() => void appUpdater.installUpdate()} onDismiss={appUpdater.dismissUpdater} />
  </div>;
}

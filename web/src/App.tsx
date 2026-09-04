import { useEffect, useMemo, useRef, useState } from "react";
import { desktopMode, downloadTransactionLog, errorMessage, exportLogs, importEnvironmentConfig, loadEnvironments, loadTrace, readTransactionLog, searchLogs } from "./api";
import { DataTable } from "./components/DataTable";
import { FilterPanel } from "./components/FilterPanel";
import { Header } from "./components/Header";
import { Navigation } from "./components/Navigation";
import { TraceDrawer } from "./components/TraceDrawer";
import { TransactionLogDrawer } from "./components/TransactionLogDrawer";
import { nairobiLocal, toUtcIso } from "./time";
import type { Environment, LogKind, SearchFilters, SearchRequest, SearchResponse } from "./types";

const PAGE_SIZE_KEY = "opslog.page-size.v1";
const PAGE_SIZES = [50, 100, 500] as const;

const initialPageSize = (): number => {
  const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return PAGE_SIZES.includes(saved as (typeof PAGE_SIZES)[number]) ? saved : 50;
};

const initialFilters = (): SearchFilters => {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return {
    startLocal: nairobiLocal(start), endLocal: nairobiLocal(end), index: "", txnId: "", traceId: "",
    txnNo: "", business: "", service: "", messageCode: "", messageInfo: "", status: "ALL",
    minDurationMs: "", node: "", keyword: "", level: "", file: "", application: ""
  };
};

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
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string }>();
  const [trace, setTrace] = useState<{ id: string; rows: Record<string, unknown>[]; loading: boolean }>();
  const [transactionLog, setTransactionLog] = useState<{ id: string; content: string; loading: boolean }>();
  const controller = useRef<AbortController | undefined>(undefined);

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

  const runSearch = async (targetPage = 1, targetPageSize = pageSize) => {
    if (!request) { setNotice({ tone: "error", text: "请选择环境并填写有效时间范围" }); return; }
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setNotice(undefined);
    try {
      const response = await searchLogs({ ...request, page: targetPage, pageSize: targetPageSize }, nextController.signal);
      setPage(targetPage);
      setPageSize(targetPageSize);
      setResult(response);
      if (response.truncated) setNotice({ tone: "info", text: "已达到 10,000 条交互查询深度，请增加筛选条件或使用导出。" });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setNotice({ tone: "error", text: errorMessage(error) });
      }
    } finally { setLoading(false); }
  };

  const updateFilter = (field: keyof SearchFilters, value: string) => {
    if (field === "startLocal" || field === "endLocal") {
      setSelectedRangeDays(null);
    }
    setFilters((current) => ({ ...current, [field]: value }));
  };
  const changePageSize = (next: number) => {
    localStorage.setItem(PAGE_SIZE_KEY, String(next));
    void runSearch(1, next);
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
  const downloadTrc = async (row: Record<string, unknown>) => {
    if (!request) return;
    const id = String(row["ecp.txn.id"] ?? "");
    if (!id) return;
    try {
      const path = await downloadTransactionLog(environmentName, id, request.startTime, request.endTime);
      if (path) setNotice({ tone: "info", text: `交易日志已保存：${path}` });
    }
    catch (error) { setNotice({ tone: "error", text: errorMessage(error) }); }
  };
  const openTransactionLog = async (row: Record<string, unknown>) => {
    if (!request) return;
    const id = String(row["ecp.txn.id"] ?? "");
    if (!id) return;
    setTransactionLog({ id, content: "", loading: true });
    try {
      const content = await readTransactionLog(environmentName, id, request.startTime, request.endTime);
      setTransactionLog({ id, content, loading: false });
    } catch (error) {
      setTransactionLog(undefined);
      setNotice({ tone: "error", text: errorMessage(error) });
    }
  };
  const openTrace = async (row: Record<string, unknown>) => {
    if (!request) return;
    const id = String(row["ecp.txn.trace"] ?? row["trace.id"] ?? "");
    if (!id) return;
    setTrace({ id, rows: [], loading: true });
    try { setTrace({ id, rows: await loadTrace(environmentName, id, request.startTime, request.endTime), loading: false }); }
    catch (error) { setTrace(undefined); setNotice({ tone: "error", text: errorMessage(error) }); }
  };

  return <div className="app-shell">
    <Header environments={environments} selected={environmentName} onSelect={setEnvironmentName} loading={loading} desktopMode={desktopMode} onImportConfig={importConfig} />
    <Navigation active={kind} onChange={setKind} />
    <main>
      <FilterPanel kind={kind} filters={filters} environment={environment} loading={loading} selectedRangeDays={selectedRangeDays} onChange={updateFilter} onSearch={() => runSearch(1)} onExport={exportCurrent} onRange={setRange} />
      {notice && <div className={`notice ${notice.tone}`}><i />{notice.text}<button onClick={() => setNotice(undefined)}>×</button></div>}
      <DataTable kind={kind} result={result} loading={loading} onTransactionLog={downloadTrc} onReadTransactionLog={openTransactionLog} onTrace={openTrace} />
      {result && <div className="pagination"><span>第 <strong>{page}</strong> 页 · 每页 <select value={pageSize} disabled={loading} onChange={(event) => changePageSize(Number(event.target.value))}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size} 条</option>)}</select></span><div><button disabled={loading || page <= 1} onClick={() => runSearch(page - 1)}>上一页</button><button disabled={loading || !result.hasMore} onClick={() => runSearch(page + 1)}>下一页</button></div></div>}
    </main>
    <TraceDrawer traceId={trace?.id} rows={trace?.rows ?? []} loading={trace?.loading ?? false} onClose={() => setTrace(undefined)} />
    <TransactionLogDrawer logId={transactionLog?.id} content={transactionLog?.content ?? ""} loading={transactionLog?.loading ?? false} onClose={() => setTransactionLog(undefined)} />
  </div>;
}

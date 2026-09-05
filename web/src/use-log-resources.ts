import { useState } from "react";
import { errorMessage, loadTrace, readTransactionLog, saveTransactionLogContent } from "./api";
import { keepLoadingFeedbackVisible, MINIMUM_LOADING_FEEDBACK_MS } from "./loading-feedback";
import { OpsLogSessionCache, traceCacheKey, transactionLogCacheKey } from "./opslog-session-cache";
import type { SearchRequest } from "./types";

interface Notice {
  tone: "error" | "info";
  text: string;
}

interface TraceState {
  id: string;
  rows: Record<string, unknown>[];
  loading: boolean;
  remoteDurationMs?: number;
  cached?: boolean;
}

interface TransactionLogState {
  id: string;
  content: string;
  loading: boolean;
  remoteDurationMs?: number;
  cached?: boolean;
}

interface LogResourcesOptions {
  environmentName: string;
  request?: SearchRequest;
  cache: OpsLogSessionCache;
  onNotice: (notice: Notice) => void;
}

const transactionId = (row: Record<string, unknown>): string => String(row["ecp.txn.id"] ?? "");

export const useLogResources = ({ environmentName, request, cache, onNotice }: LogResourcesOptions) => {
  const [trace, setTrace] = useState<TraceState>();
  const [transactionLog, setTransactionLog] = useState<TransactionLogState>();

  const loadLog = (id: string) => {
    if (!request) return Promise.reject(new Error("查询时间范围不可用"));
    const key = transactionLogCacheKey(environmentName, id, request.startTime, request.endTime);
    return cache.loadTransactionLog(
      key,
      () => readTransactionLog(environmentName, id, request.startTime, request.endTime)
    );
  };

  const downloadLog = async (row: Record<string, unknown>) => {
    const id = transactionId(row);
    if (!request || !id) return;
    try {
      const loaded = await loadLog(id);
      const path = await saveTransactionLogContent(id, loaded.value);
      if (path) onNotice({ tone: "info", text: `交易日志已保存：${path}` });
    } catch (error) {
      onNotice({ tone: "error", text: errorMessage(error) });
    }
  };

  const openLog = async (row: Record<string, unknown>) => {
    const id = transactionId(row);
    if (!request || !id) return;
    setTransactionLog({ id, content: "", loading: true });
    const startedAt = performance.now();
    try {
      const loaded = await loadLog(id);
      const remoteDurationMs = performance.now() - startedAt;
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.transactionLogReader);
      setTransactionLog((current) => current?.id === id
        ? { id, content: loaded.value, loading: false, remoteDurationMs, cached: loaded.cached }
        : current);
    } catch (error) {
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.transactionLogReader);
      setTransactionLog((current) => current?.id === id ? undefined : current);
      onNotice({ tone: "error", text: errorMessage(error) });
    }
  };

  const openTrace = async (row: Record<string, unknown>) => {
    if (!request) return;
    const id = String(row["ecp.txn.trace"] ?? row["trace.id"] ?? "");
    if (!id) return;
    const key = traceCacheKey(environmentName, id, request.startTime, request.endTime);
    setTrace({ id, rows: [], loading: true });
    const startedAt = performance.now();
    try {
      const cached = cache.getTrace(key);
      const rows = cached ?? await loadTrace(environmentName, id, request.startTime, request.endTime);
      const remoteDurationMs = performance.now() - startedAt;
      if (!cached) cache.saveTrace(key, rows);
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.trace);
      setTrace((current) => current?.id === id
        ? { id, rows, loading: false, remoteDurationMs, cached: Boolean(cached) }
        : current);
    } catch (error) {
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.trace);
      setTrace((current) => current?.id === id ? undefined : current);
      onNotice({ tone: "error", text: errorMessage(error) });
    }
  };

  return { trace, transactionLog, downloadLog, openLog, openTrace, closeTrace: () => setTrace(undefined), closeLog: () => setTransactionLog(undefined) };
};

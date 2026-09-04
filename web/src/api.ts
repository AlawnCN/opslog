import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Environment, SearchRequest, SearchResponse } from "./types";

interface SavedFile {
  path: string;
}

export const desktopMode = isTauri();

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "object" && error !== null) {
    for (const key of ["message", "error"]) {
      const value = Reflect.get(error, key);
      if (typeof value === "string" && value.trim()) return value;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized !== "{}") return serialized;
    } catch {
      // Fall through to the stable user-facing fallback.
    }
  }
  return "发生未知错误，请重试或检查本地配置";
};

const desktopInvoke = async <Result>(command: string, args?: Record<string, unknown>): Promise<Result> => {
  try {
    return await invoke<Result>(command, args);
  } catch (error) {
    throw new Error(errorMessage(error));
  }
};

const parseError = async (response: Response): Promise<never> => {
  const body = await response.json().catch(() => ({ error: response.statusText }));
  throw new Error(body.error ?? `请求失败：HTTP ${response.status}`);
};

export const loadEnvironments = async (): Promise<Environment[]> => {
  if (desktopMode) return desktopInvoke<Environment[]>("load_environments");
  const response = await fetch("/api/environments");
  if (!response.ok) return parseError(response);
  return response.json();
};

export const searchLogs = async (request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> => {
  if (desktopMode) return desktopInvoke<SearchResponse>("search_logs", { input: request });
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal
  });
  if (!response.ok) return parseError(response);
  return response.json();
};

const download = async (url: string, request: unknown): Promise<string | undefined> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) return parseError(response);
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const name = disposition.match(/filename="([^"]+)"/)?.[1] ?? "opslog-download";
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  return undefined;
};

export const exportLogs = async (request: SearchRequest): Promise<string | undefined> => {
  if (desktopMode) return (await desktopInvoke<SavedFile>("export_logs", { input: request })).path;
  return download("/api/export", request);
};

export const downloadTransactionLog = (
  environment: string,
  id: string,
  startTime: string,
  endTime: string
): Promise<string | undefined> => {
  const input = { environment, id, startTime, endTime };
  if (desktopMode) return desktopInvoke<SavedFile>("download_transaction_log", { input }).then((result) => result.path);
  return download("/api/transaction-log", input);
};

export const loadTrace = async (
  environment: string,
  id: string,
  startTime: string,
  endTime: string
): Promise<Record<string, unknown>[]> => {
  const input = { environment, id, startTime, endTime };
  if (desktopMode) return desktopInvoke<Record<string, unknown>[]>("load_trace", { input });
  const response = await fetch("/api/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) return parseError(response);
  return (await response.json()).rows;
};

export const importEnvironmentConfig = async (contents: string): Promise<string> => {
  if (!desktopMode) throw new Error("仅桌面版支持导入环境配置");
  return (await desktopInvoke<SavedFile>("save_environment_config", { contents })).path;
};

import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Environment, SearchRequest, SearchResponse } from "./types";

interface SavedFile {
  path: string;
}

export interface LanShareStatus {
  enabled: boolean;
  url?: string | null;
  port?: number | null;
  requiresPasscode?: boolean;
}

export interface WebRuntimeInfo {
  mode: "standalone" | "lan";
  canImportConfig: boolean;
  requiresPasscode?: boolean;
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

const LAN_ACCESS_KEY_STORAGE = "opslog.lanAccessKey";

const lanAccessKey = (): string | null => {
  if (typeof window === "undefined") return null;
  const keyFromUrl = new URLSearchParams(window.location.hash.slice(1)).get("accessKey")?.trim();
  if (keyFromUrl) {
    window.sessionStorage.setItem(LAN_ACCESS_KEY_STORAGE, keyFromUrl);
    return keyFromUrl;
  }
  return window.sessionStorage.getItem(LAN_ACCESS_KEY_STORAGE);
};

const webFetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  const accessKey = lanAccessKey();
  if (accessKey) headers.set("X-OpsLog-LAN-Key", accessKey);
  return fetch(input, { ...init, headers });
};

export const loadEnvironments = async (): Promise<Environment[]> => {
  if (desktopMode) return desktopInvoke<Environment[]>("load_environments");
  const response = await webFetch("/api/environments");
  if (!response.ok) return parseError(response);
  return response.json();
};

export const loadWebRuntimeInfo = async (): Promise<WebRuntimeInfo> => {
  if (desktopMode) return { mode: "standalone", canImportConfig: true };
  const response = await webFetch("/api/runtime");
  if (!response.ok) return { mode: "standalone", canImportConfig: true };
  return response.json();
};

export const getLanShareStatus = async (): Promise<LanShareStatus> => {
  if (!desktopMode) return { enabled: false };
  return desktopInvoke<LanShareStatus>("get_lan_share_status");
};

export const setLanShareEnabled = async (enabled: boolean, requirePasscode = false): Promise<LanShareStatus> => {
  if (!desktopMode) return { enabled: false };
  return desktopInvoke<LanShareStatus>("set_lan_share_enabled", { enabled, requirePasscode });
};

export const loadUpdateReleaseNotes = async (version: string): Promise<string | undefined> => {
  if (!desktopMode) return undefined;
  return (await desktopInvoke<string | null>("load_update_release_notes", { version })) ?? undefined;
};

export const searchLogs = async (request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> => {
  if (desktopMode) return desktopInvoke<SearchResponse>("search_logs", { input: request });
  const response = await webFetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal
  });
  if (!response.ok) return parseError(response);
  return response.json();
};

const download = async (url: string, request: unknown): Promise<string | undefined> => {
  const response = await webFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) return parseError(response);
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const name = disposition.match(/filename="([^"]+)"/)?.[1] ?? "opslog-download";
  saveBrowserBlob(blob, name);
  return undefined;
};

const saveBrowserBlob = (blob: Blob, name: string): void => {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
};

const transactionLogFilename = (id: string): string => {
  const safeId = id.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 180);
  return `${safeId || "transaction-log"}.trc`;
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

export const readTransactionLog = async (
  environment: string,
  id: string,
  startTime: string,
  endTime: string
): Promise<string> => {
  const input = { environment, id, startTime, endTime };
  if (desktopMode) return desktopInvoke<string>("read_transaction_log", { input });
  const response = await webFetch("/api/transaction-log/content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) return parseError(response);
  const data = await response.json() as { content?: unknown };
  return typeof data.content === "string" ? data.content : "";
};

export const saveTransactionLogContent = async (id: string, content: string): Promise<string | undefined> => {
  if (desktopMode) return (await desktopInvoke<SavedFile>("save_transaction_log", { input: { id, content } })).path;
  saveBrowserBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), transactionLogFilename(id));
  return undefined;
};

export const saveCustomLogMarkerExport = async (name: string, contents: string): Promise<string | undefined> => {
  if (desktopMode) return (await desktopInvoke<SavedFile>("save_custom_log_markers", { input: { name, contents } })).path;
  saveBrowserBlob(new Blob([contents], { type: "application/json;charset=utf-8" }), `${name}.json`);
  return undefined;
};

export const savePortableLogHtml = async (name: string, contents: string): Promise<string | undefined> => {
  const filename = name.toLocaleLowerCase().endsWith(".html") ? name : `${name}.html`;
  if (desktopMode) return (await desktopInvoke<SavedFile>("save_portable_log", { input: { name: filename.replace(/\.html$/i, ""), contents } })).path;
  saveBrowserBlob(new Blob([contents], { type: "text/html;charset=utf-8" }), filename);
  return undefined;
};

export const loadTrace = async (
  environment: string,
  id: string,
  startTime: string,
  endTime: string
): Promise<Record<string, unknown>[]> => {
  const input = { environment, id, startTime, endTime };
  if (desktopMode) return desktopInvoke<Record<string, unknown>[]>("load_trace", { input });
  const response = await webFetch("/api/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) return parseError(response);
  return (await response.json()).rows;
};

export const importEnvironmentConfig = async (contents: string): Promise<string> => {
  if (desktopMode) return (await desktopInvoke<SavedFile>("save_environment_config", { contents })).path;
  const response = await webFetch("/api/environments/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents })
  });
  if (!response.ok) return parseError(response);
  return ((await response.json()) as SavedFile).path;
};

import {
  MAX_CUSTOM_LOG_MARKERS,
  normalizeCustomLogMarkers,
  type CustomLogMarker,
  type CustomLogMarkerRule
} from "./custom-log-markers";

export const CUSTOM_LOG_MARKER_EXPORT_FORMAT = "opslog-custom-markers";
export const CUSTOM_LOG_MARKER_EXPORT_VERSION = 1;
export const MAX_CUSTOM_LOG_MARKER_IMPORT_BYTES = 1024 * 1024;

interface CustomLogMarkerExportPayload {
  format: typeof CUSTOM_LOG_MARKER_EXPORT_FORMAT;
  version: typeof CUSTOM_LOG_MARKER_EXPORT_VERSION;
  exportedAt: string;
  markers: CustomLogMarker[];
}

export interface CustomLogMarkerImportResult {
  markers: CustomLogMarker[];
  imported: number;
  duplicates: number;
  invalid: number;
  overflow: number;
}

const createId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const markerSignature = (marker: CustomLogMarker): string => JSON.stringify({
  label: marker.label,
  rules: marker.rules.map(({ label, query, regex }) => ({ label, query, regex }))
});

const cloneRuleForImport = (rule: CustomLogMarkerRule): CustomLogMarkerRule => ({ ...rule, id: createId() });

const cloneMarkerForImport = (marker: CustomLogMarker): CustomLogMarker => ({
  ...marker,
  id: createId(),
  rules: marker.rules.map(cloneRuleForImport)
});

const importedValues = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") throw new Error("标记文件格式不正确");
  const payload = value as Partial<CustomLogMarkerExportPayload>;
  if (payload.format && payload.format !== CUSTOM_LOG_MARKER_EXPORT_FORMAT) throw new Error("这不是 OpsLog 自定义标记文件");
  if (typeof payload.version === "number" && payload.version > CUSTOM_LOG_MARKER_EXPORT_VERSION) {
    throw new Error("标记文件来自更高版本的 OpsLog，请先升级当前程序");
  }
  if (!Array.isArray(payload.markers)) throw new Error("标记文件中没有可导入的标记");
  return payload.markers;
};

export const serializeCustomLogMarkers = (markers: CustomLogMarker[]): string => {
  const payload: CustomLogMarkerExportPayload = {
    format: CUSTOM_LOG_MARKER_EXPORT_FORMAT,
    version: CUSTOM_LOG_MARKER_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    markers: normalizeCustomLogMarkers(markers)
  };
  return JSON.stringify(payload, null, 2);
};

export const mergeCustomLogMarkerImport = (current: CustomLogMarker[], contents: string): CustomLogMarkerImportResult => {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new Error("标记文件不是有效的 JSON");
  }

  const candidates = importedValues(value);
  const normalized = normalizeCustomLogMarkers(candidates, candidates.length);
  const signatures = new Set(current.map(markerSignature));
  const additions: CustomLogMarker[] = [];
  let duplicates = 0;

  for (const marker of normalized) {
    const signature = markerSignature(marker);
    if (signatures.has(signature)) {
      duplicates += 1;
      continue;
    }
    signatures.add(signature);
    additions.push(cloneMarkerForImport(marker));
  }

  const available = Math.max(0, MAX_CUSTOM_LOG_MARKERS - current.length);
  const imported = additions.slice(0, available);
  return {
    markers: [...current, ...imported],
    imported: imported.length,
    duplicates,
    invalid: candidates.length - normalized.length,
    overflow: Math.max(0, additions.length - available)
  };
};

export const customLogMarkerExportName = (label?: string): string => {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  const safeLabel = label?.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 48);
  return safeLabel ? `opslog-marker-${safeLabel}-${timestamp}` : `opslog-custom-markers-${timestamp}`;
};

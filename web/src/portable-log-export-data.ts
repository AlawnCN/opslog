import { buildCustomLogMarkerOutline, type CustomLogMarker } from "./custom-log-markers";
import type { TransactionLogAnalysis } from "./transaction-log-model";

export const PORTABLE_LOG_FORMAT = "opslog-portable-reader";
export const PORTABLE_LOG_VERSION = 1;

export interface PortableLogSnapshot {
  format: typeof PORTABLE_LOG_FORMAT;
  version: typeof PORTABLE_LOG_VERSION;
  exportedAt: string;
  logId: string;
  content: string;
  analysis: TransactionLogAnalysis;
  initiallyFolded: boolean;
  initialWrapLines: boolean;
  initialOutlineWrapLines: boolean;
  customMarkers: Array<{
    id: string;
    label: string;
    rules: CustomLogMarker["rules"];
    outline: ReturnType<typeof buildCustomLogMarkerOutline>;
  }>;
}

interface PortableLogSnapshotInput {
  logId: string;
  content: string;
  analysis: TransactionLogAnalysis;
  customMarkers: CustomLogMarker[];
  initiallyFolded: boolean;
  initialWrapLines: boolean;
  initialOutlineWrapLines: boolean;
  exportedAt?: string;
}

export const buildPortableLogSnapshot = ({ logId, content, analysis, customMarkers, initiallyFolded, initialWrapLines, initialOutlineWrapLines, exportedAt }: PortableLogSnapshotInput): PortableLogSnapshot => ({
  format: PORTABLE_LOG_FORMAT,
  version: PORTABLE_LOG_VERSION,
  exportedAt: exportedAt ?? new Date().toISOString(),
  logId,
  content,
  analysis,
  initiallyFolded,
  initialWrapLines,
  initialOutlineWrapLines,
  customMarkers: customMarkers.map((marker) => ({
    id: marker.id,
    label: marker.label,
    rules: marker.rules,
    outline: buildCustomLogMarkerOutline(content, marker)
  }))
});

const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
};

export const encodePortableLogSnapshot = (snapshot: PortableLogSnapshot): string => bytesToBase64(
  new TextEncoder().encode(JSON.stringify(snapshot))
);

export interface EncodedPortableLogSnapshot {
  encoding: "gzip-base64" | "base64";
  payload: string;
}

export const encodeCompressedPortableLogSnapshot = async (snapshot: PortableLogSnapshot): Promise<EncodedPortableLogSnapshot> => {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  if (typeof CompressionStream === "undefined") return { encoding: "base64", payload: bytesToBase64(bytes) };
  const compressedStream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(compressedStream).arrayBuffer());
  return { encoding: "gzip-base64", payload: bytesToBase64(compressed) };
};

export const portableLogFilename = (logId: string): string => {
  const safeId = logId.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 150);
  return `OpsLog_${safeId || "transaction-log"}.html`;
};

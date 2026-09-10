import portableStyles from "./portable-log-document.css?raw";
import portableRuntime from "./portable-log-runtime.js?raw";
import { buildPortableLogSnapshot, encodeCompressedPortableLogSnapshot } from "./portable-log-export-data";
import type { CustomLogMarker } from "./custom-log-markers";
import type { TransactionLogAnalysis } from "./transaction-log-model";

interface PortableLogDocumentInput {
  logId: string;
  content: string;
  analysis: TransactionLogAnalysis;
  customMarkers: CustomLogMarker[];
  initiallyFolded: boolean;
  initialWrapLines: boolean;
  initialOutlineWrapLines: boolean;
}

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

export const createPortableLogDocument = async (input: PortableLogDocumentInput): Promise<string> => {
  const snapshot = buildPortableLogSnapshot(input);
  const encoded = await encodeCompressedPortableLogSnapshot(snapshot);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>OpsLog · ${escapeHtml(input.logId)}</title>
  <style>${portableStyles}</style>
</head>
<body>
  <main id="app" aria-busy="true"><div class="boot"><i></i><strong>正在装载离线日志快照…</strong></div></main>
  <script id="opslog-data" type="application/octet-stream" data-encoding="${encoded.encoding}">${encoded.payload}</script>
  <script>${portableRuntime}</script>
</body>
</html>`;
};

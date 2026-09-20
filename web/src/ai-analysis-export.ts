export type AiAnalysisExportFormat = "md" | "html";

export interface AiAnalysisExportResult {
  provider: string;
  model: string;
  durationMs: number;
  inputCharacters: number;
  truncated: boolean;
  content: string;
}

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const metadata = (logId: string, result: AiAnalysisExportResult) => ({
  logId: logId.replace(/[\r\n]+/g, " ").trim(),
  model: `${result.provider} / ${result.model}`,
  duration: `${(result.durationMs / 1000).toFixed(1)} 秒`,
  input: `${result.inputCharacters.toLocaleString()} 字符${result.truncated ? "（已智能压缩）" : ""}`
});

export const buildAiAnalysisMarkdown = (logId: string, result: AiAnalysisExportResult): string => {
  const values = metadata(logId, result);
  return `# AI 日志分析\n\n- 日志：${values.logId}\n- 模型：${values.model}\n- 耗时：${values.duration}\n- 输入：${values.input}\n\n${result.content}\n`;
};

export const buildAiAnalysisHtml = (logId: string, result: AiAnalysisExportResult, renderedResultHtml?: string): string => {
  const values = metadata(logId, result);
  const resultHtml = renderedResultHtml?.trim() || `<pre>${escapeHtml(result.content)}</pre>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 日志分析 · ${escapeHtml(values.logId)}</title><style>
:root{color-scheme:dark;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#06111d;color:#abc0cf}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 18% 0,rgba(125,93,255,.12),transparent 32%),#06111d}.page{width:min(1320px,calc(100vw - 40px));margin:28px auto 60px}.hero{padding:24px;border:1px solid #443d72;border-radius:10px 10px 0 0;background:#0b1729}.eyebrow{color:#6e86a2;font:700 11px ui-monospace,monospace;letter-spacing:.16em}.hero h1{margin:8px 0 18px;color:#e3e9f5;font-size:26px}.meta{display:flex;flex-wrap:wrap;gap:8px}.meta span{padding:6px 9px;border:1px solid #253e55;background:#071725;color:#819eb2;font:11px ui-monospace,monospace}.content{padding:22px 28px 36px;border:1px solid #26344f;border-top:0;border-radius:0 0 10px 10px;background:#081524;line-height:1.75;overflow-wrap:anywhere}.content h1,.content h2,.content h3{margin:24px 0 9px;color:#d9e4ef;line-height:1.4}.content h1{padding-bottom:9px;border-bottom:1px solid #30345a;color:#bcaeff;font-size:22px}.content h2{color:#8edcf1;font-size:17px}.content h3{font-size:14px}.content a{color:#76d9ef}.content code{padding:2px 5px;background:rgba(139,114,239,.12);color:#c9bcff;font:12px/1.5 ui-monospace,monospace}.content pre{overflow:auto;padding:14px;border:1px solid #1d394f;background:#05111c}.content pre code{padding:0;background:transparent;color:#a9c7d8}.content blockquote{margin:12px 0;padding:4px 14px;border-left:3px solid #7e67d5;color:#879db0}.markdown-table-scroll{width:100%;margin:12px 0;overflow-x:auto}.content table{width:max-content;min-width:100%;table-layout:auto;border-collapse:collapse}.content th,.content td{min-width:120px;max-width:620px;padding:8px 10px;border:1px solid #203b50;text-align:left;vertical-align:top}.content th{white-space:nowrap;color:#d2dcea;background:#0b1d2e}@media(max-width:700px){.page{width:calc(100vw - 20px);margin:10px auto 30px}.hero,.content{padding:18px}.hero h1{font-size:21px}}
</style></head><body><main class="page"><header class="hero"><span class="eyebrow">AI LOG ANALYSIS</span><h1>AI 日志分析</h1><div class="meta"><span>日志：${escapeHtml(values.logId)}</span><span>模型：${escapeHtml(values.model)}</span><span>耗时：${escapeHtml(values.duration)}</span><span>输入：${escapeHtml(values.input)}</span></div></header><article class="content">${resultHtml}</article></main></body></html>`;
};

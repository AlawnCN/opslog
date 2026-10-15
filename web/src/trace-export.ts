import { captureHtmlExportTheme } from "./html-export-theme";
import { DEFAULT_TIME_ZONE, displayTime } from "./time";
import { buildTraceModel, durationSeverity, flattenTraceTree, traceCategoryLabel, traceNodeSearchText, traceNodeTiming, type TraceNode } from "./trace-model";
import { traceExportRuntime } from "./trace-export-runtime";

interface TraceExportInput {
  traceId: string;
  rows: Record<string, unknown>[];
  timeZone?: string;
  keyword?: string;
  collapsed?: ReadonlySet<string>;
  columnWidth?: number;
}

const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const duration = (ms: number): string => ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(2)} ms`;
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const traceExportFilename = (id: string): string => `trace-${id.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 120) || "snapshot"}.html`;

const detailHtml = (node: TraceNode, timeZone: string): string => {
  const fields = [["服务", node.service], ["耗时", duration(node.durationMs)], ["开始", displayTime(node.row["@timestamp"], timeZone)], ["Span ID", node.id], ["Parent ID", node.parentId]];
  return `<details class="span-detail"><summary>Span 详情</summary><dl>${fields.filter(([, value]) => value).map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${node.detail ? `<pre>${escapeHtml(node.detail)}</pre>` : ""}<details><summary>原始字段</summary><pre>${escapeHtml(JSON.stringify(node.row, null, 2))}</pre></details></details>`;
};

export const buildTraceHtml = (input: TraceExportInput): string => {
  const theme = captureHtmlExportTheme();
  const model = buildTraceModel(input.rows);
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const parents = new Map<string, string>();
  for (const node of model.nodes) for (const child of node.children) parents.set(child.key, node.key);
  const nodes = flattenTraceTree(model.roots, new Set());
  const snapshot = { keyword: input.keyword ?? "", collapsed: [...input.collapsed ?? []], nodes: nodes.map(({ node }) => ({
    key: node.key, parentKey: parents.get(node.key), hasChildren: Boolean(node.children.length), searchText: traceNodeSearchText(node)
  })) };
  const rows = nodes.map(({ node, depth }, index) => {
    const timing = traceNodeTiming(node, model);
    return `<article data-trace-index="${index}" class="trace-row ${durationSeverity(node.durationMs)}" style="--depth:${depth};--left:${timing.left}%;--width:${timing.width}%"><div class="operation">${node.children.length ? '<button class="fold-toggle" type="button" aria-expanded="true" aria-label="折叠子调用">⌄</button>' : '<span class="leaf"></span>'}<span class="type">${traceCategoryLabel[node.category]}</span><strong title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</strong><small title="${escapeHtml(node.service)}">${escapeHtml(node.service)}</small></div><div class="timeline"><i class="duration-bar"><b>${timing.width > 10 ? duration(node.durationMs) : ""}</b></i>${timing.width <= 10 ? `<code>${duration(node.durationMs)}</code>` : ""}</div>${detailHtml(node, timeZone)}</article>`;
  }).join("\n");
  const columnWidth = Math.max(280, Math.min(1400, Number.isFinite(input.columnWidth) ? input.columnWidth! : 460));
  return `<!doctype html>
<html lang="zh-CN" ${theme.attributes}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="opslog-trace-snapshot">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>OpsLog · Trace · ${escapeHtml(input.traceId)}</title><style>${traceExportStyles}\n${theme.styles}</style></head>
<body style="--column:${columnWidth}px"><main class="page"><header class="hero"><span class="eyebrow">DISTRIBUTED TRACE</span><h1>调用链路</h1><code class="log-id">${escapeHtml(input.traceId)}</code><div class="meta"><span>SPAN 数量：${model.nodes.length}</span><span>链路跨度：${duration(model.durationMs)}</span><span>服务数量：${model.services}</span><span>时区：${escapeHtml(timeZone)}</span></div></header>
<section class="content" aria-label="调用链路快照"><div class="controls"><label class="search">⌕<input id="trace-search" type="search" placeholder="搜索调用名称、服务、SQL 或 Span ID" aria-label="Trace 关键字过滤"><button id="trace-clear" type="button" aria-label="清除 Trace 过滤" hidden>×</button></label><span id="trace-count" role="status" aria-live="polite"></span></div>
<div class="actions"><div class="legend"><span>快速</span><i></i><span>关注</span><i></i><span>慢调用</span></div><div><button id="trace-collapse" type="button">⊟ 全部折叠</button><button id="trace-expand" type="button">⊞ 全部展开</button></div></div>
<div class="waterfall"><div class="axis"><span>调用层级</span><div>${[0, .25, .5, .75, 1].map(stop => `<i style="left:${stop * 100}%">${duration(model.durationMs * stop)}</i>`).join("")}</div></div>${rows}</div><p id="trace-empty" role="status" hidden>未找到匹配的调用</p><noscript>启用 JavaScript 可搜索和折叠调用链。</noscript></section></main>
<script id="trace-data" type="application/json">${safeJson(snapshot)}</script><script>${traceExportRuntime}</script></body></html>`;
};

const traceExportStyles = `
:root{color-scheme:dark;--canvas:#061522;--surface:#081827;--editor-surface:#061522;--surface-2:#0a1c2b;--text:#b9ceda;--muted:#789aad;--cyan:#2ad4e0;--line:#1a3b50;--selected-surface:#0c293d;--font-ui:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--canvas);color:var(--text);font:13px/1.5 var(--font-ui)}.page{max-width:1800px;margin:28px auto;padding:0 24px 36px}.hero{padding:24px;border:1px solid var(--line);background:var(--surface)}.eyebrow{color:var(--muted);font:11px var(--font-mono);letter-spacing:.15em}h1{margin:8px 0;font-size:22px}.log-id{color:var(--cyan);overflow-wrap:anywhere}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.meta span{padding:8px 12px;border:1px solid var(--line);background:var(--surface-2);font:12px var(--font-mono)}.content{margin-top:18px;padding:18px;border:1px solid var(--line);background:var(--editor-surface)}button,input{font:inherit}button{padding:6px 10px;background:var(--surface-2);color:var(--text);border:1px solid var(--line);cursor:pointer}button:hover:not(:disabled){color:var(--cyan);border-color:var(--cyan)}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}.controls{display:flex;align-items:center;gap:16px;margin-bottom:12px}.search{display:flex;align-items:center;gap:10px;flex:1;padding:8px 12px;border:1px solid var(--line);background:var(--surface)}.search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--text)}input::placeholder{color:var(--muted)}.search button{border:0;padding:0 4px;box-shadow:none}#trace-count{color:var(--muted);font-size:11px;white-space:nowrap}.actions{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 0}.actions>div{display:flex;align-items:center;gap:6px}.legend{font-size:11px}.legend i{height:2px;width:20px;background:linear-gradient(90deg,#43e2a6,#e0c05e,#ff6679)}.legend span:first-child{color:#43e2a6}.legend span:nth-of-type(2){color:#e0c05e}.legend span:last-child{color:#ff6679}
.waterfall{overflow-x:auto;border:1px solid var(--line)}.axis,.trace-row{display:grid;grid-template-columns:var(--column) minmax(320px,1fr);min-width:calc(var(--column) + 340px)}.axis{height:36px;border-bottom:1px solid var(--line);color:var(--muted);font:10px var(--font-mono);background:var(--surface)}.axis>span{padding:12px}.axis>div{position:relative;margin-right:58px}.axis i{position:absolute;bottom:8px;font-style:normal;white-space:nowrap;transform:translateX(-50%)}.axis i:first-child{transform:none}.axis i:last-child{transform:translateX(-100%)}.trace-row{min-height:42px;border-bottom:1px solid var(--line)}.trace-row:hover{background:var(--selected-surface)}.operation{display:grid;grid-template-columns:18px 42px minmax(60px,1fr) auto;align-items:center;gap:6px;min-width:0;padding:6px 10px 6px calc(10px + var(--depth)*17px)}.operation strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.operation small{max-width:90px;overflow:hidden;text-overflow:ellipsis;color:var(--muted);font:10px var(--font-mono)}.type{border:1px solid var(--line);text-align:center;color:var(--muted);font:9px/18px var(--font-mono)}.fold-toggle{width:18px;height:22px;padding:0;background:transparent;border:0;color:var(--muted);box-shadow:none;border-radius:0}.timeline{position:relative;min-height:42px;margin-right:58px;background:repeating-linear-gradient(90deg,var(--line) 0 1px,transparent 1px 25%)}.duration-bar{position:absolute;top:12px;left:var(--left);width:var(--width);min-width:3px;height:18px;display:flex;align-items:center;overflow:hidden;border-radius:2px}.duration-bar b{color:#061522;padding:0 6px;white-space:nowrap;font:700 10px var(--font-mono)}.timeline>code{position:absolute;top:13px;left:calc(var(--left) + var(--width) + 5px);white-space:nowrap;color:var(--muted);font:10px var(--font-mono)}.fast .duration-bar{background:#43e2a6}.normal .duration-bar{background:#62cbb6}.warning .duration-bar{background:#e0c05e}.slow .duration-bar{background:#f08a55}.critical .duration-bar{background:#ff6679}.is-context .operation{opacity:.6}.span-detail{grid-column:1/-1;padding:0 12px 6px calc(34px + var(--depth)*17px);min-width:0;font-size:11px}summary{cursor:pointer;color:var(--muted);width:fit-content}dl{display:flex;flex-wrap:wrap;gap:10px 24px}dl>div{min-width:120px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere;font-family:var(--font-mono)}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:var(--surface-2);border:1px solid var(--line);font:12px/1.6 var(--font-mono)}#trace-empty{padding:32px;text-align:center;color:var(--muted)}@media(max-width:700px){.page{margin:12px auto;padding:0 10px 24px}.hero,.content{padding:14px}.controls{align-items:stretch;flex-direction:column;gap:6px}.actions{flex-wrap:wrap}.meta span{font-size:11px}}`;

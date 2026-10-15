// Browser fixture for Trace export. No environment settings or remote queries.
import { createServer } from "vite";
import path from "node:path";
import { buildTraceHtml } from "../web/src/trace-export";
import express from "express";

const traceId = "export-preview-test";
const rows = [
  { "@timestamp": "2026-10-15T08:00:00.000Z", "transaction.id": "root", "transaction.name": "POST /payments", "transaction.duration.us": 500000, "processor.event": "transaction", "service.name": "gateway" },
  { "@timestamp": "2026-10-15T08:00:00.050Z", "span.id": "service", "parent.id": "root", "span.name": "PaymentService#execute", "span.duration.us": 300000, "service.name": "payments" },
  { "@timestamp": "2026-10-15T08:00:00.100Z", "span.id": "sql", "parent.id": "service", "span.name": "SELECT FROM t_pay_txn", "span.duration.us": 40000, "span.type": "db", "db.statement": "select * from t_pay_txn where req_bus_no = ?", "service.name": "payments" },
  { "@timestamp": "2026-10-15T08:00:00.180Z", "span.id": "http", "parent.id": "service", "span.name": "POST /core/settle", "span.duration.us": 120000, "span.type": "http", "url.full": "https://example.invalid/core/settle", "service.name": "payments" },
  { "@timestamp": "2026-10-15T08:00:00.200Z", "span.id": "redis", "parent.id": "root", "span.name": "HGET session", "span.duration.us": 2000, "service.name": "cache" }
];
const server = await createServer({ configFile: path.resolve("vite.config.ts"), server: { middlewareMode: true, open: false } });
const app = express();
app.use(async (request, response, next) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/offline.html") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(buildTraceHtml({ traceId, rows, timeZone: "Asia/Shanghai" }));
    return;
  }
  if (url.pathname !== "/__trace-preview") { next(); return; }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Trace export fixture</title></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {TraceDrawer} from '/src/components/TraceDrawer.tsx';
    import {ThemePicker} from '/src/components/ThemePicker.tsx';
    import {TypographySettings} from '/src/components/TypographySettings.tsx';
    import {SafeMarkdown} from '/src/components/SafeMarkdown.tsx';
    import {initializeTypography} from '/src/typography-preferences.ts';
    import {setTheme} from '/src/theme.ts';
    import '/src/styles.css'; import '/src/themes.css'; import '/src/typography.css';
    initializeTypography();
    setTheme(${JSON.stringify(url.searchParams.get("theme") ?? "cyberpunk")});
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,
      React.createElement('div',{style:{position:'fixed',left:'12px',top:'12px',zIndex:100,display:'flex',gap:'8px'}},React.createElement(ThemePicker),React.createElement(TypographySettings)),
      ${url.searchParams.has("markdown") ? `React.createElement('div',{className:'ai-analysis-markdown',style:{padding:'100px 40px'}},React.createElement(SafeMarkdown,{source:'| 日志 ID | 结果说明 |\\n|---|---|\\n| TXN-001 | 汇总日志解析正常，返回完整交易记录与错误信息 |'}))` : `React.createElement(TraceDrawer,{traceId:${JSON.stringify(traceId)},rows:${JSON.stringify(rows)},loading:false,onClose:()=>{},timeZone:'Asia/Shanghai'})`}));
  </script></body></html>`;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(await server.transformIndexHtml(request.url!, html));
});
app.use(server.middlewares);
const listener = app.listen(18809, "127.0.0.1");
console.log("Trace preview: http://127.0.0.1:18809/__trace-preview");
const stop = async () => { listener.close(); await server.close(); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);

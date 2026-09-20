import assert from "node:assert/strict";
import test from "node:test";
import { buildAiAnalysisHtml, buildAiAnalysisMarkdown } from "../web/src/ai-analysis-export";

const result = {
  provider: "DeepSeek",
  model: "deepseek-chat",
  durationMs: 1520,
  inputCharacters: 2400,
  truncated: true,
  content: "## 结论\n\n已定位异常。"
};

test("exports the complete AI analysis as markdown", () => {
  const markdown = buildAiAnalysisMarkdown("trace-1", result);
  assert.match(markdown, /^# AI 日志分析/);
  assert.match(markdown, /DeepSeek \/ deepseek-chat/);
  assert.match(markdown, /已智能压缩/);
  assert.match(markdown, /## 结论/);
});

test("exports a self-contained HTML report and escapes metadata", () => {
  const html = buildAiAnalysisHtml("<trace-1>", result, "<h2>结论</h2><p>已定位异常。</p>");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /&lt;trace-1&gt;/);
  assert.match(html, /<h2>结论<\/h2>/);
  assert.match(html, /overflow-x:auto/);
  assert.doesNotMatch(html, /<title>[^<]*<trace-1>/);
});

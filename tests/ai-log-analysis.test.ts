import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_AI_SYSTEM_PROMPT, LEGACY_DEFAULT_AI_SYSTEM_PROMPT, upgradeDefaultAiSystemPrompt } from "../shared/ai-log-prompt";
import { DEFAULT_SYSTEM_PROMPT, storedProfileSchema } from "../server/ai-configuration";
import { AI_PROVIDER_PRESETS, buildAiLogPrompt } from "../web/src/ai-log-analysis";
import { compactLogForAi } from "../web/src/ai-log-compaction";
import { analyzeTransactionLog } from "../web/src/transaction-log-analysis";
import type { AiProfile } from "../web/src/api";
import type { CustomLogMarker } from "../web/src/custom-log-markers";

const configuration: AiProfile = {
  id: "openai",
  name: "OpenAI",
  provider: "openai",
  protocol: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5-mini",
  hasApiKey: true,
  configured: true,
  systemPrompt: "analyze",
  temperature: .2,
  maxOutputTokens: 2_000,
  maxLogCharacters: 20_000,
  streamResponse: true
};

test("provider presets cover cloud, local, and custom OpenAI-compatible services", () => {
  const ids = AI_PROVIDER_PRESETS.map(({ id }) => id);
  assert.deepEqual(ids, ["openai", "grok", "gemini", "deepseek", "kimi", "ollama", "lm-studio", "custom"]);
  assert.equal(AI_PROVIDER_PRESETS.find(({ id }) => id === "ollama")?.local, true);
  assert.equal(AI_PROVIDER_PRESETS.find(({ id }) => id === "lm-studio")?.baseUrl, "http://127.0.0.1:1234/v1");
});

test("platform prompt is shared and legacy defaults upgrade without replacing custom prompts", () => {
  assert.equal(DEFAULT_SYSTEM_PROMPT, DEFAULT_AI_SYSTEM_PROMPT);
  assert.match(DEFAULT_AI_SYSTEM_PROMPT, /M5\/ECP 平台生产日志诊断专家/);
  assert.match(DEFAULT_AI_SYSTEM_PROMPT, /SQL 与数据访问/);
  assert.match(DEFAULT_AI_SYSTEM_PROMPT, /交易与业务结果/);
  assert.equal(upgradeDefaultAiSystemPrompt(LEGACY_DEFAULT_AI_SYSTEM_PROMPT), DEFAULT_AI_SYSTEM_PROMPT);
  assert.equal(upgradeDefaultAiSystemPrompt("自定义提示词"), "自定义提示词");
});

test("existing Web profiles enable streaming when the setting is missing", () => {
  const { streamResponse: _streamResponse, hasApiKey: _hasApiKey, configured: _configured, ...legacyProfile } = configuration;
  const profile = storedProfileSchema.parse({ ...legacyProfile, apiKey: "secret" });
  assert.equal(profile.streamResponse, true);
});

test("AI prompt includes built-in analysis and current custom marker rules", () => {
  const content = "2026-09-19 [svc] [ERROR] -> response failed req_bus_no=FT001";
  const markers: CustomLogMarker[] = [{ id: "request", label: "流水号", rules: [{ id: "rule", label: "请求流水", query: "req_bus_no", regex: false }] }];
  const result = buildAiLogPrompt({ logId: "sample.trc", content, analysis: analyzeTransactionLog(content), customMarkers: markers, configuration });
  assert.match(result.prompt, /内置标记规则/);
  assert.match(result.prompt, /流水号 \/ 请求流水：文本 `req_bus_no`/);
  assert.match(result.prompt, /response failed/);
  assert.match(result.prompt, /耗时分析/);
  assert.match(result.prompt, /SQL 与数据访问分析/);
  assert.match(result.prompt, /业务原因研判/);
  assert.match(result.prompt, /证据缺口/);
  assert.equal(result.truncated, false);
});

test("AI prompt retains signal lines when a large log is truncated", () => {
  const noisy = "ordinary line\n".repeat(2_000);
  const content = `${noisy}ERROR final failure req_bus_no=FT009\n${noisy}`;
  const result = buildAiLogPrompt({ logId: "large.trc", content, analysis: analyzeTransactionLog(content), customMarkers: [], configuration });
  assert.equal(result.truncated, true);
  assert.match(result.prompt, /ERROR final failure/);
  assert.ok(result.inputCharacters <= configuration.maxLogCharacters);
  assert.match(result.prompt, /已智能压缩/);
});

test("AI compaction folds repeated noise while preserving failures and marker hits", () => {
  const marker: CustomLogMarker = { id: "request", label: "流水号", rules: [{ id: "rule", label: "请求流水", query: "req_bus_no", regex: false }] };
  const content = `${"2026-09-20T10:00:00Z [svc] [INFO] heartbeat 123456\n".repeat(400)}2026-09-20T10:00:01Z [svc] [ERROR] timeout req_bus_no=FT001\n`;
  const result = compactLogForAi(content, [marker], 4_000);
  assert.equal(result.compacted, true);
  assert.ok(result.foldedLines > 300);
  assert.match(result.text, /同类日志重复/);
  assert.match(result.text, /ERROR.*timeout.*FT001/);
});

test("AI result dialog exports Markdown and HTML without exposing a configuration action", async () => {
  const dialog = await readFile("web/src/components/AiLogAnalysisDialog.tsx", "utf8");
  assert.match(dialog, /MarkdownFileIcon/);
  assert.match(dialog, /HtmlFileIcon/);
  assert.match(dialog, /aria-pressed=\{exportFormat === "md"\}/);
  assert.doesNotMatch(dialog, /AppSelect/);
  assert.match(dialog, /buildAiAnalysisHtml/);
  assert.match(dialog, /saveAiAnalysisResult/);
  assert.doesNotMatch(dialog, /SettingsIcon|AI 配置/);
  assert.match(dialog, /正在生成/);
});

test("AI analysis is unavailable until the current log has finished loading", async () => {
  const workspace = await readFile("web/src/components/TransactionLogDrawer.tsx", "utf8");
  const assistant = await readFile("web/src/components/AiLogAssistant.tsx", "utf8");
  assert.match(workspace, /disabled=\{loading \|\| !content\}/);
  assert.match(assistant, /disabled=\{disabled \|\| !content\.trim\(\)\}/);
});

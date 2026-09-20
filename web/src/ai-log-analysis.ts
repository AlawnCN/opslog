import type { AiProfile, AiProtocol } from "./api";
import { compactLogForAi } from "./ai-log-compaction";
import type { CustomLogMarker } from "./custom-log-markers";
import type { TransactionLogAnalysis } from "./transaction-log-model";
export { DEFAULT_AI_SYSTEM_PROMPT } from "../../shared/ai-log-prompt";

export interface AiProviderPreset {
  id: string;
  label: string;
  description: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  local?: boolean;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { id: "openai", label: "OpenAI", description: "OpenAI Chat Completions", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" },
  { id: "grok", label: "Grok", description: "xAI OpenAI 兼容接口", protocol: "openai-compatible", baseUrl: "https://api.x.ai/v1", model: "grok-4" },
  { id: "gemini", label: "Gemini", description: "Google OpenAI 兼容接口", protocol: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  { id: "deepseek", label: "DeepSeek", description: "DeepSeek OpenAI 兼容接口", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { id: "kimi", label: "Kimi", description: "Moonshot OpenAI 兼容接口", protocol: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.5" },
  { id: "ollama", label: "Ollama", description: "本机 Ollama 服务", protocol: "ollama-native", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", local: true },
  { id: "lm-studio", label: "LM Studio", description: "本机 OpenAI 兼容服务", protocol: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", local: true },
  { id: "custom", label: "自定义", description: "自定义兼容服务", protocol: "openai-compatible", baseUrl: "", model: "" }
];

interface BuildAiLogPromptInput {
  logId: string;
  content: string;
  analysis: TransactionLogAnalysis;
  customMarkers: CustomLogMarker[];
  configuration: AiProfile;
}

export interface AiLogPrompt {
  prompt: string;
  inputCharacters: number;
  truncated: boolean;
}

const builtInRules = [
  "微服务：识别 container:[...] / appName:[...] 服务入口并按区段分析",
  "调用标记：识别 txncod、txnCode、service、container 等调用字段",
  "SQL：识别 execute sql / sql 语句以及关联的 SQL Result",
  "失败线索：识别 response、result、error、failed 等上下文中的失败结果码与消息",
  "异常：识别 ERROR、Exception、Caused by、Stack 与错误码",
  "结构块：识别 JSON、XML、Java 对象及 SQL Result"
];

const markerRules = (markers: CustomLogMarker[]): string => {
  if (!markers.length) return "- 当前没有自定义标记";
  return markers.flatMap((marker) => marker.rules.map((rule, index) =>
    `- ${marker.label} / ${rule.label || `条件 ${index + 1}`}：${rule.regex ? "正则" : "文本"} \`${rule.query}\``
  )).join("\n");
};

export const buildAiLogPrompt = ({ logId, content, analysis, customMarkers, configuration }: BuildAiLogPromptInput): AiLogPrompt => {
  const bounded = compactLogForAi(content, customMarkers, configuration.maxLogCharacters);
  const summary = [
    `日志 ID：${logId}`,
    `总行数：${analysis.stats.lines}`,
    `微服务：${analysis.stats.services}`,
    `调用标记：${analysis.stats.calls}`,
    `SQL：${analysis.stats.sql}`,
    `失败线索：${analysis.stats.failedResults}`,
    `ERROR/异常：${analysis.stats.exceptions}`,
    `结构块：${analysis.stats.structured}`,
    `正文处理：${bounded.compacted ? `已智能压缩（原始 ${bounded.originalLines.toLocaleString()} 行，保留 ${bounded.retainedLines.toLocaleString()} 行，合并重复 ${bounded.foldedLines.toLocaleString()} 行）` : "完整正文"}`
  ].join("\n");
  const prompt = `请对下面这份 M5/ECP 交易日志执行一次完整的生产问题诊断。即使交易最终成功，也要检查隐藏的异常、慢点、数据不一致和后续风险。\n\n## 固定输出结构\n### 1. 诊断结论\n- 用 1～3 句话说明交易结果、主要问题和影响。\n- 给出置信度（高/中/低）及原因。\n\n### 2. 业务结果与关键上下文\n- 说明交易意图、渠道、交易码、关键关联号、最终状态和响应码。\n- 区分【事实】【推断】【待确认】。\n\n### 3. 关键时间线与服务调用链\n使用表格输出：时间/阶段耗时、服务或线程、调用方向、业务动作、结果、证据。\n说明入口、下游服务、数据库、消息队列、异步边界、回调及最终返回。\n\n### 4. 耗时分析\n- 给出端到端耗时和可计算的阶段耗时，列出最慢的三个阶段及占比。\n- 分析 SQL、远程调用、连接池、消息、业务计算和未知空档；无法计算时说明缺失什么。\n\n### 5. SQL 与数据访问分析\n使用表格输出：时间、sql_id/Mapper、SQL 类型、表、用途、耗时/结果、风险判断。\n检查空结果、重复 SQL、写入影响、事务提交/回滚、连接释放和 SQL 与业务步骤的关系。\n\n### 6. 异常、失败与根因链\n- 罗列 ERROR/WARN、异常、失败码和异常响应。\n- 说明“最早异常 → 传播路径 → 最终结果”，区分根因、伴随告警和无关噪声。\n\n### 7. 业务原因研判\n按可能性从高到低列出候选原因，每项必须包含：证据、反证/不确定点、业务影响、验证方法。\n覆盖但不限于参数、客户/账户状态、余额/额度、币种、日期、权限、风控、幂等、重复交易、记账和异步回调。没有证据的候选必须标为【待确认】。\n\n### 8. 处理建议\n分为“立即检查”“代码/配置改进”“监控与长期治理”，按优先级给出具体、可执行的步骤。\n\n### 9. 证据缺口\n列出无法下结论所缺少的日志、SQL 执行计划、数据库状态、服务指标或代码位置。\n\n## 日志摘要\n${summary}\n\n## 内置标记规则\n${builtInRules.map((rule) => `- ${rule}`).join("\n")}\n\n## 自定义标记规则\n${markerRules(customMarkers)}\n\n## 日志正文\n\`\`\`text\n${bounded.text}\n\`\`\``;
  return { prompt, inputCharacters: bounded.text.length, truncated: bounded.compacted };
};

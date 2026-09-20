import { z } from "zod";
import { activeAiProfile, isAiProfileConfigured, type StoredAiProfile } from "./ai-configuration.js";

export const analyzeLogSchema = z.object({
  prompt: z.string().trim().min(1).max(1_200_000),
  inputCharacters: z.number().int().nonnegative().max(1_200_000),
  truncated: z.boolean()
});

export type AnalyzeLogInput = z.infer<typeof analyzeLogSchema>;

const endpoint = (baseUrl: string, suffix: string): URL =>
  new URL(baseUrl.endsWith(suffix) ? baseUrl : `${baseUrl.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`);

const isDeepSeek = (configuration: StoredAiProfile): boolean => {
  if (configuration.provider === "deepseek") return true;
  return new URL(configuration.baseUrl).hostname.endsWith("deepseek.com");
};

const requestHeaders = (configuration: StoredAiProfile): Headers => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (configuration.apiKey && configuration.protocol === "gemini-native") headers.set("x-goog-api-key", configuration.apiKey);
  else if (configuration.apiKey) headers.set("Authorization", `Bearer ${configuration.apiKey}`);
  return headers;
};

const requestPayload = (configuration: StoredAiProfile, prompt: string): { url: URL; body: unknown } => {
  if (configuration.protocol === "gemini-native") return {
    url: endpoint(configuration.baseUrl, `models/${encodeURIComponent(configuration.model)}:${configuration.streamResponse ? "streamGenerateContent?alt=sse" : "generateContent"}`),
    body: { system_instruction: { parts: [{ text: configuration.systemPrompt }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: configuration.temperature, maxOutputTokens: configuration.maxOutputTokens } }
  };
  if (configuration.protocol === "ollama-native") return {
    url: endpoint(configuration.baseUrl, "api/chat"),
    body: { model: configuration.model, messages: [{ role: "system", content: configuration.systemPrompt }, { role: "user", content: prompt }], stream: configuration.streamResponse, options: { temperature: configuration.temperature, num_predict: configuration.maxOutputTokens } }
  };
  const outputLimit = configuration.provider === "openai"
    ? { max_completion_tokens: configuration.maxOutputTokens }
    : { max_tokens: configuration.maxOutputTokens };
  const providerOptions = isDeepSeek(configuration)
    ? { thinking: { type: "disabled" } }
    : {};
  return {
    url: endpoint(configuration.baseUrl, "chat/completions"),
    body: { model: configuration.model, messages: [{ role: "system", content: configuration.systemPrompt }, { role: "user", content: prompt }], temperature: configuration.temperature, stream: configuration.streamResponse, ...outputLimit, ...providerOptions }
  };
};

const responseContent = (protocol: StoredAiProfile["protocol"], value: unknown): string | undefined => {
  const record = value as Record<string, unknown>;
  if (protocol === "ollama-native") return ((record.message as Record<string, unknown> | undefined)?.content as string | undefined);
  if (protocol === "gemini-native") return (((record.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined)?.map((part) => part.text).filter((text): text is string => typeof text === "string").join("\n");
  const content = (((record.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content);
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (part as Record<string, unknown>).text).filter((text): text is string => typeof text === "string").join("\n") : undefined;
};

const streamContent = (protocol: StoredAiProfile["protocol"], value: unknown): string | undefined => {
  const record = value as Record<string, unknown>;
  if (protocol === "ollama-native") return ((record.message as Record<string, unknown> | undefined)?.content as string | undefined);
  if (protocol === "gemini-native") return (((record.candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined)?.map((part) => part.text).filter((text): text is string => typeof text === "string").join("");
  const content = (((record.choices as Array<Record<string, unknown>> | undefined)?.[0]?.delta as Record<string, unknown> | undefined)?.content);
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (part as Record<string, unknown>).text).filter((text): text is string => typeof text === "string").join("") : undefined;
};

const parseStreamingResponse = async (response: Response, protocol: StoredAiProfile["protocol"], onChunk?: (content: string) => void): Promise<string> => {
  if (!response.body) throw new Error("AI 服务未返回可读取的响应流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const consume = (line: string): void => {
    const normalized = protocol === "ollama-native" ? line.trim() : line.trim().replace(/^data:\s*/, "");
    if (!normalized || normalized === "[DONE]" || (!line.trim().startsWith("data:") && protocol !== "ollama-native")) return;
    const value = JSON.parse(normalized) as Record<string, unknown>;
    const chunk = streamContent(protocol, value);
    if (!chunk) return;
    content += chunk;
    onChunk?.(chunk);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) { if (buffer.trim()) consume(buffer); break; }
  }
  return content;
};

export const isAiStreamingEnabled = async (): Promise<boolean> => (await activeAiProfile()).streamResponse;

export const analyzeLogWithAi = async (input: AnalyzeLogInput, onChunk?: (content: string) => void) => {
  const configuration = await activeAiProfile();
  if (!isAiProfileConfigured(configuration)) throw new Error("当前日志分析模型尚未完成配置");
  const request = requestPayload(configuration, input.prompt);
  const startedAt = performance.now();
  const response = await fetch(request.url, { method: "POST", headers: requestHeaders(configuration), body: JSON.stringify(request.body), signal: AbortSignal.timeout(240_000) });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI 服务返回 HTTP ${response.status}：${body.slice(0, 1_200)}`);
  }
  if (configuration.streamResponse) {
    const content = await parseStreamingResponse(response, configuration.protocol, onChunk);
    if (!content.trim()) throw new Error("AI 响应中没有可显示的分析内容");
    return { content, provider: configuration.provider, model: configuration.model, durationMs: Math.round(performance.now() - startedAt), inputCharacters: input.inputCharacters, truncated: input.truncated };
  }
  const body = await response.text();
  const value = JSON.parse(body) as Record<string, unknown>;
  const content = responseContent(configuration.protocol, value);
  if (!content?.trim()) {
    const choice = (value.choices as Array<Record<string, unknown>> | undefined)?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const reasoning = message?.reasoning_content;
    if (choice?.finish_reason === "length" && typeof reasoning === "string" && reasoning.trim()) {
      throw new Error("模型的思考过程耗尽了输出 Token，尚未生成最终结论；请提高最大输出 Token 后重试");
    }
    throw new Error("AI 响应中没有可显示的分析内容");
  }
  return { content, provider: configuration.provider, model: configuration.model, durationMs: Math.round(performance.now() - startedAt), inputCharacters: input.inputCharacters, truncated: input.truncated };
};

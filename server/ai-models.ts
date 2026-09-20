import { z } from "zod";
import { loadStoredAiState, protocolSchema } from "./ai-configuration.js";

export const discoverAiModelsSchema = z.object({
  profileId: z.string().max(100).optional(), provider: z.string().max(80), protocol: protocolSchema,
  baseUrl: z.string().url().max(2_000), apiKey: z.string().max(5_000).optional()
});

interface ModelDescriptor { id: string; label: string; contextTokens?: number; maxOutputTokens?: number; recommendedLogCharacters?: number; limitsSource?: string }

const endpoint = (baseUrl: string, suffix: string): URL => new URL(baseUrl.endsWith(suffix) ? baseUrl : `${baseUrl.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`);
const numberValue = (...values: unknown[]): number | undefined => values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
const withRecommendation = (model: ModelDescriptor): ModelDescriptor => {
  if (!model.contextTokens) return model;
  const outputBudget = model.maxOutputTokens ?? Math.max(2_048, Math.ceil(model.contextTokens * .08));
  const promptBudget = Math.max(2_048, Math.ceil(model.contextTokens * .05));
  return { ...model, recommendedLogCharacters: Math.max(1, Math.min(100_000_000, Math.floor((model.contextTokens - outputBudget - promptBudget) * 2.8))) };
};

const credentials = async (input: z.infer<typeof discoverAiModelsSchema>): Promise<string | undefined> => {
  if (input.apiKey?.trim()) return input.apiKey.trim();
  const state = await loadStoredAiState();
  return state.profiles.find(({ id }) => id === input.profileId)?.apiKey ?? undefined;
};

export const discoverAiModels = async (input: z.infer<typeof discoverAiModelsSchema>): Promise<ModelDescriptor[]> => {
  const apiKey = await credentials(input);
  const headers = new Headers();
  if (apiKey && input.protocol === "gemini-native") headers.set("x-goog-api-key", apiKey);
  else if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  const url = input.protocol === "ollama-native" ? endpoint(input.baseUrl, "api/tags") : endpoint(input.baseUrl, "models");
  let response: Response;
  try { response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }); }
  catch (error) { throw new Error(`无法连接模型服务 ${url.origin}：${error instanceof Error ? error.message : String(error)}`); }
  const body = await response.text();
  if (!response.ok) throw new Error(`拉取模型列表失败（HTTP ${response.status}）：${body.slice(0, 800)}`);
  const value = JSON.parse(body) as Record<string, unknown>;
  const rows = input.protocol === "ollama-native" ? value.models : value.data ?? value.models;
  if (!Array.isArray(rows)) throw new Error("模型服务返回了无法识别的模型列表");
  return rows.map((row): ModelDescriptor | undefined => {
    if (typeof row === "string") return { id: row, label: row };
    if (!row || typeof row !== "object") return undefined;
    const record = row as Record<string, unknown>;
    const id = [record.id, record.name, record.model].find((item): item is string => typeof item === "string");
    if (!id) return undefined;
    const details = record.details && typeof record.details === "object" ? record.details as Record<string, unknown> : {};
    const contextTokens = numberValue(record.context_length, record.max_context_length, record.inputTokenLimit, details.context_length);
    const maxOutputTokens = numberValue(record.max_output_tokens, record.outputTokenLimit, details.max_output_tokens);
    return withRecommendation({ id, label: typeof record.display_name === "string" ? record.display_name : id, contextTokens, maxOutputTokens, limitsSource: contextTokens || maxOutputTokens ? "模型服务" : undefined });
  }).filter((model): model is ModelDescriptor => Boolean(model)).sort((left, right) => left.label.localeCompare(right.label));
};

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_AI_SYSTEM_PROMPT, upgradeDefaultAiSystemPrompt } from "../shared/ai-log-prompt.js";

export const DEFAULT_SYSTEM_PROMPT = DEFAULT_AI_SYSTEM_PROMPT;
export const protocolSchema = z.enum(["openai-compatible", "gemini-native", "ollama-native"]);

const profileFields = {
  id: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100),
  provider: z.string().trim().min(1).max(80), protocol: protocolSchema,
  baseUrl: z.string().trim().url().max(2_000), model: z.string().trim().min(1).max(160),
  systemPrompt: z.string().trim().min(1).max(20_000), temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().min(1).max(10_000_000),
  maxLogCharacters: z.number().int().min(1).max(100_000_000),
  streamResponse: z.boolean().default(true)
};

const validateUrl = (value: { baseUrl: string }, context: z.RefinementCtx): void => {
  const url = new URL(value.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    context.addIssue({ code: "custom", message: "AI 服务地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址", path: ["baseUrl"] });
  }
};

export const storedProfileSchema = z.object({ ...profileFields, apiKey: z.string().max(5_000).nullable() }).superRefine(validateUrl);
export const saveAiProfileSchema = z.object({ ...profileFields, apiKey: z.string().max(5_000).optional(), clearApiKey: z.boolean().optional(), setActive: z.boolean().optional() }).superRefine(validateUrl);
const storedStateSchema = z.object({ version: z.literal(2), activeProfileId: z.string(), profiles: z.array(storedProfileSchema).max(50) });
const legacySchema = z.object({ provider: z.string(), protocol: protocolSchema, baseUrl: z.string(), model: z.string(), apiKey: z.string().nullable(), systemPrompt: z.string(), temperature: z.number(), maxOutputTokens: z.number(), maxLogCharacters: z.number() });

export type StoredAiProfile = z.infer<typeof storedProfileSchema>;
type StoredAiState = z.infer<typeof storedStateSchema>;
export type PublicAiProfile = Omit<StoredAiProfile, "apiKey"> & { hasApiKey: boolean; configured: boolean };
export interface PublicAiState { version: 2; activeProfileId: string; profiles: PublicAiProfile[]; canConfigure: boolean }

const defaultProfile = (): StoredAiProfile => ({ id: "openai-default", name: "OpenAI", provider: "openai", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini", apiKey: null, systemPrompt: DEFAULT_SYSTEM_PROMPT, temperature: .2, maxOutputTokens: 8_192, maxLogCharacters: 120_000, streamResponse: true });
const requiresApiKey = (provider: string): boolean => !["ollama", "lm-studio"].includes(provider);
export const isAiProfileConfigured = (profile: StoredAiProfile): boolean => Boolean(profile.baseUrl && profile.model && (!requiresApiKey(profile.provider) || profile.apiKey));
const publicProfile = (profile: StoredAiProfile): PublicAiProfile => {
  const { apiKey: _apiKey, ...visible } = profile;
  return { ...visible, hasApiKey: Boolean(profile.apiKey), configured: isAiProfileConfigured(profile) };
};

const root = (): string => process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : process.platform === "win32" ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
const configurationPath = (): string => path.join(root(), "OpsLog", "shared-reader-settings", "ai-analysis.json");
const upgradePrompts = (state: StoredAiState): StoredAiState => ({
  ...state,
  profiles: state.profiles.map((profile) => ({ ...profile, systemPrompt: upgradeDefaultAiSystemPrompt(profile.systemPrompt) }))
});
const migrate = (value: unknown): StoredAiState => {
  const state = storedStateSchema.safeParse(value);
  if (state.success) return upgradePrompts(state.data);
  const legacy = legacySchema.safeParse(value);
  if (!legacy.success) throw new Error("AI 配置文件格式无效");
  const profile = storedProfileSchema.parse({ id: `${legacy.data.provider}-default`, name: legacy.data.provider, ...legacy.data });
  return upgradePrompts({ version: 2, activeProfileId: profile.id, profiles: [profile] });
};

export const loadStoredAiState = async (): Promise<StoredAiState> => {
  try { return migrate(JSON.parse(await readFile(configurationPath(), "utf8"))); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") { const profile = defaultProfile(); return { version: 2, activeProfileId: profile.id, profiles: [profile] }; }
    throw error;
  }
};

const persist = async (state: StoredAiState): Promise<void> => {
  const destination = configurationPath();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(destination, 0o600);
};

export const publicAiState = (state: StoredAiState, canConfigure = true): PublicAiState => ({ version: 2, activeProfileId: state.activeProfileId, profiles: state.profiles.map(publicProfile), canConfigure });
export const loadAiConfiguration = async (): Promise<PublicAiState> => publicAiState(await loadStoredAiState());
export const activeAiProfile = async (): Promise<StoredAiProfile> => {
  const state = await loadStoredAiState();
  const profile = state.profiles.find(({ id }) => id === state.activeProfileId);
  if (!profile) throw new Error("请选择用于日志分析的模型");
  return profile;
};

export const saveAiProfile = async (input: z.infer<typeof saveAiProfileSchema>): Promise<PublicAiState> => {
  const state = await loadStoredAiState();
  const current = state.profiles.find(({ id }) => id === input.id);
  const submittedKey = input.apiKey?.trim() || null;
  const profile = storedProfileSchema.parse({ ...input, systemPrompt: upgradeDefaultAiSystemPrompt(input.systemPrompt), apiKey: submittedKey ?? (input.clearApiKey ? null : current?.apiKey ?? null) });
  const profiles = [...state.profiles.filter(({ id }) => id !== profile.id), profile];
  const activeProfileId = input.setActive || !state.activeProfileId ? profile.id : state.activeProfileId;
  const next = storedStateSchema.parse({ version: 2, activeProfileId, profiles });
  await persist(next);
  return publicAiState(next);
};

export const activateAiProfile = async (id: string): Promise<PublicAiState> => {
  const state = await loadStoredAiState();
  if (!state.profiles.some((profile) => profile.id === id)) throw new Error("所选模型配置不存在");
  const next = { ...state, activeProfileId: id };
  await persist(next);
  return publicAiState(next);
};

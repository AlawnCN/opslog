import { useEffect, useRef, useState, type FormEvent } from "react";
import { AI_PROVIDER_PRESETS, DEFAULT_AI_SYSTEM_PROMPT } from "../ai-log-analysis";
import { discoverAiModels, type AiConfiguration, type AiModelDescriptor, type AiProtocol, type SaveAiConfigurationInput } from "../api";
import { AppSelect } from "./AppSelect";
import { CloseIcon } from "./Icons";
import { NumericInput } from "./NumericInput";

interface Props {
  configuration: AiConfiguration; saving: boolean; analyzeAfterSave: boolean; error?: string;
  onCancel: () => void; onSave: (input: SaveAiConfigurationInput) => void; onActivate: (id: string) => void;
  onImport: (profiles: SaveAiConfigurationInput[], activeProfileId?: string) => Promise<void>;
}

const editable = (profile: AiConfiguration["profiles"][number]): SaveAiConfigurationInput => ({ ...profile, apiKey: "", clearApiKey: false });
const requiresApiKey = (provider: string): boolean => !["ollama", "lm-studio"].includes(provider);
const newProfile = (provider: string): SaveAiConfigurationInput => {
  const preset = AI_PROVIDER_PRESETS.find(({ id }) => id === provider) ?? AI_PROVIDER_PRESETS[0];
  return { id: `${preset.id}-${crypto.randomUUID()}`, name: preset.label, provider: preset.id, protocol: preset.protocol, baseUrl: preset.baseUrl, model: preset.model, apiKey: "", systemPrompt: DEFAULT_AI_SYSTEM_PROMPT, temperature: .2, maxOutputTokens: 8_192, maxLogCharacters: 120_000, streamResponse: true };
};
const protocolOptions = [
  { value: "openai-compatible", label: "OpenAI 兼容接口" },
  { value: "gemini-native", label: "Gemini 原生接口" },
  { value: "ollama-native", label: "Ollama 原生接口" }
];
const profileChanged = (draft: SaveAiConfigurationInput, saved?: AiConfiguration["profiles"][number]): boolean => {
  if (!saved || draft.apiKey?.trim() || draft.clearApiKey) return true;
  return ["name", "provider", "protocol", "baseUrl", "model", "systemPrompt", "temperature", "maxOutputTokens", "maxLogCharacters", "streamResponse"]
    .some((field) => draft[field as keyof SaveAiConfigurationInput] !== saved[field as keyof typeof saved]);
};

export const AiLogConfigurationDialog = ({ configuration, saving, analyzeAfterSave, error, onCancel, onSave, onActivate, onImport }: Props) => {
  const [selectedId, setSelectedId] = useState(configuration.activeProfileId || configuration.profiles[0]?.id);
  const [drafts, setDrafts] = useState<Record<string, SaveAiConfigurationInput>>(() => Object.fromEntries(configuration.profiles.map((profile) => [profile.id, editable(profile)])));
  const [models, setModels] = useState<AiModelDescriptor[]>([]);
  const [modelStatus, setModelStatus] = useState<string>();
  const [loadingModels, setLoadingModels] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const form = drafts[selectedId];
  const saved = configuration.profiles.find(({ id }) => id === selectedId);

  useEffect(() => {
    setDrafts((current) => ({ ...current, ...Object.fromEntries(configuration.profiles.map((profile) => [profile.id, editable(profile)])) }));
  }, [configuration]);

  const update = (patch: Partial<SaveAiConfigurationInput>) => setDrafts((current) => ({ ...current, [selectedId]: { ...current[selectedId], ...patch } }));
  const add = (provider: string) => { const profile = newProfile(provider); setDrafts((current) => ({ ...current, [profile.id]: profile })); setSelectedId(profile.id); setModels([]); setModelStatus(undefined); };
  const select = (id: string) => { setSelectedId(id); setModels([]); setModelStatus(undefined); };

  const loadModels = async () => {
    if (!form) return;
    setLoadingModels(true); setModelStatus(undefined);
    try {
      const discovered = await discoverAiModels(form);
      setModels(discovered);
      setModelStatus(discovered.length ? `已同步 ${discovered.length} 个模型` : "服务未返回可用模型");
      if (discovered.length && !discovered.some(({ id }) => id === form.model)) applyModel(discovered[0], discovered);
    } catch (cause) { setModelStatus(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingModels(false); }
  };

  const applyModel = (model: AiModelDescriptor, source = models) => {
    const selected = source.find(({ id }) => id === model.id) ?? model;
    update({ model: selected.id, ...(selected.maxOutputTokens ? { maxOutputTokens: selected.maxOutputTokens } : {}), ...(selected.recommendedLogCharacters ? { maxLogCharacters: selected.recommendedLogCharacters } : {}) });
  };

  const exportConfiguration = () => {
    const contents = JSON.stringify({ version: 2, activeProfileId: configuration.activeProfileId, profiles: configuration.profiles.map(({ hasApiKey: _hasApiKey, configured: _configured, ...profile }) => profile), exportedAt: new Date().toISOString(), containsApiKeys: false }, null, 2);
    const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(new Blob([contents], { type: "application/json" })); anchor.download = "opslog-ai-models.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(anchor.href), 1_000);
  };

  const importConfiguration = async (file?: File) => {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text()) as { activeProfileId?: string; profiles?: SaveAiConfigurationInput[] };
      if (!Array.isArray(value.profiles) || !value.profiles.length) throw new Error("导入文件中没有模型配置");
      const profiles = value.profiles.map((profile) => ({ ...profile, streamResponse: profile.streamResponse ?? true, apiKey: "", clearApiKey: false }));
      const imported = Object.fromEntries(profiles.map((profile) => [profile.id, profile]));
      const activeProfileId = value.activeProfileId && imported[value.activeProfileId] ? value.activeProfileId : profiles[0].id;
      await onImport(profiles, activeProfileId);
      setDrafts((current) => ({ ...current, ...imported })); setSelectedId(activeProfileId);
      setModelStatus("配置已导入。导出文件不含 API Key；同 ID 配置会保留现有密钥。");
    } catch (cause) { setModelStatus(cause instanceof Error ? cause.message : String(cause)); }
  };

  if (!form) return null;
  const active = configuration.activeProfileId === selectedId;
  const savedKey = Boolean(saved?.hasApiKey) && !form.clearApiKey;
  const dirty = profileChanged(form, saved);
  const selectedModel = models.find(({ id }) => id === form.model);
  const modelOptions = models.map((model) => ({
    value: model.id,
    label: model.label,
    description: model.contextTokens ? `${model.contextTokens.toLocaleString()} Token 上下文` : undefined
  }));
  const limitsHint = selectedModel
    ? selectedModel.contextTokens || selectedModel.maxOutputTokens
      ? `服务能力：${selectedModel.contextTokens ? `${selectedModel.contextTokens.toLocaleString()} Token 上下文` : "上下文上限未提供"}${selectedModel.maxOutputTokens ? `，${selectedModel.maxOutputTokens.toLocaleString()} Token 输出` : "，输出上限未提供"}。`
      : "服务仅返回了模型名称，未提供上下文或输出上限；当前值保持不变。"
    : "同步并选择模型后，将采用服务明确返回的能力值；服务未提供时不会猜测。";

  return <div className="ai-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
    <form className="ai-config-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-config-title" onSubmit={(event: FormEvent) => { event.preventDefault(); onSave({ ...form, setActive: active || analyzeAfterSave }); }} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">AI ANALYSIS · CONFIGURATION</span><h2 id="ai-config-title">AI 分析配置</h2><p>管理模型连接，并指定日志分析使用的默认模型。</p></div><button type="button" aria-label="关闭 AI 配置" onClick={onCancel}><CloseIcon /></button></header>
      <div className="ai-config-workspace">
        <aside className="ai-profile-sidebar"><div className="ai-profile-heading"><span>模型连接</span><small>{Object.keys(drafts).length}</small></div><div className="ai-profile-list">{Object.values(drafts).map((profile) => <button type="button" key={profile.id} className={selectedId === profile.id ? "is-active" : undefined} onClick={() => select(profile.id)}><strong>{profile.name}</strong><span>{profile.model || "未选择模型"}</span>{configuration.activeProfileId === profile.id && <i>默认</i>}</button>)}</div><div className="ai-add-profile"><span>添加模型</span><AppSelect value="" placeholder="选择服务商" ariaLabel="选择 AI 服务商" options={AI_PROVIDER_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, description: preset.description }))} onChange={add} /></div><div className="ai-config-transfer"><button type="button" onClick={exportConfiguration}>导出配置</button><button type="button" onClick={() => importRef.current?.click()}>导入配置</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importConfiguration(event.target.files?.[0])} /></div></aside>
        <div className="ai-config-body"><div className="ai-profile-toolbar"><div><strong>{form.name}</strong><span>{!saved ? "未保存" : dirty ? "有未保存更改" : "已保存"}</span></div>{active ? <span className="ai-active-badge">默认模型</span> : <button type="button" onClick={() => onActivate(selectedId)} disabled={!saved || dirty}>设为默认</button>}</div>
          <div className="ai-config-fields">
            <label><span>配置名称</span><input required value={form.name} onChange={(event) => update({ name: event.target.value })} /></label>
            <label><span>接口协议</span><AppSelect value={form.protocol} ariaLabel="选择接口协议" options={protocolOptions} onChange={(value) => update({ protocol: value as AiProtocol })} /></label>
            <label className="is-wide"><span>服务地址</span><input required type="url" value={form.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} /></label>
            <label className="ai-model-field"><span>模型</span><div>{models.length
              ? <AppSelect value={form.model} placeholder="选择模型" ariaLabel="选择模型" options={modelOptions} onChange={(value) => { const model = models.find(({ id }) => id === value); if (model) applyModel(model); }} />
              : <input required value={form.model} placeholder="同步模型列表或输入模型 ID" onChange={(event) => update({ model: event.target.value })} />}
              <button type="button" onClick={() => void loadModels()} disabled={loadingModels}>{loadingModels ? "同步中…" : "同步模型"}</button></div>{modelStatus && <small>{modelStatus}</small>}</label>
            <label><span>API Key</span><input type="password" autoComplete="off" required={requiresApiKey(form.provider) && !savedKey} value={form.apiKey ?? ""} placeholder={savedKey ? "留空以保留现有密钥" : requiresApiKey(form.provider) ? "输入 API Key" : "本地服务无需填写"} onChange={(event) => update({ apiKey: event.target.value, clearApiKey: false })} /></label>
            {saved?.hasApiKey && <label className="ai-clear-key"><input type="checkbox" checked={form.clearApiKey} onChange={(event) => update({ clearApiKey: event.target.checked, apiKey: "" })} /><span>清除已保存的 API Key</span></label>}
            <label><span>生成随机性</span><NumericInput integer={false} minimum={0} maximum={2} value={form.temperature} onChange={(temperature) => update({ temperature })} ariaLabel="生成随机性" /></label>
            <label><span>输出长度上限（Token）</span><NumericInput minimum={1} maximum={10_000_000} value={form.maxOutputTokens} onChange={(maxOutputTokens) => update({ maxOutputTokens })} ariaLabel="输出长度上限" /><small>{limitsHint}</small></label>
            <label><span>日志输入上限（字符）</span><NumericInput minimum={1} maximum={100_000_000} value={form.maxLogCharacters} onChange={(maxLogCharacters) => update({ maxLogCharacters })} ariaLabel="日志输入上限" /><small>超过上限时自动合并重复内容，并优先保留异常、SQL、调用链与标记命中。</small></label>
            <div className="is-wide ai-stream-setting"><div><span>实时呈现分析结果</span><small>开启后，模型生成的内容会逐步显示；关闭后将在完整响应返回后统一显示。</small></div><button type="button" role="switch" aria-checked={form.streamResponse} className={form.streamResponse ? "is-on" : undefined} onClick={() => update({ streamResponse: !form.streamResponse })}><i /><span>{form.streamResponse ? "已开启" : "已关闭"}</span></button></div>
            <label className="is-wide ai-prompt-field"><span>系统提示词</span><textarea required rows={7} value={form.systemPrompt} onChange={(event) => update({ systemPrompt: event.target.value })} /><small>日志摘要、内置规则和自定义标记会在请求时自动附加。</small></label>
          </div>
          <p className="ai-data-notice">使用云端模型时，日志内容将发送至所选服务。导出文件不包含 API Key。</p>{error && <p className="ai-config-error" role="alert">{error}</p>}
        </div>
      </div>
      <footer><button type="button" onClick={onCancel}>取消</button><button type="submit" className="primary" disabled={saving}>{saving ? "保存中…" : analyzeAfterSave ? "保存并分析" : "保存"}</button></footer>
    </form>
  </div>;
};

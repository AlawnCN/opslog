import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { buildAiLogPrompt, DEFAULT_AI_SYSTEM_PROMPT } from "../ai-log-analysis";
import { activateAiConfiguration, analyzeLogWithAi, deleteAiConfiguration, errorMessage, loadAiConfiguration, saveAiConfiguration, type AiAnalyzeResult, type AiConfiguration, type AiProfile, type SaveAiConfigurationInput } from "../api";
import type { CustomLogMarker } from "../custom-log-markers";
import type { TransactionLogAnalysis } from "../transaction-log-model";
import { AiLogAnalysisDialog } from "./AiLogAnalysisDialog";
import { AiLogConfigurationDialog } from "./AiLogConfigurationDialog";
import { AiSparkIcon, SettingsIcon } from "./Icons";

interface AiLogAssistantProps {
  logId: string;
  content: string;
  analysis: TransactionLogAnalysis;
  customMarkers: CustomLogMarker[];
  disabled?: boolean;
}

export interface AiLogAssistantHandle {
  closeTopLayer: () => boolean;
}

export const AiLogAssistant = forwardRef<AiLogAssistantHandle, AiLogAssistantProps>(({ logId, content, analysis, customMarkers, disabled = false }, ref) => {
  const [configuration, setConfiguration] = useState<AiConfiguration>();
  const [configOpen, setConfigOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiAnalyzeResult>();
  const [error, setError] = useState<string>();
  const [analyzeAfterSave, setAnalyzeAfterSave] = useState(false);
  const analysisController = useRef<AbortController | undefined>(undefined);
  const analysisRun = useRef(0);
  const publishFrame = useRef(0);

  useEffect(() => {
    void loadAiConfiguration().then(setConfiguration).catch((cause) => setError(errorMessage(cause)));
  }, []);

  useEffect(() => {
    analysisController.current?.abort();
    analysisRun.current += 1;
    if (publishFrame.current) cancelAnimationFrame(publishFrame.current);
    publishFrame.current = 0;
    setAnalysisOpen(false); setLoading(false); setResult(undefined); setError(undefined);
  }, [logId]);

  useEffect(() => () => {
    analysisController.current?.abort();
    if (publishFrame.current) cancelAnimationFrame(publishFrame.current);
  }, []);

  const activeProfile = configuration?.profiles.find(({ id }) => id === configuration.activeProfileId);

  const runAnalysis = useCallback(async (profile: AiProfile) => {
    analysisController.current?.abort();
    if (publishFrame.current) cancelAnimationFrame(publishFrame.current);
    const controller = new AbortController();
    analysisController.current = controller;
    const run = ++analysisRun.current;
    const request = buildAiLogPrompt({ logId, content, analysis, customMarkers, configuration: profile });
    setAnalysisOpen(true);
    setConfigOpen(false);
    setLoading(true);
    setResult(undefined);
    setError(undefined);
    let streamedContent = "";
    const startedAt = performance.now();
    const publish = () => {
      publishFrame.current = 0;
      if (controller.signal.aborted || run !== analysisRun.current) return;
      setResult({ content: streamedContent, provider: profile.provider, model: profile.model, durationMs: Math.round(performance.now() - startedAt), inputCharacters: request.inputCharacters, truncated: request.truncated });
    };
    try {
      const completed = await analyzeLogWithAi(request.prompt, request.inputCharacters, request.truncated, (chunk) => {
        if (controller.signal.aborted || run !== analysisRun.current) return;
        streamedContent += chunk;
        if (!publishFrame.current) publishFrame.current = requestAnimationFrame(publish);
      }, controller.signal);
      if (publishFrame.current) cancelAnimationFrame(publishFrame.current);
      publishFrame.current = 0;
      if (controller.signal.aborted || run !== analysisRun.current) return;
      setResult(completed);
    } catch (cause) {
      if (publishFrame.current) cancelAnimationFrame(publishFrame.current);
      publishFrame.current = 0;
      if (controller.signal.aborted || run !== analysisRun.current) return;
      setError(errorMessage(cause));
    } finally {
      if (run === analysisRun.current) {
        analysisController.current = undefined;
        setLoading(false);
      }
    }
  }, [analysis, content, customMarkers, logId]);

  const closeAnalysis = useCallback(() => {
    analysisController.current?.abort();
    analysisController.current = undefined;
    analysisRun.current += 1;
    if (publishFrame.current) cancelAnimationFrame(publishFrame.current);
    publishFrame.current = 0;
    setAnalysisOpen(false); setLoading(false); setResult(undefined); setError(undefined);
  }, []);

  const activate = () => {
    if (disabled || !content.trim()) return;
    if (configuration && !activeProfile?.configured && !configuration.canConfigure) {
      setAnalysisOpen(true);
      setError("请先在 OpsLog 主机端完成 AI 配置");
      return;
    }
    if (!activeProfile?.configured) {
      setAnalyzeAfterSave(true);
      setConfigOpen(true);
      return;
    }
    void runAnalysis(activeProfile);
  };

  const saveConfiguration = async (input: SaveAiConfigurationInput) => {
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveAiConfiguration(input);
      setConfiguration(saved);
      const profile = saved.profiles.find(({ id }) => id === saved.activeProfileId);
      if (analyzeAfterSave && profile?.configured) { setConfigOpen(false); await runAnalysis(profile); }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
      setAnalyzeAfterSave(false);
    }
  };

  const importConfigurations = async (profiles: SaveAiConfigurationInput[], activeProfileId?: string) => {
    setSaving(true);
    setError(undefined);
    try {
      let saved = configuration;
      for (const profile of profiles) {
        saved = await saveAiConfiguration({ ...profile, setActive: profile.id === activeProfileId });
      }
      if (saved) setConfiguration(saved);
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setSaving(false);
    }
  };

  const removeConfiguration = async (id: string) => {
    setSaving(true); setError(undefined);
    try {
      const saved = await deleteAiConfiguration(id);
      setConfiguration(saved);
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setSaving(false);
    }
  };

  useImperativeHandle(ref, () => ({
    closeTopLayer: () => {
      if (configOpen) { setConfigOpen(false); return true; }
      if (analysisOpen) { closeAnalysis(); return true; }
      return false;
    }
  }), [analysisOpen, closeAnalysis, configOpen]);

  const currentConfiguration = configuration ?? { version: 2, activeProfileId: "openai-default", canConfigure: true, profiles: [{
    id: "openai-default", name: "OpenAI", provider: "openai", protocol: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini",
    hasApiKey: false, configured: false, systemPrompt: DEFAULT_AI_SYSTEM_PROMPT, temperature: .2, maxOutputTokens: 8_192, maxLogCharacters: 120_000, streamResponse: true, responseLanguage: "zh-CN"
  }] } satisfies AiConfiguration;

  return <>
    <div className={`ai-log-action${activeProfile?.configured ? " is-configured" : ""}`}>
      <button type="button" className="ai-log-primary" disabled={disabled || !content.trim()} title={disabled || !content.trim() ? "日志加载完成后可使用 AI 分析" : activeProfile?.configured ? `使用 ${activeProfile.model} 分析当前日志` : "配置 AI 并分析当前日志"} onClick={activate}><AiSparkIcon /><span><b>AI</b> 分析</span><i /></button>
      {configuration?.canConfigure !== false && <button type="button" className="ai-log-settings" title="AI 配置" aria-label="AI 配置" onClick={() => { closeAnalysis(); setAnalyzeAfterSave(false); setError(undefined); setConfigOpen(true); }}><SettingsIcon /></button>}
    </div>
    {configOpen && <AiLogConfigurationDialog configuration={currentConfiguration} saving={saving} analyzeAfterSave={analyzeAfterSave} error={error} onCancel={() => { setAnalyzeAfterSave(false); setConfigOpen(false); setError(undefined); }} onSave={(input) => void saveConfiguration(input)} onActivate={(id) => void activateAiConfiguration(id).then(setConfiguration).catch((cause) => setError(errorMessage(cause)))} onDelete={removeConfiguration} onImport={importConfigurations} />}
    {analysisOpen && <AiLogAnalysisDialog logId={logId} loading={loading} result={result} error={error} onClose={closeAnalysis} onRetry={activeProfile?.configured ? () => void runAnalysis(activeProfile) : undefined} />}
  </>;
});

AiLogAssistant.displayName = "AiLogAssistant";

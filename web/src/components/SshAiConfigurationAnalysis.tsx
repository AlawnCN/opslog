import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SSH_CONFIGURATION_PROMPT } from "../../../shared/ssh-log-rules";
import { parseSshAiResult } from "../../../shared/ssh-ai-result";
import { prepareSshAiSamples, validateSshAiSamples } from "../../../shared/ssh-ai-samples";
import { activateAiConfiguration, analyzeLogWithAi, deleteAiConfiguration, errorMessage, loadAiConfiguration, sampleSshLogs, saveAiConfiguration, type AiConfiguration, type SaveAiConfigurationInput, type SshLogSample } from "../api";
import type { EnvironmentConfiguration, SshApplicationConfiguration, SshServerConfiguration } from "../types";
import { validateEnvironmentConfigurations } from "../environment-configuration";
import { parseSshHostKeyChallenge, trustSshHostKey, type SshHostKeyChallenge } from "../ssh-host-key";
import { AiLogConfigurationDialog } from "./AiLogConfigurationDialog";
import { AiSparkIcon, SettingsIcon } from "./Icons";
import { SshLogRulesEditor } from "./SshLogRulesEditor";
import { SshHostKeyDialog } from "./SshHostKeyDialog";

interface Props { environment: EnvironmentConfiguration; onApply: (applications: SshApplicationConfiguration[]) => void; onTrustServer: (servers: SshServerConfiguration[]) => void; onPendingChange: (pending: boolean) => void }
export const SshAiConfigurationAnalysis = ({ environment, onApply, onTrustServer, onPendingChange }: Props) => {
  const [configuration, setConfiguration] = useState<AiConfiguration>();
  const [configOpen, setConfigOpen] = useState(false);
  const [analyzeAfterSave, setAnalyzeAfterSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [samples, setSamples] = useState<SshLogSample[]>();
  const [proposal, setProposal] = useState<SshApplicationConfiguration[]>();
  const [rawResponse, setRawResponse] = useState("");
  const [status, setStatus] = useState("");
  const [pendingHostKey, setPendingHostKey] = useState<SshHostKeyChallenge>();
  const [phase, setPhase] = useState<"idle" | "preparing" | "sampling" | "trust" | "analyzing" | "complete" | "applied" | "cancelled" | "error">("idle");
  const feedback = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const snapshot = useRef("");
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { onPendingChange(busy || !!proposal || !!pendingHostKey || configOpen); }, [busy, proposal, pendingHostKey, configOpen, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  useEffect(() => {
    if (!["complete", "error"].includes(phase)) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    feedback.current?.scrollIntoView({block:"nearest",behavior:reducedMotion?"auto":"smooth"});
    feedback.current?.focus({preventScroll:true});
  }, [phase]);
  const requireHostKeyTrust = (message: string): boolean => {
    const challenge = parseSshHostKeyChallenge(message);
    if (!challenge) return false;
    setPendingHostKey(challenge);
    setError(undefined);
    setPhase("trust");
    setStatus("请先核对并确认 SSH 服务器指纹；确认后将自动继续采样和 AI 分析。");
    return true;
  };
  const sample = async (current: AiConfiguration, target = environment) => {
    const invalid = validateEnvironmentConfigurations([target]);
    if (invalid) { setError(invalid); setPhase("error"); setBusy(false); return; }
    controller.current?.abort(); const next = new AbortController(); controller.current = next;
    snapshot.current = JSON.stringify(target);
    setBusy(true); setPhase("sampling"); setError(undefined); setProposal(undefined); setRawResponse(""); setSamples(undefined); setStatus(target.sourceType === "local" ? "正在采样本地日志…" : "正在限量采样服务器日志…");
    try {
      const result = await sampleSshLogs(target, next.signal);
      if (next.signal.aborted) return;
      if (result.some((app) => app.warnings.some(requireHostKeyTrust))) return;
      if (!result.some((app) => app.samples.some((server) => server.files.length))) throw new Error("未找到日志样本，请检查应用目录与读取权限");
      setSamples(result);
      await analyze(result, current, next, target);
    } catch (cause) { if (!next.signal.aborted && !requireHostKeyTrust(errorMessage(cause))) { setError(errorMessage(cause)); setPhase("error"); setStatus(""); } }
    finally { if (!next.signal.aborted) setBusy(false); }
  };
  const begin = async () => {
    controller.current?.abort(); const next = new AbortController(); controller.current = next;
    setBusy(true); setPhase("preparing"); setStatus("正在加载 AI 配置…"); setError(undefined);
    try {
      const current = await loadAiConfiguration(); if(next.signal.aborted) return; setConfiguration(current);
      if (!current.profiles.find((profile) => profile.id === current.activeProfileId)?.configured) { setBusy(false); setPhase("idle"); setStatus("请先配置 AI 服务。"); setAnalyzeAfterSave(true); setConfigOpen(true); return; }
      await sample(current);
    } catch (cause) { if(!next.signal.aborted) {setError(errorMessage(cause));setBusy(false);setPhase("error");setStatus("");} }
  };
  const analyze = async (collected: SshLogSample[], current: AiConfiguration, next: AbortController, target: EnvironmentConfiguration) => {
    if (next.signal.aborted) return;
    const profile = current.profiles.find((item) => item.id === current.activeProfileId);
    if (!profile?.configured) throw new Error("请先配置 AI 服务");
    if (snapshot.current !== JSON.stringify(target)) throw new Error("环境配置已变更，请重新采样");
    const budget = Math.min(profile.maxLogCharacters, 120_000);
    const instructions = target.sourceType === "local" ? SSH_CONFIGURATION_PROMPT.replace("SSH 日志适配", "本地文件日志适配") + "\n当前为 Local 模式：样本来自配置的本地应用根目录，server=Local 仅为来源标签，不存在 SSH 或服务器组。遵循相同的汇总、字段和明细规范，不生成服务器或连接配置。" : SSH_CONFIGURATION_PROMPT;
    const context = prepareSshAiSamples(collected, budget - instructions.length - 1000);
    const buildPrompt = () => `${instructions}\n用户已配置应用：${JSON.stringify(collected.map(({name})=>name))}\n以下是限量日志样本，可能截断、缺失或已脱敏：\n${JSON.stringify(context)}`;
    if (buildPrompt().length > budget) throw new Error("当前模型输入上限不足，请提高日志输入上限或减少监控应用");
    const prompt = buildPrompt();
    setBusy(true); setPhase("analyzing"); setError(undefined); setProposal(undefined); setRawResponse(""); setStatus("正在分析日志样本并校验参数…");
    try {
      const result = await analyzeLogWithAi(prompt, prompt.length, true, undefined, next.signal, "ssh-configuration");
      if (next.signal.aborted) return;
      // Preserve the provider response even when parsing/validation fails.
      // Applying always revalidates it; invalid output never changes the draft.
      setRawResponse(result.content);
      const parsed = parseSshAiResult(result.content);
      validateSshAiSamples(parsed, context);
      const names = new Set(target.sshMonitoredApplications?.map((app) => app.name));
      if (new Set(parsed.applications.map((app) => app.name)).size !== parsed.applications.length || parsed.applications.some((app) => !names.has(app.name))) throw new Error("AI 返回了未配置或重复的应用，未应用结果");
      setProposal((target.sshMonitoredApplications ?? []).map((app)=>{
        const inferred=parsed.applications.find((item)=>item.name===app.name);
        return inferred?{...app,logSources:inferred.logSources,analysisNotes:parsed.notes}:app;
      }));
      setPhase("complete"); setStatus(`分析完成 · ${parsed.applications.length} 个应用 / ${parsed.applications.reduce((count,app)=>count+app.logSources.length,0)} 个日志源。请核对下方参数，应用并保存后生效。`);
    } catch (cause) { if (!next.signal.aborted) { setError(errorMessage(cause)); setPhase("error"); setStatus(""); } }
    finally { if (!next.signal.aborted) setBusy(false); }
  };
  const apply = () => {
    try {
      if (snapshot.current !== JSON.stringify(environment)) throw new Error("环境配置已变更，请重新分析");
      if (!proposal) return;
      if (samples) validateSshAiSamples({ applications: proposal.map(app => ({ name: app.name, logSources: app.logSources ?? [] })), notes: [] }, samples);
      const invalid = validateEnvironmentConfigurations([{...environment,sshMonitoredApplications:proposal}]);
      if (invalid) throw new Error(invalid);
      onApply(proposal);
      setProposal(undefined); setRawResponse(""); setSamples(undefined); setPhase("applied"); setStatus("参数已应用 · 尚未保存。请点击“保存配置”使其生效。"); setError(undefined);
    } catch (cause) { setError(errorMessage(cause)); setPhase("error"); }
  };
  const saveProfile = async (input: SaveAiConfigurationInput) => {
    setSaving(true); setError(undefined);
    try { const saved = await saveAiConfiguration({ ...input, setActive: true }); setConfiguration(saved); setConfigOpen(false); if (analyzeAfterSave) await sample(saved); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };
  const confirmHostKey = () => {
    const challenge = pendingHostKey;
    if (!challenge || !configuration) return;
    try {
      const sshServers = trustSshHostKey(environment.sshServers ?? [], challenge);
      const trusted = { ...environment, sshServers };
      onTrustServer(sshServers);
      setPendingHostKey(undefined);
      void sample(configuration, trusted);
    } catch (cause) { setPendingHostKey(undefined); setError(errorMessage(cause)); setPhase("error"); setStatus(""); }
  };
  return <section className="ssh-ai-rules is-wide">
    <div className="environment-repeatable-heading"><div><strong>日志解析参数</strong><small>手动配置或由 AI 生成。</small></div><div className="ssh-ai-actions" role="group" aria-label="AI 分析与设置">
      <button type="button" disabled={busy || !!proposal} title={proposal ? "请先应用参数或放弃当前结果" : undefined} aria-busy={busy} onClick={() => void begin()}>{busy?<span className="button-spinner" aria-hidden="true"/>:<AiSparkIcon />}{busy?(phase==="analyzing"?"分析中…":phase==="sampling"?"采样中…":"准备中…"):"AI 分析"}</button>
      <button type="button" className="ssh-ai-settings" disabled={busy} aria-label="AI 设置" title="AI 设置" onClick={() => void loadAiConfiguration().then((value) => { setConfiguration(value); setAnalyzeAfterSave(false); setConfigOpen(true); }).catch((cause) => setError(errorMessage(cause)))}><SettingsIcon /></button>
    </div></div>
    <div ref={feedback} tabIndex={-1} className={`ssh-ai-feedback is-${phase}`}>
      {status && <p role="status" aria-live="polite" aria-atomic="true">{status}</p>}
      {error && <p className="environment-config-error" role="alert">{error}</p>}
      {busy && <button type="button" onClick={() => {controller.current?.abort(); setBusy(false); setPhase("cancelled"); setError(undefined);setStatus("已取消，参数未变更。");}}>取消{phase==="analyzing"?"分析":"采样"}</button>}
      {proposal && <div className="ssh-ai-proposal-banner"><strong>AI 参数预览</strong><span>未应用，可编辑。</span><button type="button" disabled={busy} onClick={apply}>应用参数</button><button type="button" disabled={busy} onClick={()=>{setProposal(undefined);setSamples(undefined);setRawResponse("");setPhase("idle");setStatus("已放弃，参数未变更。");setError(undefined);}}>放弃</button></div>}
    </div>
    <p>采样日志将发送至 AI 服务，可能含敏感信息。</p>
    {samples && !busy && <details><summary>查看本次采样内容</summary><pre>{JSON.stringify(samples,null,2)}</pre></details>}
    <SshLogRulesEditor applications={proposal ?? environment.sshMonitoredApplications ?? []} disabled={busy} onChange={(applications)=>{
      if(proposal) setProposal(applications); else {onApply(applications);setSamples(undefined);setRawResponse("");setPhase("idle");setStatus("参数已修改，尚未保存。");}
      setError(undefined);
    }}/>
    {rawResponse && error && <details><summary>AI 返回原文（诊断信息）</summary><pre>{rawResponse}</pre></details>}
    {configOpen && configuration && createPortal(<AiLogConfigurationDialog configuration={configuration} saving={saving} analyzeAfterSave={analyzeAfterSave} error={error} onCancel={()=>setConfigOpen(false)} onSave={(input)=>void saveProfile(input)}
      onActivate={(id)=>void activateAiConfiguration(id).then(setConfiguration).catch((cause)=>setError(errorMessage(cause)))}
      onDelete={async(id)=>{setConfiguration(await deleteAiConfiguration(id));}}
      onImport={async(profiles,activeId)=>{for(const input of profiles)setConfiguration(await saveAiConfiguration({...input,setActive:input.id===activeId}));}} />, document.body)}
    {pendingHostKey && <SshHostKeyDialog challenge={pendingHostKey} busy={false} detail="确认后继续分析；保存配置以保留指纹。" onCancel={() => { setPendingHostKey(undefined); setPhase("cancelled"); setStatus("已取消主机指纹确认；当前参数未变更。"); }} onConfirm={confirmHostKey} />}
  </section>;
};

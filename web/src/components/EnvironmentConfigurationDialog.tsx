import { useEffect, useRef, useState, type FormEvent } from "react";
import { saveEnvironmentConfigurationExport } from "../api";
import {
  createEnvironmentConfiguration, normalizeEnvironmentConfiguration, parseEnvironmentConfigurationFile,
  serializeEnvironmentConfigurations, validateEnvironmentConfigurations
} from "../environment-configuration";
import { cloneEnvironmentConfiguration, mergeImportedEnvironments, remapSelectionAfterMove, remapSelectionAfterRemove } from "../environment-transfer";
import type { EnvironmentConfiguration, EnvironmentSource, SshApplicationConfiguration, SshServerConfiguration } from "../types";
import { CloseIcon, DownloadIcon, ImportIcon, TrashIcon } from "./Icons";
import { useMovableDialog } from "./useMovableDialog";
import { AppSelect } from "./AppSelect";
import { EnvironmentImportReview } from "./EnvironmentImportReview";
import { EnvironmentSourceBadge } from "./EnvironmentSourceBadge";
import { SearchableSelect } from "./SearchableSelect";

interface EnvironmentConfigurationDialogProps {
  environments: EnvironmentConfiguration[];
  loading: boolean;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (environments: EnvironmentConfiguration[]) => void;
}

const clone = (items: EnvironmentConfiguration[]): EnvironmentConfiguration[] => items.map((item) => normalizeEnvironmentConfiguration(item));
const connectionSummary = (item: EnvironmentConfiguration): string => item.sourceType === "ssh"
  ? `${item.sshServers?.length ?? 0} 台服务器 · ${item.sshMonitoredApplications?.length ?? 0} 个应用`
  : item.kibanaUrl || "未配置服务地址";

const TIME_ZONE_OPTIONS = (() => {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  const values = supportedValuesOf?.("timeZone") ?? ["Africa/Nairobi", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Europe/London", "UTC"];
  return Array.from(new Set(["UTC", ...values])).map((timeZone) => ({ value: timeZone, label: timeZone.replaceAll("_", " ") }));
})();

const SshServerList = ({ value, onChange }: { value: SshServerConfiguration[]; onChange: (value: SshServerConfiguration[]) => void }) => {
  const update = (index: number, changes: Partial<SshServerConfiguration>) => onChange(value.map((server, current) => current === index ? { ...server, ...changes } : server));
  return <div className="environment-repeatable is-wide">
    <div className="environment-repeatable-heading"><div><strong>服务器组</strong><small>并行检索组内服务器并合并结果</small></div><button type="button" onClick={() => onChange([...value, { name: `server-${value.length + 1}`, host: "", username: "", authentication: "ssh-config", password: "", privateKeyPath: "" }])}>＋ 添加服务器</button></div>
    <div className="environment-server-list">{value.map((server, index) => <article key={index}>
      <div className="environment-server-card-title"><strong>{server.name || `服务器 ${index + 1}`}</strong><button type="button" aria-label={`移除服务器 ${server.name || index + 1}`} disabled={value.length <= 1} onClick={() => onChange(value.filter((_, current) => current !== index))}><TrashIcon /></button></div>
      <div className="environment-server-fields">
        <label><span>服务器名称</span><input value={server.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="例如 m5-uat-01" /></label>
        <label><span>主机 / SSH Config 别名</span><input value={server.host} onChange={(event) => update(index, { host: event.target.value })} placeholder="m5.uat 或 10.0.0.8" /></label>
        <label><span>认证方式</span><AppSelect value={server.authentication} ariaLabel="SSH 认证方式" options={[{ value: "ssh-config", label: "SSH Config" }, { value: "private-key", label: "用户名 + 私钥" }, { value: "password", label: "用户名 + 密码" }]} onChange={(authentication) => update(index, { authentication: authentication as SshServerConfiguration["authentication"], port: authentication === "ssh-config" ? undefined : server.port })} />{server.authentication === "ssh-config" && <small>主机、用户、端口和密钥均由 SSH Config 解析。</small>}</label>
        {server.authentication !== "ssh-config" && <label><span>端口（可选）</span><input type="number" min="1" max="65535" value={server.port ?? ""} onChange={(event) => update(index, { port: event.target.value ? Number(event.target.value) : undefined })} placeholder="默认 22" /></label>}
        {server.authentication !== "ssh-config" && <label><span>用户名</span><input autoComplete="off" value={server.username ?? ""} onChange={(event) => update(index, { username: event.target.value })} /></label>}
        {server.authentication === "password" && <label><span>密码</span><input type="password" autoComplete="new-password" value={server.password ?? ""} onChange={(event) => update(index, { password: event.target.value })} /></label>}
        {server.authentication === "private-key" && <label><span>私钥路径</span><input value={server.privateKeyPath ?? ""} onChange={(event) => update(index, { privateKeyPath: event.target.value })} placeholder="~/.ssh/id_ed25519" /></label>}
      </div>
    </article>)}</div>
  </div>;
};

const SshApplicationList = ({ value, onChange }: { value: SshApplicationConfiguration[]; onChange: (value: SshApplicationConfiguration[]) => void }) => {
  const update = (index: number, changes: Partial<SshApplicationConfiguration>) => onChange(value.map((application, current) => current === index ? { ...application, ...changes } : application));
  return <div className="environment-repeatable is-wide">
    <div className="environment-repeatable-heading"><div><strong>应用目录映射</strong><small>定义应用标识与日志根目录的映射关系</small></div><button type="button" onClick={() => onChange([...value, { name: "", directory: "/home/coradm/" }])}>＋ 添加映射</button></div>
    <div className="environment-application-list">{value.map((application, index) => <div key={index}>
      <label><span>应用简称</span><input value={application.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="cte" /></label>
      <label><span>应用根目录</span><input value={application.directory} onChange={(event) => update(index, { directory: event.target.value })} placeholder="/home/coradm/cte" /></label>
      <button type="button" aria-label={`移除应用 ${application.name || index + 1}`} disabled={value.length <= 1} onClick={() => onChange(value.filter((_, current) => current !== index))}><TrashIcon /></button>
    </div>)}</div>
  </div>;
};

export const EnvironmentConfigurationDialog = ({ environments, loading, saving, error, onClose, onSave }: EnvironmentConfigurationDialogProps) => {
  const [drafts, setDrafts] = useState<EnvironmentConfiguration[]>(() => clone(environments));
  const [selected, setSelected] = useState(0);
  const [localError, setLocalError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number>();
  const [dragOverIndex, setDragOverIndex] = useState<number>();
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [exportMode, setExportMode] = useState(false);
  const [transferSelection, setTransferSelection] = useState<Set<number>>(new Set());
  const [importCandidates, setImportCandidates] = useState<EnvironmentConfiguration[]>();
  const [importSelection, setImportSelection] = useState<Set<number>>(new Set());
  const importRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const movable = useMovableDialog<HTMLFormElement>();

  useEffect(() => { setDrafts(clone(environments)); setSelected(0); setConfirmRemove(false); setExportMode(false); setTransferSelection(new Set()); }, [environments]);
  const current = drafts[selected];
  const update = (changes: Partial<EnvironmentConfiguration>) => {
    setLocalError(undefined); setNotice(undefined);
    setDrafts((items) => items.map((item, index) => index === selected ? { ...item, ...changes } : item));
  };
  const addEnvironment = (sourceType: EnvironmentSource) => {
    const nextIndex = drafts.length;
    setDrafts((items) => [...items, { ...createEnvironmentConfiguration(items.length + 1), sourceType }]);
    setSelected(nextIndex); setAddSourceOpen(false); setConfirmRemove(false); setNotice(`${sourceType.toUpperCase()} 环境已创建，保存后生效。`);
    requestAnimationFrame(() => { const item = listRef.current?.querySelector<HTMLElement>(`[data-environment-index="${nextIndex}"]`); item?.scrollIntoView({ behavior: "smooth", block: "nearest" }); item?.focus(); });
  };
  const cloneEnvironment = () => {
    if (!current) return;
    const copy = cloneEnvironmentConfiguration(current, drafts);
    const nextIndex = drafts.length;
    setDrafts((items) => [...items, copy]);
    setSelected(nextIndex); setAddSourceOpen(false); setConfirmRemove(false); setNotice(`已创建副本：${copy.name}`);
    requestAnimationFrame(() => { const item = listRef.current?.querySelector<HTMLElement>(`[data-environment-index="${nextIndex}"]`); item?.scrollIntoView({ behavior: "smooth", block: "nearest" }); item?.focus(); });
  };
  const removeEnvironment = () => {
    if (drafts.length <= 1) return;
    setDrafts((items) => items.filter((_, index) => index !== selected));
    setTransferSelection((selection) => remapSelectionAfterRemove(selection, selected));
    setSelected((index) => Math.max(0, Math.min(index, drafts.length - 2))); setConfirmRemove(false);
  };
  const moveEnvironment = (from: number, to: number) => {
    if (from === to) return;
    setLocalError(undefined);
    setNotice("环境排序已更新，保存后生效。");
    setTransferSelection((selection) => remapSelectionAfterMove(selection, from, to));
    setDrafts((items) => {
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setSelected((currentIndex) => {
      if (currentIndex === from) return to;
      if (from < to && currentIndex > from && currentIndex <= to) return currentIndex - 1;
      if (to < from && currentIndex >= to && currentIndex < from) return currentIndex + 1;
      return currentIndex;
    });
  };
  const importConfiguration = async (file?: File) => {
    if (!file) return;
    try {
      const imported = parseEnvironmentConfigurationFile(await file.text());
      setImportCandidates(imported); setImportSelection(new Set(imported.map((_, index) => index))); setLocalError(undefined);
    } catch (importError) { setLocalError(importError instanceof Error ? importError.message : "无法读取配置文件"); }
    finally { if (importRef.current) importRef.current.value = ""; }
  };
  const applyImport = () => {
    if (!importCandidates) return;
    const selectedCandidates = importCandidates.filter((_, index) => importSelection.has(index));
    const merged = mergeImportedEnvironments(drafts, selectedCandidates);
    setDrafts(merged.environments); setExportMode(false); setTransferSelection(new Set());
    if (merged.importedIndexes[0] !== undefined) setSelected(merged.importedIndexes[0]);
    setImportCandidates(undefined); setImportSelection(new Set()); setConfirmRemove(false);
    setNotice(`导入完成：新增 ${merged.added}，更新 ${merged.updated}。`);
  };
  const exportConfiguration = async () => {
    const selectedDrafts = drafts.filter((_, index) => transferSelection.has(index));
    if (!selectedDrafts.length) { setLocalError("请先在环境列表中选择至少一个要导出的环境"); return; }
    try {
      setLocalError(undefined);
      await saveEnvironmentConfigurationExport(serializeEnvironmentConfigurations(selectedDrafts));
      setExportMode(false); setTransferSelection(new Set()); setNotice(`已导出 ${selectedDrafts.length} 个环境（不含凭据）。`);
    } catch (exportError) { setLocalError(exportError instanceof Error ? exportError.message : "无法导出配置"); }
  };
  const toggleTransferSelection = (index: number) => setTransferSelection((selection) => {
    const next = new Set(selection);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  const toggleImportSelection = (index: number) => setImportSelection((selection) => {
    const next = new Set(selection);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const validation = validateEnvironmentConfigurations(drafts);
    if (validation) {
      setLocalError(validation);
      const invalidIndex = drafts.findIndex((item) => validation.startsWith(`${item.name}：`) || validation.startsWith(`${item.name} / `));
      if (invalidIndex >= 0) {
        setSelected(invalidIndex);
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-environment-index="${invalidIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
      }
      return;
    }
    onSave(drafts.map((rawItem) => {
      const item = normalizeEnvironmentConfiguration(rawItem);
      return {
        ...item, name: item.name.trim(), kibanaUrl: item.kibanaUrl.trim(), timeZone: item.timeZone?.trim(),
        sshHost: undefined, sshBaseDirectory: undefined, sshApplications: undefined,
        sshServers: item.sourceType === "ssh" ? item.sshServers?.map((server) => ({ ...server, name: server.name.trim(), host: server.host.trim(), username: server.username?.trim(), privateKeyPath: server.privateKeyPath?.trim() })) : [],
        sshMonitoredApplications: item.sourceType === "ssh" ? item.sshMonitoredApplications?.map((application) => ({ name: application.name.trim(), directory: application.directory.trim().replace(/\/+$/, "") })) : []
      };
    }));
  };

  return <div className="environment-config-backdrop" role="presentation" onMouseDown={saving ? undefined : onClose}>
    <form ref={movable.dialogRef} style={movable.dialogStyle} className="environment-config-dialog movable-dialog" role="dialog" aria-modal="true" aria-labelledby="environment-config-title" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <header onPointerDown={movable.startMove}><div><span className="eyebrow">OPSLOG · ENVIRONMENT SETTINGS</span><h2 id="environment-config-title">运行环境配置</h2><p>管理日志源、连接参数、检索范围与时区策略。</p></div><button type="button" aria-label="关闭运行环境配置" disabled={saving} onClick={onClose}><CloseIcon /></button></header>
      <div className="environment-config-workspace">
        <aside><div className="environment-config-list-heading"><span>运行环境</span><small>{drafts.length}</small></div>
          <div ref={listRef} className="environment-config-list">{drafts.map((item, index) => <div data-environment-index={index} tabIndex={-1} draggable={!exportMode} key={`${index}-${item.name}`} className={`environment-config-list-item${selected === index ? " is-active" : ""}${dragOverIndex === index ? " is-drag-over" : ""}${exportMode ? " is-exporting" : ""}`} onDragStart={(event) => { setDraggedIndex(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }} onDragOver={(event) => { if (!exportMode) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverIndex(index); } }} onDrop={(event) => { event.preventDefault(); if (draggedIndex !== undefined) moveEnvironment(draggedIndex, index); setDraggedIndex(undefined); setDragOverIndex(undefined); }} onDragEnd={() => { setDraggedIndex(undefined); setDragOverIndex(undefined); }}>
            <span className="environment-drag-handle" aria-hidden="true" title="拖动调整顺序"><i /><i /><i /></span>
            <button type="button" className="environment-config-list-select" onClick={() => { if (exportMode) { toggleTransferSelection(index); return; } setSelected(index); setAddSourceOpen(false); setConfirmRemove(false); }}><EnvironmentSourceBadge source={item.sourceType} compact /><span className="environment-config-list-copy"><strong>{item.name || "未命名环境"}</strong><small>{item.sourceType.toUpperCase()} · {connectionSummary(item)}</small></span></button>
            {exportMode && <button type="button" className={`environment-transfer-check${transferSelection.has(index) ? " is-selected" : ""}`} aria-label={`${transferSelection.has(index) ? "取消选择" : "选择"}${item.name || "未命名环境"}用于导出`} aria-pressed={transferSelection.has(index)} onClick={() => toggleTransferSelection(index)}>{transferSelection.has(index) ? "✓" : ""}</button>}
          </div>)}</div>
          <div className="environment-create-actions"><div className="environment-add-control"><button className="environment-add-button" type="button" disabled={exportMode} aria-expanded={addSourceOpen} onClick={() => setAddSourceOpen((open) => !open)}>＋ 添加环境</button>{addSourceOpen && <div className="environment-add-source"><strong>选择日志源类型</strong><small>创建后不可修改</small><button type="button" onClick={() => addEnvironment("elk")}><EnvironmentSourceBadge source="elk" /><span className="environment-add-source-copy"><b>ELK</b><em>Elasticsearch 索引检索</em></span></button><button type="button" onClick={() => addEnvironment("ssh")}><EnvironmentSourceBadge source="ssh" /><span className="environment-add-source-copy"><b>SSH</b><em>远程主机日志采集</em></span></button></div>}</div><button className="environment-clone-button" type="button" disabled={!current || exportMode} onClick={cloneEnvironment}>克隆当前</button></div>
          <div className={`environment-config-transfer${exportMode ? " is-selecting" : ""}`}>{exportMode ? <><div className="environment-transfer-summary"><strong>选择导出范围</strong><span>已选 {transferSelection.size}/{drafts.length}</span></div><button type="button" onClick={() => setTransferSelection(transferSelection.size === drafts.length ? new Set() : new Set(drafts.map((_, index) => index)))}>{transferSelection.size === drafts.length ? "取消全选" : "全选"}</button><button type="button" className="primary" disabled={!transferSelection.size} onClick={() => void exportConfiguration()}><DownloadIcon />导出{transferSelection.size ? ` (${transferSelection.size})` : ""}</button><button type="button" className="environment-export-cancel" onClick={() => { setExportMode(false); setTransferSelection(new Set()); }}>取消</button></> : <><button type="button" onClick={() => importRef.current?.click()}><ImportIcon />导入配置</button><button type="button" onClick={() => { setExportMode(true); setTransferSelection(new Set()); setAddSourceOpen(false); }}><DownloadIcon />导出配置</button></>}<input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importConfiguration(event.currentTarget.files?.[0])} /></div>
        </aside>
        <section className="environment-config-body">{loading && <div className="environment-config-loading">正在读取当前配置…</div>}
          {!loading && current && <><div className="environment-config-section-title"><strong>{current.name || "未命名环境"}</strong><EnvironmentSourceBadge source={current.sourceType} /></div>
            <div className="environment-config-fields">
              <label><span>环境名称</span><input value={current.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如 faulu-m5-dr" /></label>
              <label><span>日志时区</span><SearchableSelect value={current.timeZone ?? "Africa/Nairobi"} options={TIME_ZONE_OPTIONS} ariaLabel="日志时区" searchPlaceholder="搜索城市或时区" onChange={(timeZone) => update({ timeZone })} /><small>用于查询时间换算与时间戳显示。</small></label>
              {current.sourceType === "elk" ? <>
                <label className="is-wide"><span>Kibana 服务地址</span><input inputMode="url" value={current.kibanaUrl} onChange={(event) => update({ kibanaUrl: event.target.value })} placeholder="https://example.com/kibana" /></label>
                <label><span>用户名</span><input autoComplete="off" value={current.username} onChange={(event) => update({ username: event.target.value })} /></label><label><span>密码</span><input type="password" autoComplete="new-password" value={current.password} onChange={(event) => update({ password: event.target.value })} /></label>
                <div className="environment-config-group-title"><span>索引映射</span><small>支持 Elasticsearch 通配符</small></div>
                <label><span>交易日志索引</span><input value={current.txnlstIndex} onChange={(event) => update({ txnlstIndex: event.target.value })} /></label><label><span>调用链日志索引</span><input value={current.txntrcIndex} onChange={(event) => update({ txntrcIndex: event.target.value })} /></label><label className="is-wide"><span>应用日志索引</span><input value={current.applogIndex} onChange={(event) => update({ applogIndex: event.target.value })} /></label>
              </> : <>
                <label><span>连接超时（秒）</span><input type="number" min="3" max="60" value={current.sshConnectTimeoutSeconds ?? 10} onChange={(event) => update({ sshConnectTimeoutSeconds: Number(event.target.value) })} /></label>
                <label><span>时区 UTC 偏移</span><input value={current.sshLogTimeOffset ?? "+03:00"} onChange={(event) => update({ sshLogTimeOffset: event.target.value })} placeholder="+03:00" /></label>
                <div className="environment-time-zone-mode is-wide"><span><strong>服务器时区自动探测</strong><small>探测失败时使用配置时区与 UTC 偏移。</small></span><button type="button" className={current.sshAutoDetectTimeZone !== false ? "is-on" : undefined} aria-pressed={current.sshAutoDetectTimeZone !== false} onClick={() => update({ sshAutoDetectTimeZone: current.sshAutoDetectTimeZone === false })}><i /></button></div>
                <SshServerList value={current.sshServers ?? []} onChange={(sshServers) => update({ sshServers })} />
                <SshApplicationList value={current.sshMonitoredApplications ?? []} onChange={(sshMonitoredApplications) => update({ sshMonitoredApplications })} />
                <div className="environment-config-ssh-note is-wide"><strong>检索范围</strong><span>按日期检索 log/01～31 与 trc/01～31，并合并服务器组结果。密码认证依赖本机 sshpass；建议使用 SSH Config 或私钥。</span></div>
              </>}
            </div>
            <div className="environment-remove-zone"><div><strong>删除环境</strong><span>保存配置后生效。</span></div>{confirmRemove ? <div className="environment-remove-confirm"><span>确认删除“{current.name || "未命名环境"}”？</span><button type="button" onClick={() => setConfirmRemove(false)}>取消</button><button type="button" className="danger" onClick={removeEnvironment}>确认删除</button></div> : <button type="button" disabled={drafts.length <= 1} onClick={() => setConfirmRemove(true)}><TrashIcon />删除环境</button>}</div>
          </>}
          {(localError || error) && <p className="environment-config-error" role="alert">{localError || error}</p>}{notice && !localError && !error && <p className="environment-config-notice" role="status">{notice}</p>}
        </section>
      </div>
      <footer><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={loading || saving || !drafts.length}>{saving ? "保存中…" : "保存配置"}</button></footer>
    </form>
    {importCandidates && <EnvironmentImportReview candidates={importCandidates} selected={importSelection} onToggle={toggleImportSelection} onSelectAll={() => setImportSelection(new Set(importCandidates.map((_, index) => index)))} onClear={() => setImportSelection(new Set())} onCancel={() => { setImportCandidates(undefined); setImportSelection(new Set()); }} onConfirm={applyImport} />}
  </div>;
};

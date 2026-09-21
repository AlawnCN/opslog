import { useEffect, useRef, useState, type FormEvent } from "react";
import { createEnvironmentConfiguration, parseEnvironmentConfigurationFile, validateEnvironmentConfigurations } from "../environment-configuration";
import type { EnvironmentConfiguration } from "../types";
import { CloseIcon, ImportIcon, TrashIcon } from "./Icons";
import { useMovableDialog } from "./useMovableDialog";

interface EnvironmentConfigurationDialogProps {
  environments: EnvironmentConfiguration[];
  loading: boolean;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (environments: EnvironmentConfiguration[]) => void;
}

const clone = (items: EnvironmentConfiguration[]): EnvironmentConfiguration[] => items.map((item) => ({ ...item }));

export const EnvironmentConfigurationDialog = ({ environments, loading, saving, error, onClose, onSave }: EnvironmentConfigurationDialogProps) => {
  const [drafts, setDrafts] = useState<EnvironmentConfiguration[]>(() => clone(environments));
  const [selected, setSelected] = useState(0);
  const [localError, setLocalError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const movable = useMovableDialog<HTMLFormElement>();

  useEffect(() => {
    setDrafts(clone(environments));
    setSelected(0);
    setConfirmRemove(false);
  }, [environments]);

  const current = drafts[selected];
  const update = (changes: Partial<EnvironmentConfiguration>) => {
    setLocalError(undefined);
    setDrafts((items) => items.map((item, index) => index === selected ? { ...item, ...changes } : item));
  };
  const addEnvironment = () => {
    setDrafts((items) => [...items, createEnvironmentConfiguration(items.length + 1)]);
    setSelected(drafts.length);
    setConfirmRemove(false);
  };
  const removeEnvironment = () => {
    if (drafts.length <= 1) return;
    setDrafts((items) => items.filter((_, index) => index !== selected));
    setSelected((index) => Math.max(0, Math.min(index, drafts.length - 2)));
    setConfirmRemove(false);
  };
  const importConfiguration = async (file?: File) => {
    if (!file) return;
    try {
      const imported = parseEnvironmentConfigurationFile(await file.text());
      const validation = validateEnvironmentConfigurations(imported);
      if (validation) throw new Error(validation);
      setDrafts(imported);
      setSelected(0);
      setConfirmRemove(false);
      setLocalError(undefined);
    } catch (importError) {
      setLocalError(importError instanceof Error ? importError.message : "无法读取配置文件");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const validation = validateEnvironmentConfigurations(drafts);
    if (validation) { setLocalError(validation); return; }
    onSave(drafts.map((item) => ({ ...item, name: item.name.trim(), kibanaUrl: item.kibanaUrl.trim() })));
  };

  return <div className="environment-config-backdrop" role="presentation" onMouseDown={saving ? undefined : onClose}>
    <form ref={movable.dialogRef} style={movable.dialogStyle} className="environment-config-dialog movable-dialog" role="dialog" aria-modal="true" aria-labelledby="environment-config-title" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <header onPointerDown={movable.startMove}>
        <div><span className="eyebrow">OPSLOG · ENVIRONMENT SETTINGS</span><h2 id="environment-config-title">运行环境配置</h2><p>管理查询网关凭据与各类日志索引。配置仅保存在当前设备。</p></div>
        <button type="button" aria-label="关闭运行环境配置" disabled={saving} onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="environment-config-workspace">
        <aside>
          <div className="environment-config-list-heading"><span>运行环境</span><small>{drafts.length}</small></div>
          <div className="environment-config-list">{drafts.map((item, index) => <button type="button" key={`${index}-${item.name}`} className={selected === index ? "is-active" : undefined} onClick={() => { setSelected(index); setConfirmRemove(false); }}><strong>{item.name || "未命名环境"}</strong><span>{item.kibanaUrl || "尚未配置服务地址"}</span></button>)}</div>
          <button className="environment-add-button" type="button" onClick={addEnvironment}>＋ 添加环境</button>
          <div className="environment-import-area"><button type="button" onClick={() => importRef.current?.click()}><ImportIcon />导入 JSON 配置</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importConfiguration(event.currentTarget.files?.[0])} /><small>导入后可先检查内容，再统一保存。</small></div>
        </aside>
        <section className="environment-config-body">
          {loading && <div className="environment-config-loading">正在读取当前配置…</div>}
          {!loading && current && <>
            <div className="environment-config-section-title"><div><strong>{current.name || "未命名环境"}</strong><span>连接与索引</span></div></div>
            <div className="environment-config-fields">
              <label><span>配置名称</span><input value={current.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如 faulu-m5-dr" /></label>
              <label><span>Kibana 地址</span><input inputMode="url" value={current.kibanaUrl} onChange={(event) => update({ kibanaUrl: event.target.value })} placeholder="https://example.com/kibana" /></label>
              <label><span>用户名</span><input autoComplete="off" value={current.username} onChange={(event) => update({ username: event.target.value })} /></label>
              <label><span>密码</span><input type="password" autoComplete="new-password" value={current.password} onChange={(event) => update({ password: event.target.value })} /></label>
              <div className="environment-config-group-title"><span>日志索引</span><small>支持 Elasticsearch 通配符表达式</small></div>
              <label><span>交易日志索引</span><input value={current.txnlstIndex} onChange={(event) => update({ txnlstIndex: event.target.value })} placeholder="logs-ecp.txn.lst.dr*" /></label>
              <label><span>Trace 日志索引</span><input value={current.txntrcIndex} onChange={(event) => update({ txntrcIndex: event.target.value })} placeholder="logs-ecp.txn.trc.dr*" /></label>
              <label className="is-wide"><span>应用日志索引</span><input value={current.applogIndex} onChange={(event) => update({ applogIndex: event.target.value })} placeholder="logs-ecp.app.dr*" /></label>
            </div>
            <div className="environment-remove-zone"><div><strong>移除运行环境</strong><span>移除后仅在点击“保存配置”时生效。</span></div>{confirmRemove
              ? <div className="environment-remove-confirm"><span>确认移除“{current.name || "未命名环境"}”？</span><button type="button" onClick={() => setConfirmRemove(false)}>取消</button><button type="button" className="danger" onClick={removeEnvironment}>确认移除</button></div>
              : <button type="button" disabled={drafts.length <= 1} onClick={() => setConfirmRemove(true)}><TrashIcon />移除此环境</button>}</div>
          </>}
          {(localError || error) && <p className="environment-config-error" role="alert">{localError || error}</p>}
        </section>
      </div>
      <footer><button type="button" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="primary" disabled={loading || saving || !drafts.length}>{saving ? "保存中…" : "保存配置"}</button></footer>
    </form>
  </div>;
};

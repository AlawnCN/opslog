import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { saveEnvironmentConfigurationExport } from "../api";
import {
  createEnvironmentConfiguration, normalizeEnvironmentConfiguration, prepareEnvironmentConfigurationsForSave, nextSshServerName, sshOffsetForTimeZone,
  serializeEnvironmentConfigurations, validateEnvironmentConfigurations
} from "../environment-configuration";
import { cloneEnvironmentConfiguration, mergeImportedEnvironments, remapSelectionAfterMove, remapSelectionAfterRemove } from "../environment-transfer";
import { decryptEnvironmentConfigurations, MIN_EXPORT_PASSPHRASE_LENGTH, parseEnvironmentTransfer, serializeEncryptedEnvironmentConfigurations, type EncryptedEnvironmentTransfer } from "../environment-credential-transfer";
import type { EnvironmentConfiguration, EnvironmentSource, SshApplicationConfiguration, SshServerConfiguration } from "../types";
import { CloseIcon, DownloadIcon, ImportIcon, TrashIcon } from "./Icons";
import { useMovableDialog } from "./useMovableDialog";
import { AppSelect } from "./AppSelect";
import { EnvironmentImportReview } from "./EnvironmentImportReview";
import { EnvironmentCredentialImportDialog } from "./EnvironmentCredentialImportDialog";
import { EnvironmentSourceBadge } from "./EnvironmentSourceBadge";
import { SearchableSelect } from "./SearchableSelect";
import { PasswordInput } from "./PasswordInput";
import { SshAiConfigurationAnalysis } from "./SshAiConfigurationAnalysis";
import { SshServerProbe } from "./SshServerProbe";

interface EnvironmentConfigurationDialogProps {
  environments: EnvironmentConfiguration[];
  loading: boolean;
  saving: boolean;
  error?: string;
  activeEnvironmentName?: string;
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

const SshServerList = ({ value, timeout, onChange }: { value: SshServerConfiguration[]; timeout?: number; onChange: (value: SshServerConfiguration[]) => void }) => {
  const update = (index: number, changes: Partial<SshServerConfiguration>) => onChange(value.map((server, current) => current === index ? { ...server, ...changes } : server));
  return <div className="environment-repeatable is-wide">
    <div className="environment-repeatable-heading"><div><strong>服务器组</strong><small>并行检索组内服务器并合并结果</small></div><button type="button" onClick={() => onChange([...value, { name: nextSshServerName(value), host: "", username: "", authentication: "ssh-config", password: "", privateKeyPath: "" }])}>＋ 添加服务器</button></div>
    <div className="environment-server-list">{value.map((server, index) => <article key={index}>
      <div className="environment-server-card-title"><strong>{server.name || `服务器 ${index + 1}`}</strong><button type="button" aria-label={`移除服务器 ${server.name || index + 1}`} disabled={value.length <= 1} onClick={() => onChange(value.filter((_, current) => current !== index))}><TrashIcon /></button></div>
      <SshServerProbe server={server} timeout={timeout} onTrust={(trusted) => update(index, trusted)} />
      <div className="environment-server-fields">
        <label><span>服务器名称</span><input value={server.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="例如 m5-uat-01" /></label>
        <label><span>主机 / SSH Config 别名</span><input value={server.host} onChange={(event) => update(index, { host: event.target.value, hostKeyFingerprint: undefined })} placeholder="m5.uat 或 10.0.0.8" /><small>修改主机或端口会清除旧指纹，下次连接需重新核对。</small></label>
        <label><span>认证方式</span><AppSelect value={server.authentication} ariaLabel="SSH 认证方式" options={[{ value: "ssh-config", label: "SSH Config" }, { value: "private-key", label: "用户名 + 私钥" }, { value: "password", label: "用户名 + 密码" }]} onChange={(authentication) => update(index, { authentication: authentication as SshServerConfiguration["authentication"] })} />{server.authentication === "ssh-config" && <small>主机、用户、端口和密钥均由 SSH Config 解析；手动认证参数暂存于草稿。</small>}</label>
        {server.authentication !== "ssh-config" && <label><span>端口（可选）</span><input type="number" min="1" max="65535" value={server.port ?? ""} onChange={(event) => update(index, { port: event.target.value ? Number(event.target.value) : undefined, hostKeyFingerprint: undefined })} placeholder="默认 22" /></label>}
        {server.authentication !== "ssh-config" && <label><span>用户名</span><input autoComplete="off" value={server.username ?? ""} onChange={(event) => update(index, { username: event.target.value })} /></label>}
        {server.authentication === "password" && <div className="environment-secret-field"><label htmlFor={`ssh-server-password-${index}`}>密码</label><PasswordInput id={`ssh-server-password-${index}`} key={index} autoComplete="new-password" value={server.password ?? ""} onChange={(event) => update(index, { password: event.target.value })} /></div>}
        {server.authentication === "password" && <label><span>已确认的主机指纹</span><input value={server.hostKeyFingerprint ?? ""} onChange={(event) => update(index, { hostKeyFingerprint: event.target.value.trim() })} placeholder="首次连接时在应用内确认" /><small>服务器密钥变更时会拒绝连接。核对后可清空并重新确认。</small></label>}
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

export const EnvironmentConfigurationDialog = ({ environments, loading, saving, error, activeEnvironmentName, onClose, onSave }: EnvironmentConfigurationDialogProps) => {
  const [drafts, setDrafts] = useState<EnvironmentConfiguration[]>(() => clone(environments));
  const [selected, setSelected] = useState(0);
  const [localError, setLocalError] = useState<string>();
  const [confirmClose, setConfirmClose] = useState(false);
  const [aiPending, setAiPending] = useState(false);
  const handleAiPendingChange = useCallback((pending: boolean) => {
    setAiPending(pending);
    if (!pending) setLocalError(undefined);
  }, []);
  const [notice, setNotice] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number>();
  const [dropSlot, setDropSlot] = useState<number>();
  const dragSession = useRef<{ index: number; pointerId: number; startY: number; pointerX: number; pointerY: number; moved: boolean } | undefined>(undefined);
  const dropSlotRef = useRef<number | undefined>(undefined);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [exportMode, setExportMode] = useState(false);
  const [transferSelection, setTransferSelection] = useState<Set<number>>(new Set());
  const [includePasswords, setIncludePasswords] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportPassphraseConfirmation, setExportPassphraseConfirmation] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string>();
  const [importCandidates, setImportCandidates] = useState<EnvironmentConfiguration[]>();
  const [importSelection, setImportSelection] = useState<Set<number>>(new Set());
  const [importIncludesPasswords, setImportIncludesPasswords] = useState(false);
  const [encryptedImport, setEncryptedImport] = useState<EncryptedEnvironmentTransfer>();
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importError, setImportError] = useState<string>();
  const [importBusy, setImportBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const saveErrorRef = useRef<HTMLParagraphElement>(null);
  const movable = useMovableDialog<HTMLFormElement>();

  useEffect(() => { setDrafts(clone(environments)); setSelected(Math.max(0, environments.findIndex((item) => item.name === activeEnvironmentName))); setConfirmRemove(false); setExportMode(false); setTransferSelection(new Set()); setIncludePasswords(false); setExportPassphrase(""); setExportPassphraseConfirmation(""); }, [environments, activeEnvironmentName]);
  const dirty = JSON.stringify(drafts) !== JSON.stringify(clone(environments));
  const requestClose = () => {
    if (saving || exportBusy || importBusy) return;
    if (dirty || aiPending) { setConfirmClose(true); return; }
    onClose();
  };
  const guardAi = () => {
    if (!aiPending) return false;
    setLocalError("当前有 AI 分析或未应用结果，请先取消分析、应用参数或放弃结果，再切换、排序、导入或保存。");
    return true;
  };
  const current = drafts[selected];
  const update = (changes: Partial<EnvironmentConfiguration>) => {
    setLocalError(undefined); setNotice(undefined);
    setDrafts((items) => items.map((item, index) => index === selected ? { ...item, ...changes } : item));
  };
  const addEnvironment = (sourceType: EnvironmentSource) => {
    if (guardAi()) return;
    const nextIndex = drafts.length;
    setDrafts((items) => [...items, { ...createEnvironmentConfiguration(items.length + 1), sourceType }]);
    setSelected(nextIndex); setAddSourceOpen(false); setConfirmRemove(false); setNotice(`${sourceType.toUpperCase()} 环境已创建，保存后生效。`);
    requestAnimationFrame(() => { const item = listRef.current?.querySelector<HTMLElement>(`[data-environment-index="${nextIndex}"]`); item?.scrollIntoView({ behavior: "smooth", block: "nearest" }); item?.focus(); });
  };
  const cloneEnvironment = () => {
    if (guardAi()) return;
    if (!current) return;
    const copy = cloneEnvironmentConfiguration(current, drafts);
    const nextIndex = drafts.length;
    setDrafts((items) => [...items, copy]);
    setSelected(nextIndex); setAddSourceOpen(false); setConfirmRemove(false); setNotice(`已创建副本：${copy.name}`);
    requestAnimationFrame(() => { const item = listRef.current?.querySelector<HTMLElement>(`[data-environment-index="${nextIndex}"]`); item?.scrollIntoView({ behavior: "smooth", block: "nearest" }); item?.focus(); });
  };
  const removeEnvironment = () => {
    if (guardAi()) return;
    if (drafts.length <= 1) return;
    setDrafts((items) => items.filter((_, index) => index !== selected));
    setTransferSelection((selection) => remapSelectionAfterRemove(selection, selected));
    setSelected((index) => Math.max(0, Math.min(index, drafts.length - 2))); setConfirmRemove(false);
  };
  const moveEnvironment = (from: number, to: number) => {
    if (guardAi()) return;
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
  useEffect(() => {
    if (draggingIndex === undefined) return;
    document.body.classList.add("is-reordering-environments");
    const updateDropSlot = () => {
      const session = dragSession.current;
      const list = listRef.current;
      if (!session || !list || !session.moved) return;
      const bounds = list.getBoundingClientRect();
      if (session.pointerX < bounds.left - 20 || session.pointerX > bounds.right + 20 || session.pointerY < bounds.top - 25 || session.pointerY > bounds.bottom + 25) {
        dropSlotRef.current = undefined;
        setDropSlot(undefined);
        return;
      }
      const items = list.querySelectorAll<HTMLElement>("[data-environment-index]");
      let slot = items.length;
      for (let index = 0; index < items.length; index++) {
        const item = items[index].getBoundingClientRect();
        if (session.pointerY < item.top + item.height / 2) { slot = index; break; }
      }
      const target = slot === session.index || slot === session.index + 1 ? undefined : slot;
      dropSlotRef.current = target;
      setDropSlot(target);
    };
    const move = (event: PointerEvent) => {
      const session = dragSession.current;
      if (!session || event.pointerId !== session.pointerId) return;
      session.pointerX = event.clientX;
      session.pointerY = event.clientY;
      if (Math.abs(event.clientY - session.startY) > 3) session.moved = true;
      updateDropSlot();
    };
    const scroll = window.setInterval(() => {
      const session = dragSession.current;
      const list = listRef.current;
      if (!session?.moved || !list) return;
      const bounds = list.getBoundingClientRect();
      if (session.pointerX < bounds.left || session.pointerX > bounds.right || session.pointerY < bounds.top || session.pointerY > bounds.bottom) return;
      const direction = session.pointerY < bounds.top + 34 ? -1 : session.pointerY > bounds.bottom - 34 ? 1 : 0;
      if (!direction) return;
      list.scrollTop += direction * 13;
      updateDropSlot();
    }, 30);
    const finish = (event: PointerEvent) => {
      const session = dragSession.current;
      if (!session || event.pointerId !== session.pointerId) return;
      const slot = dropSlotRef.current;
      if (event.type === "pointerup" && session.moved && slot !== undefined) moveEnvironment(session.index, slot > session.index ? slot - 1 : slot);
      dragSession.current = undefined;
      dropSlotRef.current = undefined;
      setDraggingIndex(undefined);
      setDropSlot(undefined);
    };
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dragSession.current = undefined;
      dropSlotRef.current = undefined;
      setDraggingIndex(undefined);
      setDropSlot(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("keydown", cancelOnEscape);
    return () => {
      document.body.classList.remove("is-reordering-environments");
      window.clearInterval(scroll);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("keydown", cancelOnEscape);
    };
  }, [draggingIndex]);
  const startEnvironmentDrag = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    if (exportMode || saving || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragSession.current = { index, pointerId: event.pointerId, startY: event.clientY, pointerX: event.clientX, pointerY: event.clientY, moved: false };
    setDraggingIndex(index);
  };
  const reorderWithKeyboard = (event: ReactKeyboardEvent<HTMLElement>, index: number) => {
    if (exportMode || saving || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const next = index + (event.key === "ArrowUp" ? -1 : 1);
    if (next < 0 || next >= drafts.length) return;
    moveEnvironment(index, next);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-environment-index="${next}"] .environment-drag-handle`)?.focus());
  };
  const importConfiguration = async (file?: File) => {
    if (guardAi()) return;
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("配置文件超过 5 MB 限制");
      const transfer = parseEnvironmentTransfer(await file.text());
      setLocalError(undefined);
      if (transfer.encrypted) { setEncryptedImport(transfer.file); setImportPassphrase(""); setImportError(undefined); return; }
      setImportIncludesPasswords(false);
      setImportCandidates(transfer.environments); setImportSelection(new Set(transfer.environments.map((_, index) => index)));
    } catch (importError) { setLocalError(importError instanceof Error ? importError.message : "无法读取配置文件"); }
    finally { if (importRef.current) importRef.current.value = ""; }
  };
  const decryptImport = async () => {
    if (!encryptedImport || !importPassphrase) return;
    setImportBusy(true); setImportError(undefined);
    try {
      const imported = await decryptEnvironmentConfigurations(encryptedImport, importPassphrase);
      setImportIncludesPasswords(true);
      setImportCandidates(imported); setImportSelection(new Set(imported.map((_, index) => index)));
      setEncryptedImport(undefined); setImportPassphrase("");
    } catch (error) { setImportError(error instanceof Error ? error.message : "无法解密配置文件"); }
    finally { setImportBusy(false); }
  };
  const applyImport = () => {
    if (!importCandidates) return;
    const selectedCandidates = importCandidates.filter((_, index) => importSelection.has(index));
    const merged = mergeImportedEnvironments(drafts, selectedCandidates);
    setDrafts(merged.environments); setExportMode(false); setTransferSelection(new Set());
    if (merged.importedIndexes[0] !== undefined) setSelected(merged.importedIndexes[0]);
    setImportCandidates(undefined); setImportSelection(new Set()); setImportIncludesPasswords(false); setConfirmRemove(false);
    setNotice(`已加入草稿：新增 ${merged.added}，更新 ${merged.updated}；保存配置后生效。无密码的新连接需先补充密码。`);
  };
  const exportConfiguration = async () => {
    const selectedDrafts = drafts.filter((_, index) => transferSelection.has(index));
    if (!selectedDrafts.length) { setExportError("请先选择至少一个环境"); return; }
    if (includePasswords && exportPassphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) { setExportError(`加密口令至少需要 ${MIN_EXPORT_PASSPHRASE_LENGTH} 个字符`); return; }
    if (includePasswords && exportPassphrase !== exportPassphraseConfirmation) { setExportError("两次输入的加密口令不一致"); return; }
    setExportBusy(true);
    try {
      setExportError(undefined);
      const contents = includePasswords
        ? await serializeEncryptedEnvironmentConfigurations(selectedDrafts, exportPassphrase)
        : serializeEnvironmentConfigurations(selectedDrafts);
      await saveEnvironmentConfigurationExport(contents, includePasswords);
      setExportMode(false); setTransferSelection(new Set()); setIncludePasswords(false); setExportPassphrase(""); setExportPassphraseConfirmation("");
      setNotice(includePasswords
        ? `已导出 ${selectedDrafts.length} 个环境；各连接密码分别加密，解密口令未写入文件。`
        : `已导出 ${selectedDrafts.length} 个环境（不含密码）。`);
    } catch (error) { setExportError(error instanceof Error ? error.message : "无法导出配置"); }
    finally { setExportBusy(false); }
  };
  const toggleTransferSelection = (index: number) => {
    setExportError(undefined);
    setTransferSelection((selection) => {
      const next = new Set(selection);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };
  const toggleImportSelection = (index: number) => setImportSelection((selection) => {
    const next = new Set(selection);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (guardAi() || saving || loading || exportMode || exportBusy || importBusy) return;
    const validation = validateEnvironmentConfigurations(drafts);
    if (validation) {
      setLocalError(validation);
      const invalidIndex = drafts.findIndex((item) => validateEnvironmentConfigurations([item]) === validation || validation.startsWith(`${item.name}：`) || validation.startsWith(`${item.name} / `) || validation === `环境名称重复：${item.name}`);
      if (invalidIndex >= 0) {
        setSelected(invalidIndex);
      }
      requestAnimationFrame(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-environment-index="${invalidIndex}"]`)?.scrollIntoView({ block: "nearest" });
        const invalidApplication = drafts[invalidIndex]?.sshMonitoredApplications?.find((application) =>
          application.logSources?.some((source) => validation.startsWith(`${drafts[invalidIndex]?.name} / ${application.name} / ${source.name || "未命名日志源"}：`)));
        const source = invalidApplication ? movable.dialogRef.current?.querySelector<HTMLDetailsElement>("details[data-invalid='true']") : undefined;
        if (source) {
          source.open = true;
          const input = source.querySelector<HTMLElement>("[aria-invalid='true']") ?? source.querySelector<HTMLElement>("input, textarea");
          input?.focus({ preventScroll: true });
          input?.scrollIntoView({ block: "center" });
        } else {
          const invalidServer = drafts[invalidIndex]?.sshServers?.find((server) => validation.startsWith(`${drafts[invalidIndex]?.name} / ${server.name}：`));
          const serverCard = invalidServer && Array.from(movable.dialogRef.current?.querySelectorAll<HTMLElement>(".environment-server-list article") ?? []).find((card) => card.querySelector("strong")?.textContent === invalidServer.name);
          const inputs = Array.from((serverCard || movable.dialogRef.current?.querySelector(".environment-config-fields"))?.querySelectorAll<HTMLInputElement>("input") ?? []);
          const labelOf = (field: HTMLInputElement) => field.closest("label")?.querySelector("span")?.textContent ?? field.labels?.[0]?.textContent ?? "";
          const relevant = inputs.filter((field) => {
            const label = labelOf(field);
            if (validation.includes("服务器名称和地址")) return label === "服务器名称" || label === "主机 / SSH Config 别名";
            if (validation.includes("密码认证")) return label === "用户名" || label === "密码";
            if (validation.includes("密钥认证")) return label === "用户名" || label === "私钥路径";
            if (validation.includes("主机指纹")) return label === "已确认的主机指纹";
            if (validation.includes("SSH 端口")) return label === "端口（可选）";
            if (validation.includes("日志目录")) return label === "应用根目录";
            if (validation.includes("应用标识")) return label === "应用简称";
            if (validation.includes("UTC 偏移")) return label.startsWith("原始日志 UTC 偏移");
            return !!label && validation.includes(label);
          });
          const input = relevant.find((field) => !field.validity.valid || !field.value.trim()) ?? relevant[0] ?? inputs.find((field) => !field.validity.valid);
          if (input) { input.focus({ preventScroll: true }); input.scrollIntoView({ block: "center" }); }
          else saveErrorRef.current?.focus();
        }
      });
      return;
    }
    setLocalError(undefined);
    onSave(prepareEnvironmentConfigurationsForSave(drafts));
  };

  return <div className="environment-config-backdrop" role="presentation" onMouseDown={requestClose}>
    <form noValidate inert={confirmClose} ref={movable.dialogRef} style={movable.dialogStyle} className="environment-config-dialog movable-dialog" role="dialog" aria-modal="true" aria-labelledby="environment-config-title" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      // React portal events bubble through the component tree, not the DOM tree.
      // A child dialog owns its keyboard layer and must not close this form.
      if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return;
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) event.target.blur(); else requestClose(); }
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); if (!exportMode) movable.dialogRef.current?.requestSubmit(); }
    }}>
      <header onPointerDown={movable.startMove}><div><span className="eyebrow">OPSLOG · ENVIRONMENT SETTINGS</span><h2 id="environment-config-title">运行环境配置</h2><p>管理日志源、连接参数、检索范围与时区策略。</p></div><button type="button" aria-label="关闭运行环境配置" disabled={saving || exportBusy || importBusy} onClick={requestClose}><CloseIcon /></button></header>
      <div className="environment-config-workspace">
        <aside><div className="environment-config-list-heading"><span>运行环境</span><small>{drafts.length}</small></div>
          <div ref={listRef} className="environment-config-list">{drafts.map((item, index) => <div data-environment-index={index} tabIndex={-1} key={`${index}-${item.name}`} className={`environment-config-list-item${selected === index ? " is-active" : ""}${draggingIndex === index ? " is-dragging" : ""}${dropSlot === index ? " drop-before" : ""}${dropSlot === drafts.length && index === drafts.length - 1 ? " drop-after" : ""}${exportMode ? " is-exporting" : ""}`}>
            <button type="button" className="environment-drag-handle" disabled={exportMode || saving} aria-label={`拖动或按方向键调整 ${item.name || "未命名环境"} 的顺序`} title="拖动或按上下方向键调整顺序" onPointerDown={(event) => startEnvironmentDrag(event, index)} onKeyDown={(event) => reorderWithKeyboard(event, index)}><i /><i /><i /></button>
            <button type="button" className="environment-config-list-select" onClick={() => { if (exportMode) { toggleTransferSelection(index); return; } if (index !== selected && guardAi()) return; setSelected(index); setLocalError(undefined); setAddSourceOpen(false); setConfirmRemove(false); }}><EnvironmentSourceBadge source={item.sourceType} compact /><span className="environment-config-list-copy"><strong>{item.name || "未命名环境"}{item.name === activeEnvironmentName ? " · 当前运行" : ""}</strong><small>{item.sourceType.toUpperCase()} · {connectionSummary(item)}</small></span></button>
            {exportMode && <button type="button" className={`environment-transfer-check${transferSelection.has(index) ? " is-selected" : ""}`} aria-label={`${transferSelection.has(index) ? "取消选择" : "选择"}${item.name || "未命名环境"}用于导出`} aria-pressed={transferSelection.has(index)} onClick={() => toggleTransferSelection(index)}>{transferSelection.has(index) ? "✓" : ""}</button>}
          </div>)}</div>
          <div className="environment-create-actions"><div className="environment-add-control"><button className="environment-add-button" type="button" disabled={exportMode} aria-expanded={addSourceOpen} onClick={() => setAddSourceOpen((open) => !open)}>＋ 添加环境</button>{addSourceOpen && <div className="environment-add-source"><strong>选择日志源类型</strong><small>创建后不可修改</small><button type="button" onClick={() => addEnvironment("elk")}><EnvironmentSourceBadge source="elk" /><span className="environment-add-source-copy"><b>ELK</b><em>Elasticsearch 索引检索</em></span></button><button type="button" onClick={() => addEnvironment("ssh")}><EnvironmentSourceBadge source="ssh" /><span className="environment-add-source-copy"><b>SSH</b><em>远程主机日志采集</em></span></button></div>}</div><button className="environment-clone-button" type="button" disabled={!current || exportMode} onClick={cloneEnvironment}>克隆当前</button></div>
          <div className={`environment-config-transfer${exportMode ? " is-selecting" : ""}`}>{exportMode ? <>
            <div className="environment-transfer-summary"><strong>选择导出范围</strong><span>已选 {transferSelection.size}/{drafts.length}</span></div>
            <p className="environment-transfer-guidance">{transferSelection.size ? `将导出已勾选的 ${transferSelection.size} 个环境。` : "请勾选左侧环境列表中的项目，或点击下方「全选」。"}</p>
            <button type="button" role="checkbox" aria-checked={includePasswords} className={`environment-transfer-secret-option${includePasswords ? " is-checked" : ""}`} disabled={exportBusy} onClick={() => { setIncludePasswords((value) => !value); setExportPassphrase(""); setExportPassphraseConfirmation(""); setExportError(undefined); }}><span className="environment-selection-check" aria-hidden="true">{includePasswords ? "✓" : ""}</span><span>包含密码（加密导出）</span></button>
            {includePasswords && <div className="environment-transfer-secret-fields" onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); if (!exportBusy) void exportConfiguration(); } }}><div className="environment-secret-field"><label htmlFor="environment-export-key">加密口令</label><PasswordInput id="environment-export-key" secretLabel="加密口令" autoComplete="new-password" value={exportPassphrase} disabled={exportBusy} onChange={(event) => { setExportPassphrase(event.target.value); setExportError(undefined); }} placeholder={`至少 ${MIN_EXPORT_PASSPHRASE_LENGTH} 个字符`} /></div><div className="environment-secret-field"><label htmlFor="environment-export-key-confirmation">确认口令</label><PasswordInput id="environment-export-key-confirmation" secretLabel="确认口令" autoComplete="new-password" value={exportPassphraseConfirmation} disabled={exportBusy} onChange={(event) => { setExportPassphraseConfirmation(event.target.value); setExportError(undefined); }} /></div><small>使用同一口令导入；每个已配置的连接密码分别加密，采用独立随机参数。无密码的连接不写 password 字段。口令不保存在文件中，丢失后无法恢复；SSH 私钥文件不导出。</small></div>}
            <button type="button" disabled={exportBusy} onClick={() => setTransferSelection(transferSelection.size === drafts.length ? new Set() : new Set(drafts.map((_, index) => index)))}>{transferSelection.size === drafts.length ? "取消全选" : "全选"}</button>
            <button type="button" className="primary" disabled={exportBusy || !transferSelection.size} title={!transferSelection.size ? "请先选择至少一个环境" : "导出已选择的环境"} onClick={() => void exportConfiguration()}><DownloadIcon />{exportBusy ? "导出中…" : `导出 (${transferSelection.size})`}</button>
            {exportError && <p className="environment-transfer-error" role="alert">{exportError}</p>}
            <button type="button" className="environment-export-cancel" disabled={exportBusy} onClick={() => { setExportMode(false); setTransferSelection(new Set()); setIncludePasswords(false); setExportPassphrase(""); setExportPassphraseConfirmation(""); setExportError(undefined); }}>取消</button>
          </> : <><button type="button" onClick={() => importRef.current?.click()}><ImportIcon />导入配置</button><button type="button" onClick={() => { setExportMode(true); setTransferSelection(new Set()); setExportError(undefined); setAddSourceOpen(false); }}><DownloadIcon />导出配置</button></>}<input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importConfiguration(event.currentTarget.files?.[0])} /></div>
        </aside>
        <section className="environment-config-body">{loading && <div className="environment-config-loading">正在读取当前配置…</div>}
          {!loading && current && <Fragment key={`${selected}-${current.sourceType}`}><div className="environment-config-section-title"><strong>{current.name || "未命名环境"}</strong><EnvironmentSourceBadge source={current.sourceType} /></div>
            <div className="environment-config-fields">
              <label><span>环境名称</span><input value={current.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如 faulu-m5-dr" /></label>
              <label><span>日志时区</span><SearchableSelect value={current.timeZone ?? "Africa/Nairobi"} options={TIME_ZONE_OPTIONS} ariaLabel="日志时区" searchPlaceholder="搜索城市或时区" onChange={(timeZone) => update({ timeZone, ...(current.sourceType === "ssh" ? { sshLogTimeOffset: sshOffsetForTimeZone(timeZone) } : {}) })} /><small>用于查询时间换算与显示；SSH 模式切换时同步日志偏移。</small></label>
              {current.sourceType === "elk" ? <Fragment key="elk-fields">
                <label className="is-wide"><span>Kibana 服务地址</span><input inputMode="url" value={current.kibanaUrl} onChange={(event) => update({ kibanaUrl: event.target.value })} placeholder="https://example.com/kibana" /></label>
                <label><span>用户名</span><input autoComplete="off" value={current.username} onChange={(event) => update({ username: event.target.value })} /></label><div className="environment-secret-field"><label htmlFor="elk-environment-password">密码</label><PasswordInput id="elk-environment-password" key={selected} autoComplete="new-password" value={current.password} onChange={(event) => update({ password: event.target.value })} /></div>
                <div className="environment-config-group-title"><span>索引映射</span><small>支持 Elasticsearch 通配符</small></div>
                <label><span>交易日志索引</span><input value={current.txnlstIndex} onChange={(event) => update({ txnlstIndex: event.target.value })} /></label><label><span>调用链日志索引</span><input value={current.txntrcIndex} onChange={(event) => update({ txntrcIndex: event.target.value })} /></label><label className="is-wide"><span>应用日志索引</span><input value={current.applogIndex} onChange={(event) => update({ applogIndex: event.target.value })} /></label>
              </Fragment> : <Fragment key="ssh-fields">
                <label><span>连接超时（秒）</span><input type="number" min="3" max="60" value={current.sshConnectTimeoutSeconds ?? 10} onChange={(event) => update({ sshConnectTimeoutSeconds: Number(event.target.value) })} /></label>
                <label><span>原始日志 UTC 偏移（回退值）</span><input value={current.sshLogTimeOffset ?? "+03:00"} onChange={(event) => update({ sshLogTimeOffset: event.target.value })} placeholder="+03:00" /><small>服务器探测关闭或失败时，用此偏移解释日志时间。与显示时区不同请确认是否有意设置；含夏令时的历史日志不能只依赖当前偏移。</small>{current.sshLogTimeOffset !== sshOffsetForTimeZone(current.timeZone || "Africa/Nairobi") && <span className="environment-time-zone-warning">与所选时区当前偏移不一致。<button type="button" onClick={() => update({ sshLogTimeOffset: sshOffsetForTimeZone(current.timeZone || "Africa/Nairobi") })}>按时区同步偏移</button></span>}</label>
                <div className="environment-time-zone-mode is-wide"><span><strong>服务器时区自动探测</strong><small>探测失败时使用配置时区与 UTC 偏移。</small></span><button type="button" className={current.sshAutoDetectTimeZone !== false ? "is-on" : undefined} aria-pressed={current.sshAutoDetectTimeZone !== false} onClick={() => update({ sshAutoDetectTimeZone: current.sshAutoDetectTimeZone === false })}><i /></button></div>
                <SshServerList value={current.sshServers ?? []} timeout={current.sshConnectTimeoutSeconds} onChange={(sshServers) => update({ sshServers })} />
                <SshApplicationList value={current.sshMonitoredApplications ?? []} onChange={(sshMonitoredApplications) => update({ sshMonitoredApplications })} />
                <SshAiConfigurationAnalysis environment={current} onPendingChange={handleAiPendingChange} onApply={(sshMonitoredApplications) => update({ sshMonitoredApplications })} onTrustServer={(sshServers) => update({ sshServers })} />
                <div className="environment-config-ssh-note is-wide"><strong>检索范围</strong><span>按日志源配置匹配应用根目录内的文件，每台服务器独立执行文件选择策略，再合并服务器组结果；未自定义时使用内置兼容模板。密码模式由应用内置 SSH 客户端连接，首次连接需核对服务器指纹。</span></div>
              </Fragment>}
            </div>
            <div className="environment-remove-zone"><div><strong>删除环境</strong><span>保存配置后生效。</span></div>{confirmRemove ? <div className="environment-remove-confirm"><span>确认删除“{current.name || "未命名环境"}”？</span><button type="button" onClick={() => setConfirmRemove(false)}>取消</button><button type="button" className="danger" onClick={removeEnvironment}>确认删除</button></div> : <button type="button" disabled={drafts.length <= 1} onClick={() => setConfirmRemove(true)}><TrashIcon />删除环境</button>}</div>
          </Fragment>}
          {notice && !localError && !error && <p className="environment-config-notice" role="status">{notice}</p>}
        </section>
      </div>
      {(localError || error) && <p ref={saveErrorRef} tabIndex={-1} className="environment-config-error environment-config-save-error" role="alert">未保存：{localError || error}</p>}
      <footer><span className="environment-draft-status" role="status">{aiPending ? "AI 分析或候选结果尚未处理，暂不能保存" : exportMode ? "正在导出配置 · 请先完成或取消导出" : dirty ? "有未保存修改 · 保存全部环境" : "尚无修改"}</span><button type="button" disabled={saving || exportBusy || importBusy} onClick={requestClose}>取消</button><button type="submit" className="primary" title={aiPending ? "请先取消分析，或应用 / 放弃 AI 结果" : exportMode ? "请先完成或取消导出" : "保存全部环境（⌘/Ctrl+S）"} disabled={loading || saving || aiPending || exportMode || exportBusy || importBusy || !drafts.length}>{saving ? "保存中…" : "保存配置"}</button></footer>
    </form>
    {encryptedImport && <EnvironmentCredentialImportDialog passphrase={importPassphrase} busy={importBusy} error={importError} onPassphraseChange={setImportPassphrase} onImport={() => void decryptImport()} onCancel={() => { setEncryptedImport(undefined); setImportPassphrase(""); setImportError(undefined); }} />}
    {importCandidates && <EnvironmentImportReview candidates={importCandidates} includesPasswords={importIncludesPasswords} selected={importSelection} onToggle={toggleImportSelection} onSelectAll={() => setImportSelection(new Set(importCandidates.map((_, index) => index)))} onClear={() => setImportSelection(new Set())} onCancel={() => { setImportCandidates(undefined); setImportSelection(new Set()); setImportIncludesPasswords(false); }} onConfirm={applyImport} />}
    {confirmClose && createPortal(<div className="environment-discard-backdrop" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); setConfirmClose(false); }
      if (event.key === "Tab") {
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
        if (event.shiftKey && event.target === buttons[0]) { event.preventDefault(); buttons[1]?.focus(); }
        else if (!event.shiftKey && event.target === buttons[1]) { event.preventDefault(); buttons[0]?.focus(); }
      }
    }}><section role="alertdialog" aria-modal="true" aria-labelledby="environment-discard-title"><h2 id="environment-discard-title">舍弃未保存的工作？</h2><p>{aiPending ? "关闭将取消 AI 任务或丢弃候选结果，并舍弃环境草稿。" : "本次修改尚未保存，关闭后将丢失。"}</p><div><button type="button" autoFocus onClick={() => setConfirmClose(false)}>继续编辑</button><button type="button" onClick={onClose}>舍弃并关闭</button></div></section></div>, document.body)}
  </div>;
};

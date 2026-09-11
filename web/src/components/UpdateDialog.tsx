import type { AppUpdateState } from "../use-app-updater";
import { CloseIcon, DownloadIcon } from "./Icons";

interface UpdateDialogProps {
  state: AppUpdateState;
  onInstall: () => void;
  onDismiss: () => void;
}

const progress = (state: AppUpdateState): number | undefined => {
  if (!state.totalBytes) return undefined;
  return Math.min(100, (state.downloadedBytes / state.totalBytes) * 100);
};

const statusCopy = (state: AppUpdateState): string => {
  if (state.phase === "checking") return "正在安全检查新版本…";
  if (state.phase === "downloading") return "正在下载并校验更新包…";
  if (state.phase === "installing") return "更新包已验证，正在安装…";
  if (state.phase === "error") return "本次更新未能完成";
  return `发现新版本 ${state.version ?? ""}`;
};

export const UpdateDialog = ({ state, onInstall, onDismiss }: UpdateDialogProps) => {
  if (!state.visible) return null;
  const percentage = progress(state);
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  const showChangelog = Boolean(state.version) && state.phase !== "checking";
  const changelog = state.notes?.trim() || "本次版本未提供更新说明。";

  return <div className="update-dialog-backdrop" role="presentation">
    <section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-busy={busy}>
      <header>
        <div className="update-emblem" aria-hidden="true"><DownloadIcon /></div>
        <div><span className="eyebrow">SECURE UPDATE</span><h2 id="update-title">OpsLog 自动更新</h2></div>
        {!busy && <button className="update-close" title="稍后更新" aria-label="稍后更新" onClick={onDismiss}><CloseIcon /></button>}
      </header>
      <div className="update-dialog-body">
        <strong>{statusCopy(state)}</strong>
        {state.currentVersion && state.version && <p className="update-version">当前 {state.currentVersion}<i />最新 {state.version}</p>}
        {state.phase === "available" && <p className="update-security">更新包将通过数字签名验证，校验通过后才会安装。</p>}
        {showChangelog && <section className="update-changelog" aria-label="更新内容">
          <header><span>CHANGELOG</span><strong>更新内容</strong></header>
          <div className={`update-notes${state.notes?.trim() ? "" : " is-empty"}`}>{changelog}</div>
        </section>}
        {busy && <div className="update-progress"><span style={{ width: percentage == null ? "34%" : `${percentage}%` }} className={percentage == null ? "is-indeterminate" : undefined} /></div>}
        {state.phase === "checking" && <small>正在连接安全更新服务</small>}
        {state.phase === "downloading" && <small>{percentage == null ? "正在连接更新服务" : `已下载 ${Math.round(percentage)}%`}</small>}
        {state.phase === "installing" && <small>安装完成后应用将自动重新启动</small>}
        {state.phase === "error" && <p className="update-error">{state.error}</p>}
      </div>
      {!busy && <footer><button onClick={onDismiss}>稍后</button><button className="primary" onClick={onInstall}>{state.phase === "error" ? "重新尝试" : "下载并安装"}</button></footer>}
    </section>
  </div>;
};

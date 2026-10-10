import { createPortal } from "react-dom";
import type { SshHostKeyChallenge } from "../ssh-host-key";

interface Props {
  challenge: SshHostKeyChallenge;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  detail?: string;
}

export const SshHostKeyDialog = ({ challenge, busy, onConfirm, onCancel, detail }: Props) => createPortal(
  <div className="ssh-host-key-backdrop"><section className="ssh-host-key-dialog" role="dialog" aria-modal="true" aria-labelledby="ssh-host-key-title">
    <h2 id="ssh-host-key-title">确认 SSH 服务器身份</h2>
    <p>首次连接 {challenge.host}:{challenge.port}。请向服务器管理员核对以下主机指纹，确认相符后再继续。</p>
    <code>{challenge.fingerprint}</code>
    {detail && <p>{detail}</p>}
    <div><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="button" disabled={busy} onClick={onConfirm}>{busy ? "处理中…" : "指纹相符，信任并继续"}</button></div>
  </section></div>, document.body
);

import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, probeSshServer, type SshProbeResult } from "../api";
import { parseSshHostKeyChallenge, trustSshHostKey, type SshHostKeyChallenge } from "../ssh-host-key";
import type { SshServerConfiguration } from "../types";
import { ServerProbeIcon } from "./Icons";
import { SshHostKeyDialog } from "./SshHostKeyDialog";

interface Props { server: SshServerConfiguration; name: string; actions: ReactNode; timeout?: number; onTrust: (server: SshServerConfiguration) => void }

export const SshServerProbe = ({ server, name, actions, timeout = 10, onTrust }: Props) => {
  const identity = JSON.stringify([server, timeout]);
  const controller = useRef<AbortController | undefined>(undefined);
  const retryIdentity = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ identity: string; result?: SshProbeResult; error?: string }>();
  const [challenge, setChallenge] = useState<SshHostKeyChallenge>();
  const run = async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true); setFeedback(undefined); setChallenge(undefined);
    try {
      if (!server.host.trim()) throw new Error("请填写主机 / SSH Config 别名");
      if (!/^[A-Za-z0-9_.@-]+$/.test(server.host.trim())) throw new Error("主机或 SSH Config 别名格式不正确");
      if (!Number.isInteger(timeout) || timeout < 3 || timeout > 60) throw new Error("连接超时必须为 3～60 秒");
      if (server.authentication !== "ssh-config") {
        if (server.port !== undefined && (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535)) throw new Error("SSH 端口必须在 1～65535 之间");
        if (!server.username?.trim()) throw new Error("请填写 SSH 用户名");
        if (server.authentication === "password" && !server.password) throw new Error("请填写 SSH 密码");
        if (server.authentication === "private-key" && !server.privateKeyPath?.trim()) throw new Error("请填写私钥路径");
      }
      const result = await probeSshServer(server, timeout, next.signal);
      if (!next.signal.aborted) setFeedback({ identity, result });
    } catch (error) {
      if (next.signal.aborted) return;
      const text = errorMessage(error);
      const hostKey = parseSshHostKeyChallenge(text);
      if (hostKey) setChallenge(hostKey);
      else setFeedback({ identity, error: text });
    } finally { if (!next.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    setBusy(false); setFeedback(undefined); setChallenge(undefined);
    if (retryIdentity.current === identity) { retryIdentity.current = undefined; void run(); }
    return () => { controller.current?.abort(); };
  }, [identity]);
  const confirm = () => {
    if (!challenge) return;
    try {
      const trusted = trustSshHostKey([server], challenge)[0]!;
      retryIdentity.current = JSON.stringify([trusted, timeout]);
      onTrust(trusted);
    } catch (error) { setChallenge(undefined); setFeedback({ identity, error: errorMessage(error) }); }
  };
  const current = feedback?.identity === identity ? feedback : undefined;
  return <div className="ssh-server-probe">
    <div className="environment-server-card-title"><div className="ssh-server-heading"><strong>{name}</strong>
      <span className={`ssh-server-probe-status${current?.result ? " is-connected" : current?.error ? " is-failed" : ""}`} role="status">
        {busy ? "探测中…" : challenge ? "待确认指纹" : current?.result ? <span title={`${current.result.username}@${current.result.hostname} · ${current.result.timeZone} · UTC ${current.result.offset}`}>已连接 · {current.result.durationMs} ms</span> : current?.error ? "连接失败" : null}
      </span>
    </div><div className="ssh-server-probe-actions" role="group" aria-label={`${name} 操作`}>
      <button className="ssh-server-test-button" type="button" disabled={!!challenge} aria-busy={busy} aria-label={busy ? "取消探测" : "探测服务器状态"} onClick={() => { if (busy) { controller.current?.abort(); setBusy(false); } else void run(); }} title={busy ? "取消探测" : "探测服务器状态"}>
        {busy ? <span className="button-spinner" aria-hidden="true" /> : <ServerProbeIcon />}
      </button>{actions}
    </div></div>
    {current?.error && <p role="alert" className="environment-config-error">连接失败：{current.error}</p>}
    {challenge && <SshHostKeyDialog challenge={challenge} busy={false} detail="确认后重试；保存配置以保留指纹。" onConfirm={confirm} onCancel={() => { setChallenge(undefined); setFeedback({ identity, error: "已取消指纹确认" }); }} />}
  </div>;
};

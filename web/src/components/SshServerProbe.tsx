import { useEffect, useRef, useState } from "react";
import { errorMessage, probeSshServer, type SshProbeResult } from "../api";
import { parseSshHostKeyChallenge, trustSshHostKey, type SshHostKeyChallenge } from "../ssh-host-key";
import type { SshServerConfiguration } from "../types";
import { PulseIcon } from "./Icons";
import { SshHostKeyDialog } from "./SshHostKeyDialog";

interface Props { server: SshServerConfiguration; timeout?: number; onTrust: (server: SshServerConfiguration) => void }

export const SshServerProbe = ({ server, timeout = 10, onTrust }: Props) => {
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
    <div className="ssh-server-probe-actions">
      <button type="button" disabled={busy || !!challenge} aria-busy={busy} onClick={() => void run()} title="使用当前草稿建立新连接，验证认证及只读命令；不保存配置、不读取业务日志">
        {busy ? <span className="button-spinner" aria-hidden="true" /> : <PulseIcon />}{busy ? "探测中…" : "探测连接"}
      </button>
      {busy && <button type="button" onClick={() => { controller.current?.abort(); setBusy(false); }}>取消探测</button>}
      <small>使用当前未保存配置 · {server.authentication === "ssh-config" ? "SSH Config 取自运行端" : "不读取业务日志"}</small>
    </div>
    {current?.result && <p role="status" className="ssh-server-probe-success">连接、认证及命令执行正常 · {current.result.durationMs} ms · {current.result.username}@{current.result.hostname} · {current.result.timeZone}（UTC {current.result.offset}）</p>}
    {current?.error && <p role="alert" className="environment-config-error">探测失败：{current.error}</p>}
    {challenge && <SshHostKeyDialog challenge={challenge} busy={false} detail="确认后写入当前服务器草稿并自动重新探测；需要保存配置后才会持久保留指纹。" onConfirm={confirm} onCancel={() => { setChallenge(undefined); setFeedback({ identity, error: "已取消指纹确认，未继续连接" }); }} />}
  </div>;
};

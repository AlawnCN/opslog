export interface SshHostKeyChallenge {
  host: string;
  port: number;
  fingerprint: string;
}

export const parseSshHostKeyChallenge = (message: string): SshHostKeyChallenge | undefined => {
  const match = /SSH_HOST_KEY_REQUIRED\|([^|\s]+)\|(\d{1,5})\|(SHA256:[A-Za-z0-9+/]{43})/.exec(message);
  if (!match) return undefined;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? { host: match[1]!, port, fingerprint: match[3]! } : undefined;
};

export const trustSshHostKey = (servers: SshServerConfiguration[], challenge: SshHostKeyChallenge): SshServerConfiguration[] => {
  let matched = false;
  const updated = servers.map((server) => {
    if (server.authentication !== "password" || server.host.trim() !== challenge.host || (server.port ?? 22) !== challenge.port) return server;
    matched = true;
    if (server.hostKeyFingerprint && server.hostKeyFingerprint !== challenge.fingerprint) {
      throw new Error("服务器原有主机指纹已改变，请联系管理员核对后在配置中重置");
    }
    return { ...server, hostKeyFingerprint: challenge.fingerprint };
  });
  if (!matched) throw new Error("服务器配置已变更，请重新连接");
  return updated;
};
import type { SshServerConfiguration } from "./types";

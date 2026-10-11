import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import type { SshServerConfig } from "./domain.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const IDLE_MS = 10 * 60 * 1000;
const { Client } = ssh2;
interface Connection {
  scope: string;
  client: InstanceType<typeof Client>;
  ready: Promise<void>;
  active: number;
  retired?: boolean;
  idle?: ReturnType<typeof setTimeout>;
}
const connections = new Map<string, Connection>();

export const closePasswordSshConnections = (scope?: string): void => {
  for (const [key, connection] of connections) {
    if (scope !== undefined && connection.scope !== scope) continue;
    connections.delete(key);
    clearTimeout(connection.idle);
    connection.retired = true;
    if (!connection.active) connection.client.destroy();
  }
};

const acquire = (server: SshServerConfig, connectTimeout: number, scope: string): Connection => {
  // Credentials never appear in diagnostics or socket paths. Changed pins/accounts
  // cannot select an older authenticated connection.
  const key = createHash("sha256").update(JSON.stringify([scope, server, connectTimeout])).digest("hex");
  const existing = connections.get(key);
  if (existing) { clearTimeout(existing.idle); return existing; }
  if (connections.size >= 32) {
    const idle = [...connections].find(([, value]) => value.active === 0);
    if (!idle) throw new Error("SSH 并发连接过多，请稍后重试");
    clearTimeout(idle[1].idle);
    connections.delete(idle[0]);
    idle[1].client.destroy();
  }
  const client = new Client();
  const port = server.port ?? 22;
  let fingerprint = "";
  const ready = new Promise<void>((resolve, reject) => {
    client.once("ready", resolve);
    client.on("error", (error) => {
      if (!server.hostKeyFingerprint && fingerprint) return reject(new Error(`首次连接需核对 SSH 服务器指纹；请使用最新版客户端确认。SSH_HOST_KEY_REQUIRED|${server.host}|${port}|${fingerprint}`));
      if (server.hostKeyFingerprint && fingerprint && server.hostKeyFingerprint !== fingerprint) return reject(new Error(`服务器 ${server.host}:${port} 的 SSH 主机指纹已改变，已拒绝连接；请联系管理员核对。当前指纹 ${fingerprint}`));
      reject(new Error(`SSH 连接失败：${error.message}`));
    });
    client.once("close", () => reject(new Error("SSH 连接已断开")));
  });
  const connection: Connection = { scope, client, ready, active: 0 };
  connections.set(key, connection);
  client.once("close", () => {
    clearTimeout(connection.idle);
    if (connections.get(key) === connection) connections.delete(key);
  });
  client.on("keyboard-interactive", (_name, _instructions, _language, prompts, done) => done(prompts.map(() => server.password ?? "")));
  client.connect({
    host: server.host, port, username: server.username ?? "", password: server.password ?? "",
    readyTimeout: connectTimeout * 1000, tryKeyboard: true,
    keepaliveInterval: 30_000, keepaliveCountMax: 3,
    hostVerifier: (hostKey: Buffer) => {
      fingerprint = `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
      return !!server.hostKeyFingerprint && server.hostKeyFingerprint === fingerprint;
    }
  });
  return connection;
};

export const runPasswordSshScript = (server: SshServerConfig, script: string, args: string[], connectTimeout: number, timeoutSeconds: number, signal?: AbortSignal, scope = ""): Promise<string> => {
  signal?.throwIfAborted();
  const connection = acquire(server, connectTimeout, scope);
  connection.active += 1;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let channel: ssh2.ClientChannel | undefined;
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      connection.client.removeListener("close", disconnected);
      connection.client.removeListener("error", failed);
      if (error) channel?.destroy();
      connection.active -= 1;
      if (!connection.active && connection.retired) connection.client.destroy();
      if (!connection.active) {
        connection.idle = setTimeout(() => connection.client.end(), IDLE_MS);
        connection.idle.unref();
      }
      if (error) reject(error);
      else resolve(output!.toString("utf8"));
    };
    const abort = () => finish(new DOMException("查询已终止", "AbortError"));
    const disconnected = () => finish(new Error("SSH 连接已断开，请重试查询"));
    const failed = (error: Error) => { void connection.ready.then(() => finish(new Error(`SSH 连接失败：${error.message}`)), (cause: Error) => finish(cause)); };
    const timer = setTimeout(() => finish(new Error("SSH 查询超时，请检查网络与远端负载")), (connectTimeout + timeoutSeconds + 10) * 1000);
    connection.client.on("close", disconnected);
    connection.client.on("error", failed);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    void connection.ready.then(() => {
      if (settled) return;
      connection.client.exec(`timeout ${timeoutSeconds} sh -s -- ${args.join(" ")}`, (error, stream) => {
        if (error) return finish(new Error(`SSH 命令启动失败：${error.message}`));
        channel = stream;
        if (settled) { stream.destroy(); return; }
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let outputSize = 0;
        const collect = (target: Buffer[], chunk: Buffer) => {
          outputSize += chunk.length;
          if (outputSize > MAX_OUTPUT_BYTES) finish(new Error("SSH 返回内容超过 64 MB 安全上限，请缩小查询范围"));
          else target.push(chunk);
        };
        stream.on("data", (chunk: Buffer) => collect(stdout, chunk));
        stream.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        stream.on("error", (cause: Error) => finish(cause));
        stream.on("close", (code: number | null) => code !== 0
          ? finish(new Error(Buffer.concat(stderr).toString("utf8").trim() || `SSH 命令执行失败：${code}`))
          : finish(undefined, Buffer.concat(stdout)));
        stream.end(script.replace(/\r\n?/g, "\n"));
      });
    }, (error: Error) => finish(error));
  });
};

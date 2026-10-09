import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import type { SshServerConfig } from "./domain.js";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const { Client } = ssh2;

export const runPasswordSshScript = (server: SshServerConfig, script: string, args: string[], connectTimeout: number, timeoutSeconds: number, signal?: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
  const client = new Client();
  const port = server.port ?? 22;
  let fingerprint = "";
  let settled = false;
  const finish = (error?: Error, output?: Buffer) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    client.end();
    if (error) reject(error);
    else resolve(output!.toString("utf8"));
  };
  const abort = () => finish(new DOMException("查询已终止", "AbortError"));
  const timer = setTimeout(() => finish(new Error("SSH 查询超时，请检查网络与远端负载")), (connectTimeout + timeoutSeconds + 10) * 1000);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) { abort(); return; }
  client.on("error", (error) => {
    if (!server.hostKeyFingerprint && fingerprint) return finish(new Error(`首次连接需核对 SSH 服务器指纹；请使用最新版客户端确认。SSH_HOST_KEY_REQUIRED|${server.host}|${port}|${fingerprint}`));
    if (server.hostKeyFingerprint && fingerprint && server.hostKeyFingerprint !== fingerprint) return finish(new Error(`服务器 ${server.host}:${port} 的 SSH 主机指纹已改变，已拒绝连接；请联系管理员核对。当前指纹 ${fingerprint}`));
    finish(new Error(`SSH 连接失败：${error.message}`));
  });
  client.on("close", () => finish(new Error("SSH 连接已断开")));
  client.on("keyboard-interactive", (_name, _instructions, _language, prompts, done) => done(prompts.map(() => server.password ?? "")));
  client.on("ready", () => {
    client.exec(`timeout ${timeoutSeconds} sh -s -- ${args.join(" ")}`, (error, stream) => {
      if (error) return finish(new Error(`SSH 命令启动失败：${error.message}`));
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputSize = 0;
      stream.on("data", (chunk: Buffer) => {
        outputSize += chunk.length;
        if (outputSize > MAX_OUTPUT_BYTES) finish(new Error("SSH 返回内容超过 64 MB 安全上限，请缩小查询范围"));
        else stdout.push(chunk);
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        outputSize += chunk.length;
        if (outputSize > MAX_OUTPUT_BYTES) finish(new Error("SSH 错误输出超过 64 MB 安全上限"));
        else stderr.push(chunk);
      });
      stream.on("close", (code: number | null) => {
        if (code !== 0) return finish(new Error(Buffer.concat(stderr).toString("utf8").trim() || `SSH 命令执行失败：${code}`));
        finish(undefined, Buffer.concat(stdout));
      });
      stream.end(script.replace(/\r\n?/g, "\n"));
    });
  });
  client.connect({
    host: server.host, port, username: server.username ?? "", password: server.password ?? "",
    readyTimeout: connectTimeout * 1000, tryKeyboard: true,
    hostVerifier: (key: Buffer) => {
      fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
      return !!server.hostKeyFingerprint && server.hostKeyFingerprint === fingerprint;
    }
  });
});

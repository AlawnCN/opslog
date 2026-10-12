import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";
import { probeSshServer } from "../server/ssh-log-source.js";
import { parseEnvironmentConfig } from "../server/environment-store.js";

test("server probe verifies fresh authentication, fingerprint, command output and cancellation", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const pin = `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  let connections = 0, commands = 0;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    connections++;
    let user = "";
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      user = context.username;
      if (context.method === "password" && context.password === "fixture-only") context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => accept().on("exec", (exec) => {
      commands++;
      const stream = exec();
      let input = "";
      stream.on("error", () => undefined);
      stream.on("data", (chunk: Buffer) => { input += chunk.toString(); });
      stream.on("end", () => {
        assert.match(input, /OPSLOG_SSH_PROBE_V1/);
        assert.doesNotMatch(input, /find |grep |cat |rm /);
        if (user === "slow") return;
        stream.write(user === "bad-output" ? "unexpected\n" : "OPSLOG_SSH_PROBE_V1\nfixture\nfixture-host\nCST\n+08:00\n");
        stream.exit(0); stream.end();
      });
    })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fixture = (changes = {}) => parseEnvironmentConfig(JSON.stringify([{
    name: "unsaved-draft", sourceType: "ssh", sshConnectTimeoutSeconds: 3,
    sshServers: [{ name: "draft-server", host: "127.0.0.1", port: (server.address() as AddressInfo).port,
      authentication: "password", username: "fixture", password: "fixture-only", hostKeyFingerprint: pin, ...changes }],
    sshMonitoredApplications: [{ name: "cte", directory: "/not-used" }]
  }]))[0]!;
  try {
    await assert.rejects(probeSshServer(fixture({ hostKeyFingerprint: undefined })), /SSH_HOST_KEY_REQUIRED/);
    const result = await probeSshServer(fixture());
    assert.equal(result.username, "fixture"); assert.equal(result.hostname, "fixture-host");
    assert.equal(result.offset, "+08:00"); assert.ok(result.durationMs >= 0);
    assert.equal(JSON.stringify(result).includes("fixture-only"), false);
    await probeSshServer(fixture());
    assert.equal(connections, 3, "retesting uses a fresh connection, not a previously authenticated pool entry");
    await assert.rejects(probeSshServer(fixture({ password: "wrong" })), /authentication|认证|连接失败/i);
    await assert.rejects(probeSshServer(fixture({ hostKeyFingerprint: `SHA256:${"A".repeat(43)}` })), /指纹已改变/);
    await assert.rejects(probeSshServer(fixture({ username: "bad-output" })), /返回格式异常/);
    const controller = new AbortController();
    const pending = probeSshServer(fixture({ username: "slow" }), controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancel|abort|取消/i);
    assert.equal(commands, 3, "failed authentication and mismatched fingerprints never execute commands");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

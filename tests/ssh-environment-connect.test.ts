import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";
import { connectSshEnvironment } from "../server/ssh-log-source.js";
import { parseEnvironmentConfig } from "../server/environment-store.js";
import { closePasswordSshConnections } from "../server/ssh-password-transport.js";

test("selected environment readiness confirms every server and reuses authenticated connections", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const key = ssh2.utils.parseKey(privateKey); if (key instanceof Error) throw key;
  const fingerprint = `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  let connections = 0, commands = 0;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    connections++;
    client.on("error", () => {});
    client.on("authentication", context => context.method === "password" && context.password === "fixture-only" ? context.accept() : context.reject());
    client.on("ready", () => client.on("session", accept => accept().on("exec", exec => {
      commands++; const stream = exec(); stream.on("data", () => {});
      stream.on("end", () => { stream.write("Asia/Shanghai\n+08:00\n"); stream.exit(0); stream.end(); });
    })));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { name: "connection-fixture", sourceType: "ssh", sshAutoDetectTimeZone: false, sshServers: [{ name: "fixture", host: "127.0.0.1", port: (server.address() as AddressInfo).port, authentication: "password", username: "fixture", password: "fixture-only", hostKeyFingerprint: fingerprint }], sshMonitoredApplications: [{ name: "cte", directory: "/fixture" }] };
  try {
    const environment = parseEnvironmentConfig(JSON.stringify([config]))[0]!;
    await connectSshEnvironment(environment); await connectSshEnvironment(environment);
    assert.equal(connections, 1, "readiness checks share the environment connection pool");
    assert.equal(commands, 2, "cached timezone alone cannot claim a live connection");
    const mixed = parseEnvironmentConfig(JSON.stringify([{ ...config, sshServers: [...config.sshServers, { ...config.sshServers[0], name: "rejected", username: "other", password: "wrong" }] }]))[0]!;
    await assert.rejects(connectSshEnvironment(mixed), /部分服务器连接失败/);
  } finally {
    closePasswordSshConnections(config.name);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

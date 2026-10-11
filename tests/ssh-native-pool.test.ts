import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";

test("native Rust password transport reuses TCP authentication and reconnects after release", { timeout: 120_000 }, async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const pin = `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  let connections = 0, authentications = 0, commands = 0;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    connections++;
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "reader" && context.password === "secret") { authentications++; context.accept(); }
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => accept().on("exec", (exec) => {
      commands++;
      const stream = exec();
      let input = "";
      stream.on("data", (chunk: Buffer) => { input += chunk.toString(); });
      stream.on("error", () => undefined);
      stream.on("end", () => { if (input === "slow") return; stream.write(`received:${input}`); stream.exit(0); stream.end(); });
    })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn("cargo", ["test", "--lib", "native_pool_reuses_and_releases_authenticated_sessions", "--", "--ignored", "--nocapture"], {
      cwd: new URL("../src-tauri", import.meta.url),
      env: { ...process.env, OPSLOG_SSH_POOL_TEST_PORT: String((server.address() as AddressInfo).port), OPSLOG_SSH_POOL_TEST_PIN: pin },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(code, 0, output);
    assert.equal(connections, 4, "one reused session, release reconnect, rejected pin, cancellation reconnect");
    assert.equal(authentications, 3, "commands reuse authentication; a bad pin is rejected before auth");
    assert.equal(commands, 9);
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

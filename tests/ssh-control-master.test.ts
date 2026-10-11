import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";
import { closeSshControlMasters, sshControlMasterOptions } from "../server/ssh-control-master";

test("system OpenSSH reuses its master and creates a new master after environment release", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  let connections = 0;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    connections++;
    client.on("error", () => undefined);
    client.on("authentication", (context) => context.method === "none" ? context.accept() : context.reject());
    client.on("ready", () => client.on("session", (accept) => accept().on("exec", (exec) => {
      const stream = exec();
      stream.write("fixture"); stream.exit(0); stream.end();
    })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const run = async () => {
    const child = spawn("ssh", [...sshControlMasterOptions("fixture", { port }, "127.0.0.1"), "-p", String(port),
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "PreferredAuthentications=none", "127.0.0.1", "true"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "fixture");
  };
  try {
    await run(); await run(); await run();
    assert.equal(connections, 1);
    closeSshControlMasters("unrelated");
    await run(); assert.equal(connections, 1);
    closeSshControlMasters("fixture");
    await run(); assert.equal(connections, 2);
  } finally {
    closeSshControlMasters();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

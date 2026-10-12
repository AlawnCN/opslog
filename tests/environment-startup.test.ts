import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import ssh2 from "ssh2";

test("environment list never waits for SSH; only selected time profile connects", async () => {
  const root = await mkdtemp(join(tmpdir(), "opslog-startup-"));
  const originalDirectory = process.cwd();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const pin = `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  let connections = 0;
  let finishProbe: (() => void) | undefined;
  let startedProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => { startedProbe = resolve; });
  const sshServer = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    connections++;
    client.on("error", () => undefined);
    client.on("authentication", (context) => context.accept());
    client.on("ready", () => client.on("session", (accept) => accept().on("exec", (acceptExec) => {
      const stream = acceptExec();
      stream.on("data", () => undefined);
      stream.on("end", () => {
        finishProbe = () => { stream.write("Asia/Shanghai\n+08:00\n"); stream.exit(0); stream.end(); };
        startedProbe();
      });
    })));
  });
  await new Promise<void>((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
  const fixture = (name: string, auto = true) => ({ name, sourceType: "ssh", timeZone: "Africa/Nairobi",
    sshLogTimeOffset: "+03:00", sshAutoDetectTimeZone: auto,
    sshServers: [{ name: "fixture", host: "127.0.0.1", port: (sshServer.address() as AddressInfo).port,
      authentication: "password", username: "fixture", password: "fixture-only", hostKeyFingerprint: pin }],
    sshMonitoredApplications: [{ name: "cte", directory: "/fixture/cte" }] });
  await writeFile(join(root, "opslog-envs.json"), JSON.stringify([fixture("selected"), fixture("other"), fixture("manual", false)]));
  process.chdir(root);
  const { apiRouter, errorHandler } = await import("../server/routes.js");
  const { closePasswordSshConnections } = await import("../server/ssh-password-transport.js");
  const app = express(); app.use(express.json()); app.use("/api", apiRouter); app.use(errorHandler);
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api/environments`;
  const profile = (name: string) => fetch(`${url}/time-profile`, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  try {
    const list = await (await fetch(url, { signal: AbortSignal.timeout(2000) })).json();
    assert.equal(list.length, 3);
    assert.equal(connections, 0, "listing configuration must not open SSH sockets");
    assert.equal(JSON.stringify(list).includes("fixture-only"), false);
    const pending = profile("selected");
    await Promise.race([probeStarted, new Promise((_, reject) => setTimeout(() => reject(new Error("probe did not start")), 3000).unref())]);
    assert.equal((await (await fetch(url, { signal: AbortSignal.timeout(2000) })).json()).length, 3,
      "list stays available while a selected host is still probing");
    assert.equal(connections, 1, "unselected environments must not connect");
    finishProbe!();
    const resolved = await (await pending).json();
    assert.equal(resolved.name, "selected");
    assert.equal(resolved.timeZone, "Asia/Shanghai");
    assert.equal(resolved.timeZoneOffset, "+08:00");
    assert.equal(resolved.timeZoneSource, "ssh");
    await profile("selected");
    assert.equal(connections, 1, "resolved profiles retain the existing cache");
    assert.equal((await (await profile("manual")).json()).timeZoneSource, "configured");
    assert.equal(connections, 1, "disabled automatic detection must not connect");
    assert.equal((await profile("unknown")).ok, false);
  } finally {
    finishProbe?.(); closePasswordSshConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => sshServer.close(() => resolve()));
    process.chdir(originalDirectory);
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop listing and UI guards stay independent of remote time detection", async () => {
  const commands = await readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
  const listing = commands.split("pub async fn load_environments")[1]!.split("#[tauri::command]")[0]!;
  assert.doesNotMatch(listing, /resolve_time_profile|run_across_servers/);
  const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /if \(!active\) return;/);
  assert.match(app, /if \(!environmentReady\) return;/);
  assert.match(app, /loading=\{loading \|\| !environmentReady\}/);
});

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";
import { closePasswordSshConnections, runPasswordSshScript } from "../server/ssh-password-transport";
import { parseSshHostKeyChallenge, trustSshHostKey } from "../web/src/ssh-host-key";
import type { SshServerConfiguration } from "../web/src/types";

const { Server } = ssh2;

test("host-key challenge is recognized inside a server-group error or warning", () => {
  const fingerprint = `SHA256:${"A".repeat(43)}`;
  const message = `服务器组执行失败：182.188.5.151：首次连接需核对 SSH 服务器指纹。SSH_HOST_KEY_REQUIRED|182.188.5.151|22|${fingerprint}`;
  assert.deepEqual(parseSshHostKeyChallenge(message), { host: "182.188.5.151", port: 22, fingerprint });
  assert.deepEqual(parseSshHostKeyChallenge(`server：SSH_HOST_KEY_REQUIRED|2001:db8::1|2222|${fingerprint}`), { host: "2001:db8::1", port: 2222, fingerprint });
});

test("confirming a host key pins only the matching password server", () => {
  const fingerprint = `SHA256:${"A".repeat(43)}`;
  const servers: SshServerConfiguration[] = [
    { name: "one", host: "182.188.5.151", authentication: "password" as const, username: "reader", password: "secret" },
    { name: "two", host: "182.188.5.152", authentication: "password" as const, username: "reader", password: "secret" }
  ];
  const trusted = trustSshHostKey(servers, { host: "182.188.5.151", port: 22, fingerprint });
  assert.equal(trusted[0]?.hostKeyFingerprint, fingerprint);
  assert.equal(trusted[1], servers[1]);
  assert.equal(servers[0]?.hostKeyFingerprint, undefined);
  assert.throws(() => trustSshHostKey(trusted, { host: "182.188.5.151", port: 22, fingerprint: `SHA256:${"B".repeat(43)}` }), /主机指纹已改变/);
});

test("password SSH confirms host key before authentication and runs a script after approval", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  let authenticationCount = 0;
  let connectionCount = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    connectionCount += 1;
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      authenticationCount += 1;
      if (context.method === "password" && context.username === "reader" && context.password === "secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (acceptExec) => {
        const stream = acceptExec();
        let input = "";
        stream.on("data", (chunk: Buffer) => { input += chunk.toString("utf8"); });
        stream.on("error", () => undefined);
        stream.on("end", () => {
          if (input === "slow") return;
          if (input === "fail") { stream.stderr.write("remote failure"); stream.exit(7); stream.end(); return; }
          stream.write(`received:${input}`); stream.exit(0); stream.end();
        });
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const config = { name: "local", host: "127.0.0.1", port, username: "reader", password: "secret", authentication: "password" as const };
  try {
    let firstError = "";
    try { await runPasswordSshScript(config, "set -eu\r\nprintf ok\r\n", [], 5, 5); }
    catch (error) { firstError = String(error); }
    const challenge = parseSshHostKeyChallenge(firstError);
    assert.ok(challenge, firstError);
    assert.equal(authenticationCount, 0);
    const output = await runPasswordSshScript({ ...config, hostKeyFingerprint: challenge.fingerprint }, "set -eu\r\nprintf ok\r\n", [], 5, 5);
    assert.equal(output, "received:set -eu\nprintf ok\n");
    assert.ok(authenticationCount > 0);
    const authenticated = authenticationCount;
    const trusted = { ...config, hostKeyFingerprint: challenge.fingerprint };
    assert.equal(await runPasswordSshScript(trusted, "second", [], 5, 5), "received:second");
    assert.deepEqual(await Promise.all(["third", "fourth"].map((script) => runPasswordSshScript(trusted, script, [], 5, 5))), ["received:third", "received:fourth"]);
    assert.equal(connectionCount, 2, "untrusted probe plus exactly one authenticated connection");
    assert.equal(authenticationCount, authenticated, "sequential and concurrent commands must not reauthenticate");
    await assert.rejects(runPasswordSshScript(trusted, "fail", [], 5, 5), /remote failure/);
    const abort = new AbortController();
    const cancelled = runPasswordSshScript(trusted, "slow", [], 5, 5, abort.signal);
    abort.abort();
    await assert.rejects(cancelled, /查询已终止/);
    assert.equal(await runPasswordSshScript(trusted, "after-cancel", [], 5, 5), "received:after-cancel");
    assert.equal(connectionCount, 2, "command errors/cancellation must not kill the shared connection");
    await runPasswordSshScript(trusted, "isolated", [], 5, 5, undefined, "another-environment");
    assert.equal(connectionCount, 3, "different environments must not share authentication state");
    closePasswordSshConnections("another-environment");
    await runPasswordSshScript(trusted, "default-still-live", [], 5, 5);
    assert.equal(connectionCount, 3, "releasing another environment must not evict this connection");
    closePasswordSshConnections("");
    await runPasswordSshScript(trusted, "reconnected", [], 5, 5);
    assert.equal(connectionCount, 4, "released environments reconnect on next access");
    await assert.rejects(runPasswordSshScript({ ...config, hostKeyFingerprint: "SHA256:" + "A".repeat(43) }, "true\n", [], 5, 5), /主机指纹已改变/);
    await assert.rejects(runPasswordSshScript({ ...trusted, password: "changed" }, "true", [], 5, 5), /认证|authentication/i);
  } finally {
    closePasswordSshConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

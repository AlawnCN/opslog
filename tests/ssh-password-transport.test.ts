import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { AddressInfo } from "node:net";
import test from "node:test";
import ssh2 from "ssh2";
import { runPasswordSshScript } from "../server/ssh-password-transport";
import { parseSshHostKeyChallenge } from "../web/src/ssh-host-key";

const { Server } = ssh2;

test("host-key challenge is recognized inside a server-group error or warning", () => {
  const fingerprint = `SHA256:${"A".repeat(43)}`;
  const message = `服务器组执行失败：182.188.5.151：首次连接需核对 SSH 服务器指纹。SSH_HOST_KEY_REQUIRED|182.188.5.151|22|${fingerprint}`;
  assert.deepEqual(parseSshHostKeyChallenge(message), { host: "182.188.5.151", port: 22, fingerprint });
  assert.deepEqual(parseSshHostKeyChallenge(`server：SSH_HOST_KEY_REQUIRED|2001:db8::1|2222|${fingerprint}`), { host: "2001:db8::1", port: 2222, fingerprint });
});

test("password SSH confirms host key before authentication and runs a script after approval", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  let authenticationCount = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
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
        stream.on("end", () => { stream.write(`received:${input}`); stream.exit(0); stream.end(); });
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
    await assert.rejects(runPasswordSshScript({ ...config, hostKeyFingerprint: "SHA256:" + "A".repeat(43) }, "true\n", [], 5, 5), /主机指纹已改变/);
  } finally {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

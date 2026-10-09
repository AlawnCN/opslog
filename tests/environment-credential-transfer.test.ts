import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptEnvironmentConfigurations,
  parseEnvironmentTransfer,
  serializeEncryptedEnvironmentConfigurations
} from "../web/src/environment-credential-transfer";
import type { EnvironmentConfiguration } from "../web/src/types";
import { parseEnvironmentConfigurationFile, serializeEnvironmentConfigurations } from "../web/src/environment-configuration";

const environments: EnvironmentConfiguration[] = [{
  name: "uat-elk",
  sourceType: "elk",
  kibanaUrl: "https://elk.example.test",
  username: "elk-user",
  password: "elk-secret",
  txnlstIndex: "transactions-*",
  txntrcIndex: "traces-*",
  applogIndex: "apps-*"
}, {
  name: "uat-ssh",
  sourceType: "ssh",
  kibanaUrl: "",
  username: "",
  password: "stale-elk-secret",
  txnlstIndex: "",
  txntrcIndex: "",
  applogIndex: "",
  sshServers: [{ name: "primary", host: "logs.example.test", username: "ops", authentication: "password", password: "ssh-secret", hostKeyFingerprint: `SHA256:${"A".repeat(43)}` }],
  sshMonitoredApplications: [{ name: "cte", directory: "/var/log/cte" }]
}];

test("加密环境配置不保存明文密码并可还原 ELK 与 SSH 密码", async () => {
  const contents = await serializeEncryptedEnvironmentConfigurations(environments, "long-enough-passphrase");
  const parsed = parseEnvironmentTransfer(contents);
  assert.equal(parsed.encrypted, true);
  assert.equal(contents.includes("elk-secret"), false);
  assert.equal(contents.includes("ssh-secret"), false);
  if (!parsed.encrypted) assert.fail("expected encrypted transfer");
  assert.equal("password" in (parsed.file.environments[0] ?? {}), false);
  assert.equal("password" in ((parsed.file.environments[1]?.sshServers as Array<Record<string, unknown>>)[0] ?? {}), false);
  assert.equal(contents.includes("stale-elk-secret"), false);

  const restored = await decryptEnvironmentConfigurations(parsed.file, "long-enough-passphrase");
  assert.equal(restored[0]?.password, "elk-secret");
  assert.equal(restored[1]?.password, "");
  assert.equal(restored[1]?.sshServers?.[0]?.password, "ssh-secret");
  assert.equal(restored[1]?.sshServers?.[0]?.hostKeyFingerprint, `SHA256:${"A".repeat(43)}`);
});

test("加密环境配置拒绝错误密钥、被篡改的元数据和明文密码", async () => {
  const contents = await serializeEncryptedEnvironmentConfigurations(environments, "long-enough-passphrase");
  const parsed = parseEnvironmentTransfer(contents);
  if (!parsed.encrypted) assert.fail("expected encrypted transfer");

  await assert.rejects(decryptEnvironmentConfigurations(parsed.file, "wrong-passphrase"), /密钥错误或加密配置文件已损坏/);

  const modified = structuredClone(parsed.file);
  modified.environments[0]!.name = "tampered";
  await assert.rejects(decryptEnvironmentConfigurations(modified, "long-enough-passphrase"), /密钥错误或加密配置文件已损坏/);

  const withPlaintext = structuredClone(parsed.file);
  withPlaintext.environments[0]!.password = "leaked-secret";
  assert.throws(() => parseEnvironmentTransfer(JSON.stringify(withPlaintext)), /包含明文密码/);
});

test("SSH 主机指纹随配置导出并可在重新导入后保留", () => {
  const contents = serializeEnvironmentConfigurations(environments);
  assert.equal(contents.includes(`SHA256:${"A".repeat(43)}`), true);
  const imported = parseEnvironmentConfigurationFile(contents);
  assert.equal(imported[1]?.sshServers?.[0]?.hostKeyFingerprint, `SHA256:${"A".repeat(43)}`);
});

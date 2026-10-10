import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptEnvironmentConfigurations,
  parseEnvironmentTransfer,
  serializeEncryptedEnvironmentConfigurations
} from "../web/src/environment-credential-transfer";
import type { EnvironmentConfiguration } from "../web/src/types";
import { nextSshServerName, sshOffsetForTimeZone, parseEnvironmentConfigurationFile, prepareEnvironmentConfigurationsForSave, serializeEnvironmentConfigurations, validateEnvironmentConfigurations } from "../web/src/environment-configuration";
import { defaultSshLogSources } from "../shared/ssh-log-defaults";

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

test("保存保留所有 SSH 应用的解析参数和分析说明，不受其他环境修改影响", () => {
  const drafts = structuredClone(environments);
  const sources = defaultSshLogSources();
  sources[0]!.paths = ["^log/txn_.*\\.lst$", "^trc/{day}/.*\\.trc$"];
  drafts[1]!.sshMonitoredApplications = [{ name: "cte", directory: "/var/log/cte/", logSources: sources, analysisNotes: ["review-note"] }];
  drafts[0]!.name = "changed-elk";
  const before = structuredClone(drafts);
  assert.equal(validateEnvironmentConfigurations(drafts), undefined);
  const saved = prepareEnvironmentConfigurationsForSave(drafts);
  assert.deepEqual(saved[1]?.sshMonitoredApplications?.[0]?.logSources, sources);
  assert.deepEqual(saved[1]?.sshMonitoredApplications?.[0]?.analysisNotes, ["review-note"]);
  assert.equal(saved[1]?.sshMonitoredApplications?.[0]?.directory, "/var/log/cte");
  assert.equal(saved[1]?.sshServers?.[0]?.password, "ssh-secret");
  assert.deepEqual(drafts, before);
  const restored = parseEnvironmentConfigurationFile(JSON.stringify(saved));
  assert.deepEqual(restored[1]?.sshMonitoredApplications, saved[1]?.sshMonitoredApplications);
});

test("路径正则语法错误返回具体行号，不静默保存非法正则", () => {
  const draft = structuredClone(environments[1]!);
  const sources = defaultSshLogSources().slice(0, 1);
  sources[0]!.paths = ["^log/txn_.*\\.lst$", "^trc/{day}/(*\\.trc$"];
  draft.sshMonitoredApplications = [{ name: "cte", directory: "/var/log/cte", logSources: sources }];
  assert.match(validateEnvironmentConfigurations([draft]) ?? "", /第 2 行无效/);
  sources[0]!.paths[1] = "^trc/{day}/.*\\.trc$";
  assert.equal(validateEnvironmentConfigurations([draft]), undefined);
});

test("保存规范化保留根目录映射", () => {
  const draft = structuredClone(environments[1]!);
  draft.sshMonitoredApplications = [{ name: "cte", directory: "/" }];
  assert.equal(prepareEnvironmentConfigurationsForSave([draft])[0]?.sshMonitoredApplications?.[0]?.directory, "/");
});

test("新增服务器名称跳过已占用名称（包含大小写差异）", () => {
  const servers = ["server-1", "SERVER-3"].map((name) => ({ name, host: "example.test", authentication: "ssh-config" as const }));
  assert.equal(nextSshServerName(servers), "server-2");
  assert.equal(nextSshServerName([...servers, { ...servers[0]!, name: "server-2" }]), "server-4");
});

test("时区联动派生正确偏移，包括负数和夏令时", () => {
  assert.equal(sshOffsetForTimeZone("Asia/Shanghai"), "+08:00");
  assert.equal(sshOffsetForTimeZone("UTC"), "+00:00");
  assert.equal(sshOffsetForTimeZone("America/New_York", new Date("2026-01-01T00:00:00Z")), "-05:00");
  assert.equal(sshOffsetForTimeZone("America/New_York", new Date("2026-07-01T00:00:00Z")), "-04:00");
  assert.equal(sshOffsetForTimeZone("invalid-zone"), "未知时区");
});

test("字段提取及成功码正则在保存前校验语法与捕获组", () => {
  const draft = structuredClone(environments[1]!);
  const source = defaultSshLogSources()[0]!;
  draft.sshMonitoredApplications = [{ name: "cte", directory: "/var/log/cte", logSources: [source] }];
  source.fields.timestamp = { regex: "(" };
  assert.match(validateEnvironmentConfigurations([draft]) ?? "", /正则语法无效/);
  source.fields.timestamp = { regex: "\\d+" };
  assert.match(validateEnvironmentConfigurations([draft]) ?? "", /捕获组/);
  source.fields.timestamp = { regex: "(\\d+)" };
  source.successPattern = "[";
  assert.match(validateEnvironmentConfigurations([draft]) ?? "", /正则语法无效/);
  source.successPattern = "00000$";
  assert.equal(validateEnvironmentConfigurations([draft]), undefined);
});

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

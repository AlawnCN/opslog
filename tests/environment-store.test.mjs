import assert from "node:assert/strict";
import test from "node:test";
import { normalizeKibanaUrl, parseEnvironmentConfig } from "../dist-server/server/environment-store.js";

test("Web 网关将遗留 Kibana IP 迁移为证书域名", () => {
  assert.equal(
    normalizeKibanaUrl("https://10.1.6.10/kibana"),
    "https://nexus.faulukenya.com/kibana"
  );
  assert.equal(
    normalizeKibanaUrl("https://10.1.145.70/kibana"),
    "https://m5uat.faulukenya.com/kibana"
  );
  assert.equal(
    normalizeKibanaUrl("https://kibana.example.test/kibana"),
    "https://kibana.example.test/kibana"
  );
});

test("Web 导入配置沿用环境校验和地址迁移规则", () => {
  const environments = parseEnvironmentConfig(JSON.stringify([{
    name: "test",
    kibanaUrl: "https://10.1.6.10/kibana",
    username: "user",
    password: "secret",
    txnlstIndex: "txn-list-*",
    txntrcIndex: "txn-trace-*",
    applogIndex: "app-*"
  }]));

  assert.equal(environments[0].kibanaUrl, "https://nexus.faulukenya.com/kibana");
  assert.throws(() => parseEnvironmentConfig("[]"), /环境配置内容不完整/);
  assert.throws(() => parseEnvironmentConfig("not-json"), /环境配置 JSON 不合法/);
});

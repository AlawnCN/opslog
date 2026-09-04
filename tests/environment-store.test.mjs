import assert from "node:assert/strict";
import test from "node:test";
import { normalizeKibanaUrl } from "../dist-server/server/environment-store.js";

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

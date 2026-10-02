import assert from "node:assert/strict";
import test from "node:test";
import { fetchGitHubRelease } from "../scripts/github-release-lookup.mjs";

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

test("finds an authenticated draft when GitHub's tag endpoint returns 404", async () => {
  const requested = [];
  const release = await fetchGitHubRelease("AlawnCN/opslog-release", "v3.1.7", "test-token", async (url) => {
    requested.push(url);
    if (url.includes("/tags/")) return response(404, {});
    return response(200, [{ tag_name: "v3.1.7", draft: true, assets: [] }]);
  });
  assert.equal(release.tag_name, "v3.1.7");
  assert.equal(release.draft, true);
  assert.match(requested[1], /per_page=100&page=1$/);
});

test("uses the direct tag lookup for an already published release", async () => {
  const release = await fetchGitHubRelease("AlawnCN/opslog-release", "v3.1.7", "test-token", async () =>
    response(200, { tag_name: "v3.1.7", draft: false })
  );
  assert.equal(release.draft, false);
});

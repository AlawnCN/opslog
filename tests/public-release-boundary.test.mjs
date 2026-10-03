import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedFiles, verifyPublicReleaseBoundary } from "../scripts/verify-public-release-boundary.mjs";

test("release-only repositories reject source files and directories", () => {
  assert.doesNotThrow(() => assertAllowedFiles([{ path: "README.md", type: "blob" }], ["README.md"], "GitHub"));
  assert.throws(() => assertAllowedFiles([{ path: "src/main.rs", type: "blob" }], ["README.md"], "GitHub"), /unexpected public repository file/);
  assert.throws(() => assertAllowedFiles([{ name: "src", type: "dir" }], ["README.md"], "Gitea"), /unexpected public repository file/);
});

test("release boundary requires the source repository to remain private", async () => {
  const fetcher = async (url) => ({
    ok: true,
    json: async () => url.includes("/AlawnCN/opslog-release")
      ? { private: false }
      : url.includes("/AlawnCN/opslog")
        ? { private: false }
        : { private: false }
  });
  await assert.rejects(verifyPublicReleaseBoundary("v3.1.8", "test-token", fetcher), /must remain private/);
});

test("release boundary accepts only release metadata at the main branch and tag", async () => {
  const requested = [];
  const fetcher = async (url) => {
    requested.push(url);
    const body = url.endsWith("/AlawnCN/opslog")
      ? { private: true }
      : url.endsWith("/AlawnCN/opslog-release") || url.endsWith("/Alawn/opslog-release")
        ? { private: false }
        : url.includes("/git/trees/")
          ? { truncated: false, tree: [{ path: "README.md", type: "blob" }] }
          : [{ name: "README.md", type: "file" }, { name: "latest.json", type: "file" }];
    return { ok: true, json: async () => body };
  };
  await assert.doesNotReject(verifyPublicReleaseBoundary("v3.1.8", "test-token", fetcher));
  assert.equal(requested.length, 7);
  assert.ok(requested.some((url) => url.includes("ref=v3.1.8")));
});

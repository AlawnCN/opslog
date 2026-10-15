import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedFiles, verifyPublicReleaseBoundary } from "../scripts/verify-public-release-boundary.mjs";

test("release-only repositories reject source files and directories", () => {
  assert.doesNotThrow(() => assertAllowedFiles([{ path: "README.md", type: "blob" }], ["README.md"], "GitHub"));
  assert.throws(() => assertAllowedFiles([{ path: "src/main.rs", type: "blob" }], ["README.md"], "GitHub"), /unexpected public repository file/);
  assert.throws(() => assertAllowedFiles([{ name: "src", type: "dir" }], ["README.md"], "Gitea"), /unexpected public repository file/);
});

test("release boundary rejects invalid source repository metadata", async () => {
  const fetcher = async (url) => ({
    ok: true,
    json: async () => url.includes("/AlawnCN/opslog-release")
      ? { private: false }
      : url.includes("/AlawnCN/opslog")
        ? {}
        : { private: false }
  });
  await assert.rejects(verifyPublicReleaseBoundary("v3.1.8", "test-token", fetcher), /invalid source repository metadata/);
});

for (const privateSource of [true, false]) test(`release boundary accepts release-only mirrors with ${privateSource ? "private" : "public"} source`, async () => {
  const requested = [];
  const fetcher = async (url) => {
    requested.push(url);
    const body = url.endsWith("/AlawnCN/opslog")
      ? { private: privateSource }
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

test("public source does not relax mirror visibility or source-file checks", async () => {
  for (const unsafe of ["private-mirror", "source-file"]) {
    const fetcher = async (url) => ({ ok: true, json: async () =>
      url.endsWith("/AlawnCN/opslog") ? { private: false }
        : url.endsWith("/AlawnCN/opslog-release") ? { private: unsafe === "private-mirror" }
          : url.endsWith("/Alawn/opslog-release") ? { private: false }
            : url.includes("/git/trees/") ? { truncated: false, tree: [{ path: "src/main.rs", type: "blob" }] }
              : [{ name: "README.md", type: "file" }]
    });
    await assert.rejects(verifyPublicReleaseBoundary("v3.1.19", "test-token", fetcher),
      unsafe === "private-mirror" ? /must remain public/ : /unexpected public repository file/);
  }
});

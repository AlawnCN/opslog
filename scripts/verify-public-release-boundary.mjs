import { pathToFileURL } from "node:url";

const GITHUB_SOURCE = "AlawnCN/opslog";
const GITHUB_RELEASE = "AlawnCN/opslog-release";
const GITEA_RELEASE = "Alawn/opslog-release";

export const assertAllowedFiles = (entries, allowed, label) => {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label}: empty or invalid tree`);
  const names = entries.map((entry) => entry.path ?? entry.name);
  if (new Set(names).size !== names.length || names.some((name) => !allowed.includes(name))) {
    throw new Error(`${label}: unexpected public repository file: ${names.join(", ")}`);
  }
  if (entries.some((entry) => !["blob", "file"].includes(entry.type))) {
    throw new Error(`${label}: public repository contains a directory or non-file entry`);
  }
};

export const verifyPublicReleaseBoundary = async (tag, token, fetcher = fetch) => {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag) || !token) {
    throw new Error("release tag and GitHub token are required");
  }
  const githubHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OpsLog-release-boundary"
  };
  const get = async (url, headers = {}, optional = false) => {
    const response = await fetcher(url, { headers });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`release boundary API failed: HTTP ${response.status} ${url}`);
    return response.json();
  };
  const githubApi = "https://api.github.com/repos";
  const giteaApi = "https://git.alawn.cn/api/v1/repos";
  const [source, githubRelease, giteaRelease] = await Promise.all([
    get(`${githubApi}/${GITHUB_SOURCE}`, githubHeaders),
    get(`${githubApi}/${GITHUB_RELEASE}`, githubHeaders),
    get(`${giteaApi}/${GITEA_RELEASE}`)
  ]);
  if (source.private !== true) throw new Error(`${GITHUB_SOURCE} must remain private`);
  if (githubRelease.private !== false || giteaRelease.private !== false) {
    throw new Error("both release repositories must remain public for auto-update");
  }

  for (const ref of ["main", tag]) {
    const githubTree = await get(`${githubApi}/${GITHUB_RELEASE}/git/trees/${encodeURIComponent(ref)}?recursive=1`, githubHeaders, ref === tag);
    if (githubTree) {
      if (githubTree.truncated) throw new Error(`GitHub ${ref}: truncated repository tree`);
      assertAllowedFiles(githubTree.tree, ["README.md"], `GitHub ${ref}`);
    }
    const giteaTree = await get(`${giteaApi}/${GITEA_RELEASE}/contents?ref=${encodeURIComponent(ref)}`, {}, ref === tag);
    if (giteaTree) {
      assertAllowedFiles(giteaTree, ["README.md", "latest.json", "reader-latest.json"], `Gitea ${ref}`);
    }
  }
  process.stdout.write(`Public release repositories contain only approved files for ${tag}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyPublicReleaseBoundary(process.argv[2], process.env.GH_TOKEN);
}

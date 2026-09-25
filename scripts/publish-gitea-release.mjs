import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const [, , tag, assetDirectory, manifestDirectory, notesFile] = process.argv;
const token = process.env.GITEA_RELEASE_TOKEN;
if (!tag || !assetDirectory || !manifestDirectory || !notesFile || !token) {
  throw new Error("tag, asset paths, notes file and GITEA_RELEASE_TOKEN are required");
}
if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("invalid release tag");

const api = "https://git.alawn.cn/api/v1/repos/Alawn/opslog-release";
// This self-hosted Gitea advertises an internal :3001 download host in API responses.
const publicAssetUrl = (name) => `https://git.alawn.cn/Alawn/opslog-release/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
const notes = await readFile(notesFile, "utf8");
if (!notes.trim()) throw new Error("release notes must not be empty");

const request = async (path, options = {}) => {
  const response = await fetch(`${api}${path}`, {
    ...options,
    headers: { Authorization: `token ${token}`, ...options.headers }
  });
  if (!response.ok) throw new Error(`Gitea ${options.method ?? "GET"} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
};

const hashRemote = async (url) => {
  const response = await fetch(url, { headers: { Authorization: `token ${token}` } });
  if (!response.ok || !response.body) throw new Error(`cannot download Gitea asset: HTTP ${response.status}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
};

const releasePath = `/releases/tags/${encodeURIComponent(tag)}`;
let release;
const existing = await fetch(`${api}${releasePath}`, { headers: { Authorization: `token ${token}` } });
if (existing.status === 404) {
  release = await request("/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, target_commitish: "main", name: `OpsLog ${tag.slice(1)}`, body: notes, draft: true, prerelease: false })
  });
} else if (existing.ok) {
  release = await existing.json();
  if (release.body !== notes) throw new Error(`Gitea ${tag} notes differ from release notes`);
} else {
  throw new Error(`cannot inspect Gitea ${tag}: HTTP ${existing.status}`);
}
if (release.body !== notes) throw new Error(`Gitea ${tag} notes differ from update manifests`);

const entries = [
  ...(await readdir(assetDirectory)).map((name) => join(assetDirectory, name)),
  ...["latest.json", "reader-latest.json", "SHA256SUMS"].map((name) => join(manifestDirectory, name))
];
const names = entries.map((path) => basename(path));
if (new Set(names).size !== names.length) throw new Error("duplicate release asset names");

for (const path of entries) {
  const name = basename(path);
  const bytes = await readFile(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const prior = release.assets?.find((asset) => asset.name === name);
  if (prior) {
    if (prior.size !== bytes.length || await hashRemote(publicAssetUrl(name)) !== digest) {
      throw new Error(`Gitea draft already contains different asset: ${name}`);
    }
    continue;
  }
  if (!release.draft) throw new Error(`published Gitea ${tag} is missing asset ${name}; refusing to mutate history`);
  if (!(await stat(path)).isFile()) throw new Error(`not a regular file: ${name}`);
  const form = new FormData();
  form.append("attachment", new Blob([bytes]), name);
  const uploaded = await request(`/releases/${release.id}/assets`, { method: "POST", body: form });
  if (uploaded.name !== name || uploaded.size !== bytes.length) throw new Error(`Gitea rejected asset: ${name}`);
  if (await hashRemote(publicAssetUrl(name)) !== digest) throw new Error(`Gitea asset checksum mismatch: ${name}`);
  release.assets = [...(release.assets ?? []), uploaded];
  process.stdout.write(`Verified Gitea asset ${name}\n`);
}
if ((release.assets?.length ?? 0) !== entries.length) throw new Error(`Gitea ${tag} contains unexpected extra assets`);

const published = release.draft
  ? await request(`/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `OpsLog ${tag.slice(1)}`, body: notes, draft: false, prerelease: false })
  })
  : release;
if (published.body !== notes || published.draft) throw new Error(`Gitea ${tag} publication verification failed`);
for (const asset of release.assets ?? []) {
  const response = await fetch(publicAssetUrl(asset.name), { method: "HEAD" });
  if (!response.ok) throw new Error(`Gitea ${asset.name} is not publicly downloadable: HTTP ${response.status}`);
}
process.stdout.write(`Published Gitea ${tag} with ${entries.length} verified assets\n`);

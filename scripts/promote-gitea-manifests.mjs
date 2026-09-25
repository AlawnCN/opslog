import { readFile } from "node:fs/promises";
import { join } from "node:path";

const [, , tag, manifestDirectory] = process.argv;
const token = process.env.GITEA_RELEASE_TOKEN;
if (!tag || !manifestDirectory || !token) throw new Error("tag, manifest directory and GITEA_RELEASE_TOKEN are required");
const version = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("invalid version");
const root = "https://git.alawn.cn/api/v1/repos/Alawn/opslog-release/contents";
const versionParts = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new Error(`invalid existing version: ${value}`);
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] };
};
const compareVersions = (left, right) => {
  const first = versionParts(left);
  const second = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (first.numbers[index] !== second.numbers[index]) return Math.sign(first.numbers[index] - second.numbers[index]);
  }
  if (first.prerelease && !second.prerelease) return -1;
  if (!first.prerelease && second.prerelease) return 1;
  const leftIds = first.prerelease?.split(".") ?? [];
  const rightIds = second.prerelease?.split(".") ?? [];
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index++) {
    if (leftIds[index] === undefined) return -1;
    if (rightIds[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIds[index]);
    const rightNumeric = /^\d+$/.test(rightIds[index]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const difference = leftNumeric
      ? Math.sign(Number(leftIds[index]) - Number(rightIds[index]))
      : Math.sign(leftIds[index].localeCompare(rightIds[index]));
    if (difference) return difference;
  }
  return 0;
};

for (const filename of ["latest.json", "reader-latest.json"]) {
  const content = await readFile(join(manifestDirectory, filename), "utf8");
  const manifest = JSON.parse(content);
  if (manifest.version !== version) throw new Error(`incorrect version in ${filename}`);
  const url = `${root}/${filename}`;
  const headers = { Authorization: `token ${token}`, "Content-Type": "application/json" };
  const current = await fetch(`${url}?ref=main`, { headers });
  let sha;
  if (current.ok) {
    const existing = await current.json();
    sha = existing.sha;
    const previous = JSON.parse(Buffer.from(existing.content, "base64").toString("utf8"));
    if (compareVersions(previous.version, version) > 0) {
      throw new Error(`refusing to downgrade ${filename} from ${previous.version} to ${version}`);
    }
    if (previous.version === version) {
      if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error(`published ${filename} already differs for ${version}`);
      continue;
    }
  } else if (current.status !== 404) {
    throw new Error(`cannot inspect ${filename}: HTTP ${current.status}`);
  }
  const response = await fetch(url, {
    method: sha ? "PUT" : "POST",
    headers,
    body: JSON.stringify({
      branch: "main",
      message: `chore: promote OpsLog ${tag} update manifest`,
      content: Buffer.from(content).toString("base64"),
      ...(sha ? { sha } : {})
    })
  });
  if (!response.ok) throw new Error(`cannot promote ${filename}: HTTP ${response.status} ${await response.text()}`);
  const publicResponse = await fetch(`https://git.alawn.cn/Alawn/opslog-release/raw/branch/main/${filename}?tag=${encodeURIComponent(tag)}`);
  if (!publicResponse.ok || await publicResponse.text() !== content) {
    throw new Error(`public Gitea update manifest verification failed: ${filename}`);
  }
  process.stdout.write(`Promoted Gitea ${filename} to ${tag}\n`);
}

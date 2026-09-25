import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [, , assetDirectory, manifestDirectory] = process.argv;
if (!assetDirectory || !manifestDirectory) {
  throw new Error("usage: node scripts/write-release-checksums.mjs <asset-dir> <manifest-dir>");
}

const names = [
  ...(await readdir(assetDirectory)).filter((name) => !name.startsWith(".")),
  "latest.json",
  "reader-latest.json"
].sort();
if (new Set(names).size !== names.length) throw new Error("duplicate release asset name");

const lines = [];
for (const name of names) {
  const path = name.endsWith(".json") ? join(manifestDirectory, name) : join(assetDirectory, name);
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  lines.push(`${hash}  ${basename(name)}`);
}
await writeFile(join(manifestDirectory, "SHA256SUMS"), `${lines.join("\n")}\n`);

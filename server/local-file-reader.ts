import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface LocalFile { relative: string; absolute: string; size: number; modified: number; identity: string }
export const fileIdentity = (value: Awaited<ReturnType<typeof stat>>) => `${value.dev}:${value.ino}:${value.birthtimeMs}`;
export const contained = (root: string, file: string) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

// Never follow links during discovery. Opening rechecks both the canonical
// location and file identity, so a replaced path cannot escape an app root.
export async function discover(directory: string, signal?: AbortSignal): Promise<LocalFile[]> {
  const root = await realpath(directory).catch(() => { throw new Error(`本地应用目录不存在或不可访问：${directory}`); });
  if (!(await stat(root)).isDirectory()) throw new Error(`本地应用路径不是目录：${directory}`);
  const queue = [root], files: LocalFile[] = [];
  let entries = 0;
  while (queue.length) {
    signal?.throwIfAborted();
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (++entries > 100_000) throw new Error("本地目录条目超过 100000，请缩小应用根目录");
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current, entry.name);
      const canonical = await realpath(absolute);
      if (!contained(root, canonical)) continue;
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        files.push({ relative: path.relative(root, absolute).split(path.sep).join("/"), absolute, size: info.size, modified: info.mtimeMs, identity: fileIdentity(info) });
      }
    }
  }
  return files.sort((a, b) => b.modified - a.modified || (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

export async function safeOpen(root: string, file: LocalFile) {
  if (!contained(await realpath(root), await realpath(file.absolute))) throw new Error("日志路径已变更，请重新查询");
  const handle = await open(file.absolute, "r");
  const info = await handle.stat();
  if (fileIdentity(info) !== file.identity || info.size < file.size) { await handle.close(); throw new Error("日志文件已轮转或截断，请重新查询首页"); }
  return handle;
}

export async function sampleRecords(root: string, file: LocalFile, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const handle = await safeOpen(root, file), buffer = Buffer.alloc(Math.min(file.size, 256 * 1024));
  let head: string[];
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const complete = file.size <= bytesRead ? bytesRead : buffer.subarray(0, bytesRead).lastIndexOf("\n");
    head = complete > 0 ? buffer.subarray(0, complete).toString("utf8").split(/\r?\n/).filter(line => line.trim()).slice(0, 6) : [];
  } finally { await handle.close(); }
  const tail: string[] = [];
  for await (const record of reverseRecords(root, file, "newline", signal)) { if (record) tail.unshift(record); if (tail.length >= 6) break; }
  return file.size <= buffer.length && head.length < 6 ? head : [...head.slice(0, 3), ...tail.slice(-3)];
}

// Read backwards in byte chunks, preserving UTF-8 and whole records across
// chunk boundaries. Snapshot size excludes later appends until a new search.
export async function* reverseRecords(root: string, file: LocalFile, recordEnd: string, signal?: AbortSignal): AsyncGenerator<string> {
  const handle = await safeOpen(root, file), separator = Buffer.from(recordEnd === "newline" ? "\n" : recordEnd);
  let position = file.size, carry = Buffer.alloc(0);
  try {
    while (position > 0) {
      signal?.throwIfAborted();
      const length = Math.min(position, 64 * 1024); position -= length;
      const chunk = Buffer.alloc(length), read = await handle.read(chunk, 0, length, position);
      const buffer = Buffer.concat([chunk.subarray(0, read.bytesRead), carry]);
      let end = buffer.length, split: number;
      while (end >= separator.length && (split = buffer.lastIndexOf(separator, end - separator.length)) >= 0) {
        const record = buffer.subarray(split + separator.length, end).toString("utf8").trim();
        if (record) yield record;
        end = split;
        if (!end) break;
      }
      carry = buffer.subarray(0, end);
      if (carry.length > 16 * 1024 * 1024) throw new Error(`单条日志超过 16 MB：${file.relative}`);
    }
    if (carry.length) yield carry.toString("utf8").trim();
  } finally { await handle.close(); }
}

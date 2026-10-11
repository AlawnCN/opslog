import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Master { scope: string; path: string; destination: string; }
const masters = new Map<string, Master>();
let directory: string | undefined;
let sequence = 0;

export const closeSshControlMasters = (scope?: string): void => {
  for (const [key, master] of masters) {
    if (scope !== undefined && master.scope !== scope) continue;
    masters.delete(key);
    const child = spawn("ssh", ["-S", master.path, "-O", "exit", master.destination], { stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  }
};

export const sshControlMasterOptions = (scope: string, identity: unknown, destination: string): string[] => {
  // Windows OpenSSH has no Unix-domain ControlMaster support. Keep its SSH
  // Config compatibility; native password connections use the cross-platform pool.
  if (process.platform === "win32") return [];
  const key = createHash("sha256").update(JSON.stringify([scope, identity])).digest("hex");
  let master = masters.get(key);
  if (!master) {
    if (masters.size >= 32) closeSshControlMasters(masters.values().next().value?.scope);
    directory ??= mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "opslog-ssh-"));
    master = { scope, path: join(directory, String(++sequence)), destination };
    masters.set(key, master);
  }
  return ["-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", `ControlPath=${master.path}`,
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
};

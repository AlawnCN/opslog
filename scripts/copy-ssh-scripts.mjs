import { cp, mkdir } from "node:fs/promises";

const destination = new URL("../dist-server/server/ssh-scripts/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("../server/ssh-scripts/", import.meta.url), destination, { recursive: true });

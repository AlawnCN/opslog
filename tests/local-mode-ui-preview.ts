// Isolated end-to-end fixture: no production config, SSH, or external AI calls.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { defaultSshLogSources } from "../shared/ssh-log-defaults";

const project = process.cwd();
const port = Number(process.env.OPSLOG_LOCAL_PREVIEW_PORT ?? 18793);
const root = await mkdtemp(path.join(os.tmpdir(), "opslog-local-ui-"));
const appDirectory = path.join(root, "应用 cte");
await mkdir(path.join(appDirectory, "filebeat", "trc"), { recursive: true });
await mkdir(path.join(appDirectory, "log"), { recursive: true });
const now = new Date(), local = new Date(now.getTime() + 8 * 3_600_000), day = local.toISOString().slice(8, 10);
await mkdir(path.join(appDirectory, "trc", day), { recursive: true });
const rows = Array.from({ length: 120 }, (_, index) => {
  const timestamp = new Date(local.getTime() - (120 - index) * 1000).toISOString().slice(0, 23).replace("T", " ");
  return `${timestamp} -> LOCAL.${index + 1}|FT${index + 1}|KE|cte.u_0_151|transflow|localService|${index + 1}|x|0123456789abcdef0123456789abcdef|{}|${index % 2 ? "SCM00000|SUCCESS" : "SCM60001|Fixture failure"}||tlr.u_0_152|`;
});
await writeFile(path.join(appDirectory, "filebeat", "trc", "txn_cte.lst"), rows.join("\n") + "\n");
await writeFile(path.join(appDirectory, "trc", day, "LOCAL.120.trc"), "INFO[10-14 12:00:00,000] -> LOCAL FIXTURE DETAIL\n{\"local\":true,\"nested\":{\"value\":1}}\n");
await writeFile(path.join(appDirectory, "log", "app.log"), `INFO[${local.toISOString().slice(5, 23).replace("T", " ")}] -> LOCAL APPLICATION FIXTURE\n`);
await writeFile(path.join(root, "opslog-envs.json"), JSON.stringify([{ name: "Local UI Fixture", sourceType: "local", timeZone: "Asia/Shanghai", sshLogTimeOffset: "+08:00", sshMonitoredApplications: [{ name: "cte", directory: appDirectory }] }]));
const aiDirectory = path.join(root, "Library", "Application Support", "OpsLog", "shared-reader-settings");
await mkdir(aiDirectory, { recursive: true });
await writeFile(path.join(aiDirectory, "ai-analysis.json"), JSON.stringify({ version: 2, activeProfileId: "local-fixture", profiles: [{ id: "local-fixture", name: "Local Fixture", provider: "lm-studio", protocol: "openai-compatible", baseUrl: `http://127.0.0.1:${port + 1}/v1`, model: "fixture", apiKey: null, systemPrompt: "fixture", temperature: 0, maxOutputTokens: 8192, maxLogCharacters: 120000, streamResponse: false, responseLanguage: "zh-CN" }] }));
os.homedir = () => root;
process.chdir(root);
const { apiRouter, errorHandler } = await import("../server/routes");
const mock = express(); mock.use(express.json({ limit: "1mb" }));
mock.post("/v1/chat/completions", (request, response) => {
  const prompt = request.body.messages.at(-1).content as string;
  if (!prompt.includes("当前为 Local 模式")) { response.status(400).json({ error: "Missing Local instructions" }); return; }
  const names = JSON.parse(/用户已配置应用：(\[[^\n]+\])/.exec(prompt)![1]) as string[];
  response.json({ choices: [{ message: { content: JSON.stringify({ applications: names.map(name => ({ name, logSources: defaultSshLogSources() })), notes: ["隔离样本回放验证"] }) } }] });
});
const mockServer = mock.listen(port + 1, "127.0.0.1");
const app = express(); app.use(express.json({ limit: "1500kb" })); app.use("/api", apiRouter); app.use(express.static(path.join(project, "dist-web"))); app.use(errorHandler);
const server = app.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, root, appDirectory })));
const stop = async () => { server.close(); mockServer.close(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);

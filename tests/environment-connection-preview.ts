// Controlled UI transitions only; real pool/authentication is covered by ssh-environment-connect.test.ts.
import express from "express";
import path from "node:path";
import { parseEnvironmentConfig, toPublicEnvironment } from "../server/environment-store.js";

const environments = parseEnvironmentConfig(JSON.stringify(["SSH Preview", "SSH Failure"].map(name => ({ name, sourceType: "ssh", sshServers: [{ name: "fixture", host: "fixture.invalid", authentication: "ssh-config" }], sshMonitoredApplications: [{ name: "cte", directory: "/fixture" }], timeZone: "Asia/Shanghai" }))));
const app = express(); app.use(express.json());
app.get("/api/environments", (_request, response) => response.json(environments.map(environment => toPublicEnvironment(environment))));
app.get("/api/runtime", (_request, response) => response.json({ mode: "standalone", canImportConfig: false }));
app.post("/api/ssh/connections/release", (_request, response) => response.json({ ok: true }));
app.post("/api/environments/time-profile", (request, response) => {
  const environment = environments.find(item => item.name === request.body.name);
  setTimeout(() => {
    if (!environment || environment.name === "SSH Failure") { response.status(502).json({ error: "SSH 连接失败（隔离样本）" }); return; }
    response.json(toPublicEnvironment(environment));
  }, 5000);
});
app.use(express.static(path.resolve("dist-web")));
const server = app.listen(18817, "127.0.0.1", () => console.log("Connection preview: http://127.0.0.1:18817"));
process.once("SIGINT", () => server.close(() => process.exit(0)));

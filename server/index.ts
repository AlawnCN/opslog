import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter, errorHandler } from "./routes.js";

const app = express();
const port = Number.parseInt(process.env.OPSLOG_PORT ?? "8787", 10);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(moduleDirectory, "../../dist-web");

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", apiRouter);
app.use(express.static(webDirectory, { index: false }));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(webDirectory, "index.html")));
app.use(errorHandler);

app.listen(port, "127.0.0.1", () => {
  console.log(`OpsLog Web 已启动：http://127.0.0.1:${port}`);
});

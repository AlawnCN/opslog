import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { EnvironmentConfig, QueryResult } from "./domain.js";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
const INSECURE_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 4,
  rejectUnauthorized: false
});

const agentFor = (url: URL, allowInsecureTls: boolean): http.Agent | https.Agent => {
  if (url.protocol === "http:") return HTTP_AGENT;
  return allowInsecureTls ? INSECURE_HTTPS_AGENT : HTTPS_AGENT;
};

const normalizeResult = (payload: unknown): QueryResult => {
  const root = payload as Record<string, unknown>;
  const raw = (root.rawResponse ?? root) as Record<string, unknown>;
  const columns = Array.isArray(raw.columns)
    ? raw.columns.map((column) => String((column as Record<string, unknown>).name ?? ""))
    : [];
  const values = Array.isArray(raw.values) ? raw.values : [];
  const rows = values.map((value) => {
    const cells = Array.isArray(value) ? value : [];
    return Object.fromEntries(columns.map((column, position) => [column, cells[position] ?? null]));
  });
  return { columns, rows };
};

export const runEsql = async (
  environment: EnvironmentConfig,
  query: string,
  timeoutMs = 120_000
): Promise<QueryResult> => {
  const base = environment.kibanaUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/internal/search/esql`);
  const body = JSON.stringify({ params: { query } });
  const authorization = Buffer.from(`${environment.username}:${environment.password}`, "utf8").toString("base64");
  const transport = url.protocol === "https:" ? https : http;
  const allowInsecureTls = environment.allowInsecureTls ?? false;

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Accept-Encoding": "gzip, deflate, br",
        "kbn-xsrf": "reporting"
      },
      timeout: timeoutMs,
      agent: agentFor(url, allowInsecureTls),
      ...(url.protocol === "https:" ? { rejectUnauthorized: !allowInsecureTls } : {})
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;

      const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
      const decoded = encoding === "gzip"
        ? response.pipe(createGunzip())
        : encoding === "deflate"
          ? response.pipe(createInflate())
          : encoding === "br"
            ? response.pipe(createBrotliDecompress())
            : response;

      decoded.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Kibana 响应超过 64 MB 安全上限"));
          return;
        }
        chunks.push(chunk);
      });
      decoded.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode !== 200) {
          reject(new Error(`Kibana 返回 HTTP ${response.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        try {
          resolve(normalizeResult(JSON.parse(text)));
        } catch (error) {
          reject(new Error("无法解析 Kibana ES|QL 响应", { cause: error }));
        }
      });
      decoded.on("error", reject);
    });

    request.on("timeout", () => request.destroy(new Error(`Kibana 查询超过 ${timeoutMs / 1000} 秒`)));
    request.on("error", reject);
    request.end(body);
  });
};

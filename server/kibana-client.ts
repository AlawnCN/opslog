import http from "node:http";
import https from "node:https";
import type { EnvironmentConfig, QueryResult } from "./domain.js";

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

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

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "kbn-xsrf": "reporting"
      },
      timeout: timeoutMs,
      ...(url.protocol === "https:" ? { rejectUnauthorized: !(environment.allowInsecureTls ?? false) } : {})
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;

      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Kibana 响应超过 64 MB 安全上限"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
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
    });

    request.on("timeout", () => request.destroy(new Error(`Kibana 查询超过 ${timeoutMs / 1000} 秒`)));
    request.on("error", reject);
    request.end(body);
  });
};

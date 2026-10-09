import assert from "node:assert/strict";
import test from "node:test";
import { classifySearchWarnings } from "../web/src/search-warnings";

test("scan limits stay quiet while real SSH failures remain errors", () => {
  const coverage = "182.188.5.151：交易列表仅扫描文件末尾片段，结果可能不完整";
  const failure = "182.188.5.138：SSH 命令执行失败：6";
  assert.deepEqual(classifySearchWarnings([coverage, failure]), { coverage: [coverage], failures: [failure] });
  assert.deepEqual(classifySearchWarnings(), { coverage: [], failures: [] });
});

test("all current scan budget messages are coverage warnings", () => {
  for (const warning of [
    "host：扫描达到预算上限，当前结果可能不完整",
    "host：声明式规则采集或输出已达到安全上限，结果可能不完整",
    "host：SSH log scan reached the 8 MiB / 64 file budget; results may be incomplete"
  ]) assert.equal(classifySearchWarnings([warning]).failures.length, 0);
  assert.equal(classifySearchWarnings(["未知执行错误"]).failures.length, 1);
});

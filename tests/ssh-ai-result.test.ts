import assert from "node:assert/strict";
import test from "node:test";
import { parseSshAiResult } from "../shared/ssh-ai-result";
import { globToFileRegex } from "../shared/ssh-file-patterns";

const proposal = {
  applications: [{ name: "cte", logSources: [{
    name: "交易汇总", role: "transactionEvent", pathMode: "regex", paths: ["^log/txntrc_.*\\.trc$"],
    delimiter: " §§ ", recordEnd: " §§ logEnd", timestampStyle: "full", ordered: false,
    fields: { timestamp: { index: 0 }, logId: { index: 1 }, message: { regex: '(转义\\\\|"JSON"|{对象})' } },
    successPattern: "00000$", stripAsyncSuffix: true
  }] }], notes: ["待确认 {字段}，内容带转义引号：\\\"value\\\""]
};
const json = JSON.stringify(proposal);

test("accepts plain JSON, fenced JSON and trailing explanations", () => {
  for (const content of [json, `${json}\n分析完成。`, `说明：\n\`\`\`json\n${json}\n\`\`\`\n请确认。`]) {
    assert.deepEqual(parseSshAiResult(content), proposal);
  }
});
test("keeps escaped quotes, regex backslashes and braces unchanged", () => {
  assert.deepEqual(parseSshAiResult(`结果：${json}\n以上为配置。`), proposal);
});
test("rejects multiple valid proposals rather than applying one arbitrarily", () => {
  assert.throws(() => parseSshAiResult(`${json}\n${json}`), /多份有效配置/);
});
test("rejects truncated, invalid and unknown configuration fields", () => {
  assert.throws(() => parseSshAiResult(json.slice(0, -10)), /完整有效/);
  assert.throws(() => parseSshAiResult(JSON.stringify({ ...proposal, command: "not allowed" })), /未通过校验/);
  assert.throws(() => parseSshAiResult("分析完成，但没有JSON"), /完整有效/);
});

test("downgrades the reported pyh async source without guessing a log ID", () => {
  const source = {
    name: "pyh异步消费明细", role: "detail", paths: ["trc/{day}/cntr.asyncc_pyh.u_0_151.trc"],
    delimiter: "", recordEnd: "newline", timestampStyle: "month-day", ordered: true,
    fields: { timestamp: { regex: "^INFO\\[(\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3})\\]" }, thread: { regex: "^INFO\\[[^\\]]+\\]\\[([^:\\]]+):" }, message: { regex: "->\\s*(.*)$" } },
    successPattern: "00000$", stripAsyncSuffix: false
  };
  const input = { applications: [...proposal.applications, { name: "pyh", logSources: [source] }], notes: [...proposal.notes] };
  for (const text of [JSON.stringify(input), `配置：\n${JSON.stringify(input)}\n请确认。`]) {
    const parsed = parseSshAiResult(text);
    assert.deepEqual(parsed.applications[0], proposal.applications[0]);
    assert.deepEqual(parsed.applications[1].logSources[0], { ...source, role: "application", pathMode:"regex", paths:source.paths.map((path)=>globToFileRegex(path)) });
    assert.match(parsed.notes.at(-1)!, /pyh.*缺少日志 ID.*不参与交易明细关联/);
    assert.equal(parsed.applications[1].logSources[0].fields.logId, undefined);
    assert.deepEqual(parseSshAiResult(JSON.stringify(parsed)), parsed, "normalization must be idempotent");
  }
  assert.equal(source.role, "detail", "the original AI response must remain unchanged");
});

test("keeps strict validation for transaction sources and invalid log-ID mappings", () => {
  for (const role of ["transaction", "transactionEvent", "detail"]) {
    const source = { ...proposal.applications[0].logSources[0], role, fields: { timestamp: { index: 0 }, ...(role === "detail" ? { logId: {} } : {}) } };
    assert.throws(() => parseSshAiResult(JSON.stringify({ applications: [{ name: "cte", logSources: [source] }], notes: [] })), /未通过校验/);
  }
});

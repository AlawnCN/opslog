import assert from "node:assert/strict";
import test from "node:test";
import { parseSshAiResult } from "../shared/ssh-ai-result";
import { globToFileRegex } from "../shared/ssh-file-patterns";
import { prepareSshAiSamples, splitSummaryFields, validateSshAiSamples } from "../shared/ssh-ai-samples";
import { defaultSshLogSources } from "../shared/ssh-log-defaults";
import { SSH_CONFIGURATION_PROMPT, SSH_FIELDS } from "../shared/ssh-log-rules";

const sampleRows = [
  '2026-10-10 06:00:02.229 -> |T.task.s_0_139KE10000014|CEN123|KE|das.s_0_138|rclchkmng|reconciliation|1056|10 06:00:01,150||{"req_bus_no":"CEN123","nested":"a|b"}|RCLP6001|NullPointerException: Cannot invoke "String.length()" because "text" is null||das.das.s_0_138|',
  '2026-09-24 06:00:20,990 -> errImportToDb_detail|DAS123|KE|das.s_0_138|rclerrmng|errImportToDb|90|24 06:00:20,880||{}|RCL00000|SUCCESS|||'
];
const samples = [{ name: "das", warnings: [], samples: [{ server: "node1", files: [{ path: "filebeat/trc/txn_das.s_0_138.lst", size: 1000, summarySelected: true, content: sampleRows.join("\n") }] }] }];
const validSampleProposal = () => ({ applications: [{ name: "das", logSources: [{ ...defaultSshLogSources()[0]!, paths: ["^filebeat/trc/txn_das\\.s_\\d+_\\d+\\.lst$"] }] }], notes: [] });

test("AI rules replay the 138 summary layout including both timestamp styles and empty trace", () => {
  assert.doesNotThrow(() => validateSshAiSamples(validSampleProposal(), samples));
  const fields = splitSummaryFields(sampleRows[0]!);
  assert.equal(fields[0], "T.task.s_0_139KE10000014");
  assert.equal(fields[8], ""); assert.equal(fields[10], "RCLP6001");
  assert.match(fields[9]!, /a\|b/);
  assert.match(fields[11]!, /String.length/);
});

test("AI prompt field whitelist follows the schema and contains an executable source-node example", () => {
  assert.ok(SSH_CONFIGURATION_PROMPT.includes(`fields 的键仅限 ${SSH_FIELDS.join(",")}。`));
  const example = SSH_CONFIGURATION_PROMPT.match(/JSON 中 sourceNode:(\{"regex":"[^\n]+?"\})/)?.[1];
  assert.ok(example);
  const mapping = JSON.parse(example) as { regex: string };
  assert.equal(new RegExp(mapping.regex).exec(sampleRows[0]!)?.[1], "das.das.s_0_138");
});

test("domestic UAT source nodes replay independently of execution nodes for both apps", () => {
  for (const [app, nodes] of [["cte", ["cte.cte.u_0_151", "tlr.tlr.u_0_152", "bui.bui.u_0_152"]], ["pyh", ["cen.u_0_152", "pyh.pyh.u_0_151"]]] as const) {
    const rows = nodes.map(node => sampleRows[0]!.replaceAll("das.s_0_138", `${app}.u_0_151`).replace(`das.${app}.u_0_151`, node));
    const collected = [{ name: app, warnings: [], samples: [{ server: "m5.uat", files: [{ path: `filebeat/trc/txn_${app}.u_0_151.lst`, size: 1000, summarySelected: true, content: rows.join("\n") }] }] }];
    const source = { ...defaultSshLogSources()[0]!, paths: [`^filebeat/trc/txn_${app}\\.u_0_\\d+\\.lst$`] };
    const result = { applications: [{ name: app, logSources: [source] }], notes: [] };
    assert.doesNotThrow(() => validateSshAiSamples(result, collected));
    source.fields.sourceNode = { index: 13 };
    assert.doesNotThrow(() => validateSshAiSamples(result, collected));
    const noFinalPipe = structuredClone(collected);
    noFinalPipe[0]!.samples[0]!.files[0]!.content = rows.map(row => row.slice(0, -1)).join("\n");
    assert.doesNotThrow(() => validateSshAiSamples(result, noFinalPipe));
    for (const index of [3, 12, 14]) {
      source.fields.sourceNode = { index };
      assert.throws(() => validateSshAiSamples(result, collected), /sourceNode.*第 13 列/);
    }
    delete source.fields.sourceNode;
    assert.throws(() => validateSshAiSamples(result, collected), /sourceNode.*第 13 列/);
    assert.throws(() => validateSshAiSamples(result, noFinalPipe), /sourceNode.*第 13 列/);
    const unknownTail = structuredClone(collected);
    unknownTail[0]!.samples[0]!.files[0]!.content = rows.map(row => row.replace(/\|[^|]+\|$/, "|unconfirmed-tail|")).join("\n");
    assert.doesNotThrow(() => validateSshAiSamples(result, unknownTail));
  }
});

test("rejects the observed incorrect AI mappings before they can be applied", () => {
  for (const corrupt of [
    (source: ReturnType<typeof defaultSshLogSources>[number]) => { delete source.fields.txnNo; },
    (source: ReturnType<typeof defaultSshLogSources>[number]) => { source.fields.messageCode = { index: 5 }; },
    (source: ReturnType<typeof defaultSshLogSources>[number]) => { source.fields.traceId = { index: 12 }; },
    (source: ReturnType<typeof defaultSshLogSources>[number]) => { source.fields.timestamp = { regex: "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3})" }; },
    (source: ReturnType<typeof defaultSshLogSources>[number]) => { source.stripAsyncSuffix = true; }
  ]) {
    const result = validSampleProposal(); corrupt(result.applications[0]!.logSources[0]!);
    assert.throws(() => validateSshAiSamples(result, samples), /实际样本回放/);
  }
  assert.throws(() => validateSshAiSamples({ applications: [], notes: [] }, samples), /未返回应用配置/);
  const mixed = validSampleProposal(); mixed.applications[0]!.logSources.push({ ...mixed.applications[0]!.logSources[0]!, role: "transactionEvent" });
  assert.throws(() => validateSshAiSamples(mixed, samples), /事件聚合混入/);
  mixed.applications[0]!.logSources[1]!.role = "detail";
  assert.throws(() => validateSshAiSamples(mixed, samples), /不应生成 detail/);
});

test("AI context budget preserves complete long summary records and each server", () => {
  const long = sampleRows[0]!.replace('"a|b"', JSON.stringify("x".repeat(5000)));
  const collected = samples.map(app => ({ ...app, samples: ["node1", "node2"].map(server => ({ server, files: [{ ...app.samples[0]!.files[0]!, content: Array(12).fill(long).join("\n") }] })) }));
  const context = prepareSshAiSamples(collected, 14000);
  assert.ok(JSON.stringify(context).length <= 14000);
  for (const server of context[0]!.samples) {
    assert.ok(server.files[0]!.content.length > 3000);
    assert.ok(server.files[0]!.content.endsWith("|das.das.s_0_138|"));
  }
  assert.doesNotThrow(() => validateSshAiSamples(validSampleProposal(), context));
  assert.throws(() => prepareSshAiSamples(collected, 100), /完整汇总记录/);
  const reduced = prepareSshAiSamples(samples, 700);
  assert.ok(reduced[0]!.samples[0]!.files[0]!.content.endsWith(sampleRows[1]!));
});

test("different summary layouts use their own mappings rather than default column positions", () => {
  const source = { ...validSampleProposal().applications[0]!.logSources[0]!, fields: {
    timestamp: { regex: "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}[.,]\\d{3})" },
    logId: { index: 2 }, txnNo: { index: 0 }, service: { index: 1 }, duration: { index: 3 }, messageCode: { index: 4 }, messageInfo: { index: 5 }
  } };
  const other = [{ ...samples[0]!, samples: [{ server: "node2", files: [{ ...samples[0]!.samples[0]!.files[0]!, content: '2026-10-10 06:00:02.229 -> FT123|query|TX2|25|SCM00000|Success|' }] }] }];
  assert.doesNotThrow(() => validateSshAiSamples({ applications: [{ name: "das", logSources: [source] }], notes: [] }, other));
});

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

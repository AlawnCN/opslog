import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import fixture from "./fixtures/local-log-records.json" with { type: "json" };
import { readLocalTransactionLog, sampleLocalLogs, searchLocalLogs } from "../server/local-log-source";
import { parseEnvironmentConfig, toPublicEnvironment } from "../server/environment-store";
import { parseEnvironmentConfigurationFile, prepareEnvironmentConfigurationsForSave, serializeEnvironmentConfigurations, validateEnvironmentConfigurations } from "../web/src/environment-configuration";
import { validateSshAiSamples } from "../shared/ssh-ai-samples";
import { defaultSshLogSources } from "../shared/ssh-log-defaults";
import { validLocalDirectory } from "../shared/local-log-paths";
import type { EnvironmentConfig, SearchInput } from "../server/domain";

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "opslog-local-"));
  const directory = join(root, "应用 cte");
  await mkdir(join(directory, "filebeat", "trc"), { recursive: true });
  await mkdir(join(directory, "trc", "14"), { recursive: true });
  await mkdir(join(directory, "log"));
  const summary = join(directory, "filebeat", "trc", "txn_cte.lst");
  await writeFile(summary, fixture.records.join("\n") + "\n");
  const environment = parseEnvironmentConfig(JSON.stringify([{ name: "Local Test", sourceType: "local", timeZone: "Asia/Shanghai", sshLogTimeOffset: "+08:00", sshMonitoredApplications: [{ name: "cte", directory }] }]))[0]!;
  const input: SearchInput = { environment: environment.name, kind: "transaction", application: "cte", startTime: fixture.start, endTime: fixture.end, page: 1, pageSize: 50 };
  return { root, directory, summary, environment, input };
};
const localTest = (name: string, run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) => test(name, async () => { const context = await setup(); try { await run(context); } finally { await rm(context.root, { recursive: true, force: true }); } });

localTest("Local parses real M5 fields, preserves full IDs and sorts newest first", async ({ environment, input }) => {
  const result = await searchLocalLogs(environment, input);
  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0]["ecp.txn.id"], "T.local-3");
  assert.equal(result.rows[0]["ecp.txn.message.info"], "Failure [BSP|batch|default|service]");
  assert.equal(result.rows[0]["ecp.txn.timestamp"], "2026-10-14T02:00:02.133Z");
  assert.equal(result.rows[2]["ecp.txn.trace"], "0123456789abcdef0123456789abcdef");
  assert.equal(result.rows[2]["ecp.txn.src.node.id"], "tlr.u_0_152");
  assert.equal(result.rows[2]["ecp.txn.no"], "FT1");
  assert.equal(result.rows[2]["ecp.txn.duration"], 8);
});

localTest("Local combines field, result, duration and time filters", async ({ environment, input }) => {
  assert.equal((await searchLocalLogs(environment, { ...input, status: "SUCCESS", service: "receive", minDurationMs: 20 })).rows[0]["ecp.txn.id"], "T.local-2");
  assert.equal((await searchLocalLogs(environment, { ...input, status: "FAIL", messageCode: "CMMP0448", txnNo: "FT1", traceId: "0123456789" })).rows.length, 1);
  assert.equal((await searchLocalLogs(environment, { ...input, startTime: "2026-10-14T10:00:01+08:00", txnId: "T.local-1" })).rows.length, 0);
});

localTest("Local only reads the selected application's configured root", async ({ root, directory, environment, input }) => {
  const other = join(root, "pyh"); await mkdir(join(other, "filebeat", "trc"), { recursive: true });
  await writeFile(join(other, "filebeat", "trc", "txn_pyh.lst"), fixture.records[0].replaceAll("T.local-1", "OTHER"));
  environment.sshMonitoredApplications!.push({ name: "pyh", directory: other });
  assert.equal((await searchLocalLogs(environment, { ...input, application: "pyh" })).rows[0]["ecp.txn.id"], "OTHER");
  assert.equal((await searchLocalLogs(environment, input)).rows.length, 3);
  await assert.rejects(searchLocalLogs(environment, { ...input, application: "missing" }), /请选择/);
  await assert.rejects(searchLocalLogs(environment, { ...input, application: undefined }), /请选择/);
  assert.ok(directory.includes("应用"));
});

localTest("Local latest selection spans all configured patterns and is mtime based", async ({ directory, summary, environment, input }) => {
  const old = join(directory, "log", "old.lst"); await writeFile(old, fixture.records[0].replace("T.local-1", "OLD"));
  await utimes(old, 1, 1);
  assert.equal((await searchLocalLogs(environment, input)).rows.length, 3);
  await utimes(summary, 1, 1); await utimes(old, 2, 2);
  assert.equal((await searchLocalLogs(environment, input)).rows[0]["ecp.txn.id"], "OLD");
});

localTest("Local pagination freezes append updates until a new search session", async ({ environment, summary, input }) => {
  await writeFile(summary, Array.from({length: 120}, (_,i) => fixture.records[0].replace("T.local-1", `ID-${String(i).padStart(3,"0")}`).replace("10:00:00,123", `10:00:${String(Math.floor(i/2)).padStart(2,"0")},123`)).join("\n")+"\n");
  const sessionId = randomUUID(), first = await searchLocalLogs(environment, { ...input, sessionId });
  assert.equal(first.rows.length, 51);
  await appendFile(summary, fixture.records[2].replace("T.local-3", "APPENDED").replace("10:00:02.133", "10:01:00.000")+"\n");
  const second = await searchLocalLogs(environment, { ...input, sessionId, page: 2 });
  assert.equal(second.rows.length, 101);
  assert.ok(second.rows.every(row => row["ecp.txn.id"] !== "APPENDED"));
  assert.equal((await searchLocalLogs(environment, { ...input, sessionId: randomUUID() })).rows[0]["ecp.txn.id"], "APPENDED");
  await assert.rejects(searchLocalLogs(environment, { ...input, sessionId, txnId: "ID" }), /条件已变更/);
  await writeFile(summary, "");
  await assert.rejects(searchLocalLogs(environment, { ...input, sessionId, page: 2 }), /轮转或截断/);
});

localTest("Local exact detail lookup never substitutes database or unrelated trace logs", async ({ directory, environment, input }) => {
  await writeFile(join(directory, "log", "database.trc"), "MsgId:T.local-1 WRONG DATA");
  await assert.rejects(readLocalTransactionLog(environment, "T.local-1", input.startTime, input.endTime, "cte"), /未找到明细日志/);
  await writeFile(join(directory, "trc", "14", "T.local-1.trc"), "CORRECT DETAIL 中文");
  assert.match(await readLocalTransactionLog(environment, "T.local-1", input.startTime, input.endTime, "cte"), /CORRECT DETAIL 中文/);
  await assert.rejects(readLocalTransactionLog(environment, "../database", input.startTime, input.endTime, "cte"), /ID 不合法/);
});

localTest("Local ordered pages finish equal-timestamp groups before selecting a page",async({environment,summary,input})=>{
  const source={...defaultSshLogSources()[0],ordered:true};environment.sshMonitoredApplications![0].logSources=[source];
  await writeFile(summary,Array.from({length:80},(_,index)=>fixture.records[0].replace("T.local-1",`TIE-${String(79-index).padStart(3,"0")}`)).join("\n")+"\n");
  const rows=(await searchLocalLogs(environment,input)).rows;
  assert.equal(rows.length,51);assert.equal(rows[0]["ecp.txn.id"],"TIE-079");assert.equal(rows.at(-1)!["ecp.txn.id"],"TIE-029");
});

localTest("Local respects custom path regex, multiline records and capture groups", async ({ directory, environment, input }) => {
  await mkdir(join(directory, "custom", "2026"), { recursive: true });
  await writeFile(join(directory, "custom", "2026", "app.log"), "2026-10-14 10:00:00.000 §§ INFO §§ first\nsecond §§ logEnd\n2026-10-14 10:00:01.000 §§ ERROR §§ final §§ logEnd");
  environment.sshMonitoredApplications![0].logSources = [{ name: "structured", role: "application", pathMode: "regex", paths: ["^custom/\\d{4}/app\\.log$"], delimiter: " §§ ", recordEnd: " §§ logEnd", timestampStyle: "full", ordered: true, fields: { timestamp: { index: 0 }, level: { index: 1 }, message: { index: 2 } }, successPattern: "00000$", stripAsyncSuffix: false }];
  const result = await searchLocalLogs(environment, { ...input, kind: "application", keyword: "first" });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].message, "first\nsecond");
  assert.equal((await searchLocalLogs(environment, {...input, kind:"generic",level:"ERROR"})).rows.length,1);
});

localTest("Local byte-chunk reader preserves long Unicode records and duplicate rows", async ({ environment, input, summary }) => {
  const record=fixture.records[0].replace("The teller information does not exist", "中文".repeat(20_000));
  await writeFile(summary, `${record}\n${record}`);
  const result=await searchLocalLogs(environment,input);
  assert.equal(result.rows.length,2);assert.equal(String(result.rows[0]["ecp.txn.message.info"]).length,40_000);
});

localTest("Local samples can replay through the same AI proposal validation", async ({ environment }) => {
  const collected=await sampleLocalLogs(environment);
  assert.equal(collected[0].samples[0].server,"Local");
  assert.ok(collected[0].samples[0].files[0].summarySelected);
  validateSshAiSamples({applications:[{name:"cte",logSources:[defaultSshLogSources()[0]]}],notes:[]},collected);
});

localTest("Local cancels scans and reports inaccessible directories", async ({ environment, input }) => {
  const controller=new AbortController();controller.abort();
  await assert.rejects(searchLocalLogs(environment,input,false,controller.signal));
  environment.sshMonitoredApplications![0].directory+="/missing";
  await assert.rejects(searchLocalLogs(environment,input),/不存在或不可访问/);
});

localTest("Local AI sampling keeps complete head/tail records and redacts quoted secrets", async ({ environment,summary }) => {
  const rows=Array.from({length:20},(_,index)=>fixture.records[0].replace("T.local-1",`SAMPLE-${index}`).replace('{"context":"a|b"}','{"password":"SENSITIVE","token":"SECRET"}'));
  await writeFile(summary,rows.join("\n")+"\n");
  const content=(await sampleLocalLogs(environment))[0].samples[0].files[0].content;
  assert.match(content,/SAMPLE-0\|/);assert.match(content,/SAMPLE-19\|/);
  assert.equal(content.split("\n").length,6);assert.doesNotMatch(content,/SENSITIVE|SECRET/);assert.match(content,/REDACTED/);
});

localTest("Local does not follow symlinks outside the configured app root", async ({ root,directory,environment,input }) => {
  if(process.platform==="win32") return;
  await mkdir(join(root,"outside"));await writeFile(join(root,"outside","secret.lst"),fixture.records[0]);
  await symlink(join(root,"outside"),join(directory,"escape"));
  environment.sshMonitoredApplications![0].logSources=[{...defaultSshLogSources()[0],paths:["^escape/.*$"]}];
  assert.equal((await searchLocalLogs(environment,input)).rows.length,0);
  await symlink(join(root,"outside","secret.lst"),join(directory,"trc","14","SECRET.trc"));
  await assert.rejects(readLocalTransactionLog(environment,"SECRET",input.startTime,input.endTime,"cte"),/超出应用目录/);
});

test("Local configuration roundtrips without SSH servers or credentials; supports native absolute paths",()=>{
  for(const directory of ["/Users/用户/my logs","C:\\logs\\cte","C:/logs/cte","\\\\server\\share\\cte"])assert.ok(validLocalDirectory(directory),directory);
  for(const directory of ["relative/logs","../logs","C:logs","/apps/../secret","/apps\u0000bad"])assert.ok(!validLocalDirectory(directory),directory);
  const raw=JSON.stringify([{name:"Local",sourceType:"local",timeZone:"Asia/Shanghai",sshLogTimeOffset:"+08:00",sshMonitoredApplications:[{name:"cte",directory:"C:\\logs\\cte"}]}]);
  const parsed=parseEnvironmentConfigurationFile(raw); assert.equal(validateEnvironmentConfigurations(parsed),undefined);
  const saved=prepareEnvironmentConfigurationsForSave(parsed);assert.deepEqual(saved[0].sshServers,[]);
  const exported=JSON.parse(serializeEnvironmentConfigurations(saved));assert.equal(exported[0].sourceType,"local");
  for(const field of ["sshServers","username","password","sshAutoDetectTimeZone","sshConnectTimeoutSeconds"])assert.equal(exported[0][field],undefined,field);
  const backend=parseEnvironmentConfig(JSON.stringify(exported));assert.equal(toPublicEnvironment(backend[0]).sshApplications[0],"cte");
  assert.throws(()=>parseEnvironmentConfig(JSON.stringify([{name:"Local",sourceType:"local"}])));
});

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultSshLogSources, newSshLogSource } from "../shared/ssh-log-defaults";
import { sshLogSourceSchema, SSH_CONFIGURATION_PROMPT } from "../shared/ssh-log-rules";

test("editable built-in templates are valid and independent for every application", () => {
  const sources=defaultSshLogSources();
  for (const source of [...sources,newSshLogSource()]) assert.ok(sshLogSourceSchema.safeParse(source).success, source.name);
  sources[0].paths[0]="log/changed.lst";
  sources[0].fields.logId={index:99};
  const fresh=defaultSshLogSources();
  assert.equal(fresh[0].paths[0],"^log/.*\\.lst$");
  assert.ok(fresh[0].paths.includes("^filebeat/trc/.*\\.lst$"));
  assert.equal(fresh[0].fileSelection,"latest");
  assert.deepEqual(fresh[0].fields.logId,{index:0});
  assert.deepEqual(fresh[0].fields.business,{index:4});
  assert.deepEqual(fresh[0].fields.service,{index:5});
  assert.deepEqual(fresh[0].fields.messageCode,{index:10});
  assert.deepEqual(fresh[0].fields.traceId,{index:8});
  assert.deepEqual(fresh[0].fields.sourceNode,{regex:"\\|([^|]*)\\|$"});
});

test("default transaction rows stay independent while event sources aggregate", {skip:process.platform==="win32"}, async()=>{
  const root=await mkdtemp(join(tmpdir(),"opslog-uat-default-"));
  try {
    await mkdir(join(root,"filebeat","trc"),{recursive:true});
    const trace="0123456789abcdef0123456789abcdef";
    const message="BCP99999:based on the key [BSP|batch_details|default|service], no relevant records";
    await writeFile(join(root,"filebeat","trc","summary.lst"),[
      `2026-10-09 12:00:00,123 -> TX-123|FT1|KE|cte.u_0_71|transaction|tellerSignIn|8|09 12:00:00,115|${trace}|{}|CMMP0448|The teller information does not exist||tlr.u_0_78|`,
      `2026-10-09 12:00:00,133 -> TX-123|FT1|KE|cte.u_0_71|transflow|dynamicCall|22|09 12:00:00,111|${trace}||SCM60001|${message}||cte.u_0_71|`
    ].join("\n")+"\n");
    const codec=await readFile(new URL("../server/ssh-scripts/json_codec.pl",import.meta.url),"utf8");
    const script=(await readFile(new URL("../server/ssh-scripts/configured_search.sh",import.meta.url),"utf8")).replace("# OPSLOG_JSON_CODEC",()=>codec);
    const path=join(root,"configured.sh"); await writeFile(path,script);
    const source=defaultSshLogSources()[0]!;
    for(const role of ["transaction","transactionEvent"] as const) {
      const args=[root,"09","2026-10-08 12:00:00.000","2026-10-09 12:01:00.000","100","transaction",JSON.stringify([{...source,role}]),"{}"].map(value=>Buffer.from(value).toString("hex"));
      const {stdout}=await promisify(execFile)("sh",[path,...args]);
      const rows=stdout.split("\n").filter(line=>line.startsWith("@OPSLOG_ROW\t")).map(line=>JSON.parse(line.slice(12)));
      assert.equal(rows.length,role==="transaction"?2:1);
      const newer=rows[0].values;
      assert.equal(newer.logId,"TX-123"); assert.equal(newer.messageCode,"SCM60001");
      assert.equal(newer.messageInfo,message); assert.equal(newer.sourceNode,"cte.u_0_71");
      assert.equal(newer.traceId,trace); assert.equal(Number(newer.duration),22);
      if(role==="transaction") assert.equal(rows[1].values.messageCode,"CMMP0448");
    }
    await mkdir(join(root,"trc","09"),{recursive:true});
    await writeFile(join(root,"trc","09","transaction_cte.trc"),"INFO[10-09 12:00:00,120] -> TX-123|transflow|dynamicCall|x|999|\n");
    const args=[root,"09","2026-10-08 12:00:00.000","2026-10-09 12:01:00.000","100","transaction",JSON.stringify(defaultSshLogSources()),"{}"].map(value=>Buffer.from(value).toString("hex"));
    const primary=await promisify(execFile)("sh",[path,...args]);
    assert.equal(primary.stdout.split("\n").filter(line=>line.startsWith("@OPSLOG_ROW\t")).length,2);
    assert.doesNotMatch(primary.stdout,/"duration":"999"/);
    await writeFile(join(root,"filebeat","trc","summary.lst"),"");
    const fallback=await promisify(execFile)("sh",[path,...args]);
    assert.equal(fallback.stdout.split("\n").filter(line=>line.startsWith("@OPSLOG_ROW\t")).length,1);
    assert.match(fallback.stdout,/"duration":"999"/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("manually edited built-in parameters execute without an AI configuration", {skip:process.platform==="win32"}, async()=>{
  const root=await mkdtemp(join(tmpdir(),"opslog-manual-rules-"));
  try {
    await mkdir(join(root,"log"));
    await writeFile(join(root,"log","txn_cte.lst"),'2026-10-04 10:00:00.000 -> |id.u_0_1|FT123|KE|node|business|service|42|x|y|{"nested":"a|b"}|SCM00000|Success|src|\n');
    const codec=await readFile(new URL("../server/ssh-scripts/json_codec.pl",import.meta.url),"utf8");
    const script=(await readFile(new URL("../server/ssh-scripts/configured_search.sh",import.meta.url),"utf8")).replace("# OPSLOG_JSON_CODEC",()=>codec);
    const source=defaultSshLogSources()[0]; source.paths=["^log/txn_cte\\.lst$"];
    const args=[root,"04","2026-10-04 09:00:00.000","2026-10-04 11:00:00.000","10","transaction",JSON.stringify([source]),JSON.stringify({txnNo:"FT123",status:"SUCCESS"})].map((value)=>Buffer.from(value).toString("hex"));
    const path=join(root,"configured.sh"); await writeFile(path,script);
    const {stdout}=await promisify(execFile)("sh",[path,...args]);
    const rows=stdout.split("\n").filter((line)=>line.startsWith("@OPSLOG_ROW\t")).map((line)=>JSON.parse(line.slice(12)));
    assert.equal(rows.length,1);
    assert.equal(rows[0].values.txnNo,"FT123"); assert.equal(rows[0].values.messageCode,"SCM00000");
    assert.equal(rows[0].values.business,"business"); assert.equal(rows[0].values.service,"service");
  } finally {await rm(root,{recursive:true,force:true});}
});

test("summary sampling and querying select the newest file across directories independently per server", {skip:process.platform==="win32"}, async()=>{
  const temporary=await mkdtemp(join(tmpdir(),"opslog-latest-summary-"));
  try {
    const codec=await readFile(new URL("../server/ssh-scripts/json_codec.pl",import.meta.url),"utf8");
    const scripts: Record<string,string>={};
    for(const name of ["sample","configured_search","transaction_list"]) {
      const path=join(temporary,`${name}.sh`);
      await writeFile(path,(await readFile(new URL(`../server/ssh-scripts/${name}.sh`,import.meta.url),"utf8")).replace("# OPSLOG_JSON_CODEC",()=>codec));
      scripts[name]=path;
    }
    const run=async(name:string,args:string[]) => (await promisify(execFile)("sh",[scripts[name]!,...args.map(value=>value?Buffer.from(value).toString("hex"):"-")])).stdout;
    for(const [node,newestDirectory] of [["s_0_138","filebeat/trc"],["u_0_151","log"]]) {
      const root=join(temporary,node!);
      await mkdir(join(root,"filebeat","trc"),{recursive:true});await mkdir(join(root,"log"));
      const row=(id:string)=>`2026-10-04 10:00:00.000 -> |${id}|FT123|KE|node|business|service|42|x|y|{}|SCM00000|Success|src|\n`;
      for(const directory of ["filebeat/trc","log"]) {
        // The latest file deliberately does not have the historical txn_ prefix.
        const file=join(root,directory,`summary_cte.${node}.lst`);
        await writeFile(file,row(directory===newestDirectory?"newest":"stale"));
        const modified=directory===newestDirectory?2000:1000;await utimes(file,modified,modified);
      }
      await writeFile(join(root,"log","app.log"),"INFO[10-04 10:00:00,000] -> app\n");
      await writeFile(join(temporary,"outside.lst"),row("outside-secret"));
      await symlink(join(temporary,"outside.lst"),join(root,"log","outside.lst"));
      const samples=(await run("sample",[root])).trim().split("\n").map(line=>JSON.parse(line));
      const summaries=samples.filter(file=>file.summarySelected);
      assert.equal(summaries.length,1);assert.equal(summaries[0].path,`${newestDirectory}/summary_cte.${node}.lst`);
      assert.equal(summaries[0].modifiedAt,2000);assert.match(summaries[0].content,/newest/);
      assert.doesNotMatch(JSON.stringify(samples),/stale|outside-secret/);assert.ok(samples.some(file=>file.path==="log/app.log"));
      const source=defaultSshLogSources()[0]!;
      for(const selection of ["latest","all",undefined] as const) {
        const args=[root,"04","2026-10-04 09:00:00.000","2026-10-04 11:00:00.000","10","transaction",JSON.stringify([{...source,fileSelection:selection}]),"{}"];
        const raw=await run("configured_search",args);
        const rows=raw.split("\n").filter(line=>line.startsWith("@OPSLOG_ROW\t")).map(line=>JSON.parse(line.slice(12)));
        assert.equal(rows.length,selection==="latest"?1:2);
        assert.ok(rows.some(row=>row.values.logId==="newest"));assert.doesNotMatch(raw,/outside-secret/);
        if(selection==="latest") assert.doesNotMatch(raw,/stale/);
      }
      const builtin=await run("transaction_list",[root,"04","2026-10-04 09:00:00.000","2026-10-04 11:00:00.000","10","","","","","","","","","ALL"]);
      assert.match(builtin,/newest/);assert.doesNotMatch(builtin,/stale|outside-secret/);
      // Deterministic tie: filebeat sorts before log, independent of enumeration order.
      await utimes(join(root,"filebeat","trc",`summary_cte.${node}.lst`),2000,2000);
      await utimes(join(root,"log",`summary_cte.${node}.lst`),2000,2000);
      const tied=(await run("sample",[root])).trim().split("\n").map(line=>JSON.parse(line));
      assert.equal(tied.find(file=>file.summarySelected).path,`filebeat/trc/summary_cte.${node}.lst`);
    }
  } finally {await rm(temporary,{recursive:true,force:true});}
});

test("selection is explicit and legacy configurations keep all-files behavior",()=>{
  const source=newSshLogSource();
  assert.equal(sshLogSourceSchema.parse(source).fileSelection,undefined);
  for(const fileSelection of ["all","latest"]) assert.ok(sshLogSourceSchema.safeParse({...source,fileSelection}).success);
  assert.equal(sshLogSourceSchema.safeParse({...source,fileSelection:"first"}).success,false);
  assert.match(SSH_CONFIGURATION_PROMPT,/summarySelected=true/);
  assert.match(SSH_CONFIGURATION_PROMPT,/不是每条正则分别取一个/);
  assert.match(SSH_CONFIGURATION_PROMPT,/字段结构不同时分开配置/);
});

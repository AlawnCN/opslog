import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultSshLogSources, newSshLogSource } from "../shared/ssh-log-defaults";
import { sshLogSourceSchema } from "../shared/ssh-log-rules";

test("editable built-in templates are valid and independent for every application", () => {
  const sources=defaultSshLogSources();
  for (const source of [...sources,newSshLogSource()]) assert.ok(sshLogSourceSchema.safeParse(source).success, source.name);
  sources[0].paths[0]="log/changed.lst";
  sources[0].fields.logId={index:99};
  const fresh=defaultSshLogSources();
  assert.equal(fresh[0].paths[0],"^log/txn_.*\\.lst$");
  assert.deepEqual(fresh[0].fields.logId,{index:0});
  assert.deepEqual(fresh[0].fields.business,{index:4});
  assert.deepEqual(fresh[0].fields.service,{index:5});
  assert.deepEqual(fresh[0].fields.messageCode,{index:10});
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

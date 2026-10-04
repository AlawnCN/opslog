import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import {globToFileRegex,generalizeFileRegex,validFileRegex} from "../shared/ssh-file-patterns";
import {newSshLogSource} from "../shared/ssh-log-defaults";
import {sshLogSourceSchema} from "../shared/ssh-log-rules";
import {parseSshAiResult} from "../shared/ssh-ai-result";

test("generalizes only recognizable node suffixes and keeps type/application boundaries",()=>{
  const regex=globToFileRegex("trc/{day}/cntr.asyncc_cte.s_0_138.trc");
  assert.ok(validFileRegex(regex));
  const matcher=new RegExp(regex.replace("{day}","04"));
  for(const suffix of ["s_0_138","u_1_151","prd_2_182.188.5.139"]) assert.ok(matcher.test(`trc/04/cntr.asyncc_cte.${suffix}.trc`));
  for(const file of ["cntr.asyncc_pyh.s_0_138.trc","cntr.asyncc_cte.s_0_138.log","cntr.asyncc_cte.s_0_138.trc.bak"]) assert.equal(matcher.test(`trc/04/${file}`),false);
  assert.equal(generalizeFileRegex("^trc/{day}/cntr\\.asyncc_cte\\.s_0_138\\.trc$"),regex);
  assert.equal(globToFileRegex("log/business_20261004.log"),"^log/business_20261004\\.log$");
});
test("validates bounded directories and preserves legacy glob configurations",()=>{
  const source=newSshLogSource();
  assert.ok(sshLogSourceSchema.safeParse({...source,pathMode:undefined,paths:["log/*.log"]}).success);
  for(const path of ["^../.*$","^log/{day}/nested/.*$","^trc/.*/.*$","^log/(?{exit})$","^log/[$"]) assert.equal(sshLogSourceSchema.safeParse({...source,paths:[path]}).success,false,path);
});
test("AI fixed filenames become general regexes without altering field extraction",()=>{
  for(const pathMode of [undefined,"glob","regex"]){
    const source={...newSshLogSource(),pathMode,paths:[pathMode==="regex"?"^log/txntrc_cte\\.u_0_151\\.trc$":"log/txntrc_cte.u_0_151.trc"]};
    const parsed=parseSshAiResult(JSON.stringify({applications:[{name:"cte",logSources:[source]}],notes:[]})).applications[0]!.logSources[0]!;
    assert.equal(parsed.pathMode,"regex"); assert.ok(new RegExp(parsed.paths[0]!).test("log/txntrc_cte.s_1_138.trc"));
    assert.deepEqual(parsed.fields,source.fields);
  }
});
test("shared remote collector matches two server suffixes, day window and legacy glob",{skip:process.platform==="win32"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"opslog-regex-"));
  try{
    const codec=await readFile(new URL("../server/ssh-scripts/json_codec.pl",import.meta.url),"utf8");
    const script=(await readFile(new URL("../server/ssh-scripts/configured_search.sh",import.meta.url),"utf8")).replace("# OPSLOG_JSON_CODEC",()=>codec);
    const scriptPath=join(root,"collector.sh");await writeFile(scriptPath,script);
    for(const node of ["s_0_138","u_1_151"]){
      const appRoot=join(root,node);await mkdir(join(appRoot,"trc","04"),{recursive:true});
      await writeFile(join(appRoot,"trc","04",`cntr.asyncc_cte.${node}.trc`),"2026-10-04 10:00:00.000 useful\n2026-10-04 12:00:00.000 outside-window\n");
      await writeFile(join(appRoot,"trc","04",`cntr.asyncc_pyh.${node}.trc`),"2026-10-04 10:00:00.000 unrelated\n");
      for(const legacy of [false,true]){
        const source={...newSshLogSource(),pathMode:legacy?undefined:"regex",paths:[legacy?`trc/{day}/cntr.asyncc_cte.${node}.trc`:globToFileRegex("trc/{day}/cntr.asyncc_cte.s_0_138.trc")]};
        const args=[appRoot,"04","2026-10-04 09:00:00.000","2026-10-04 11:00:00.000","10","application",JSON.stringify([source]),"{}"].map(value=>Buffer.from(value).toString("hex"));
        const {stdout}=await promisify(execFile)("sh",[scriptPath,...args]);
        const rows=stdout.split("\n").filter(line=>line.startsWith("@OPSLOG_ROW\t"));assert.equal(rows.length,1,stdout);assert.match(rows[0]!,/useful/);
      }
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

import { useId, useRef, useState } from "react";
import { SSH_FIELDS, sshLogSourceSchema, type SshLogSource } from "../../../shared/ssh-log-rules";
import { defaultSshLogSources, newSshLogSource, SSH_FIELD_LABELS, SSH_ROLE_LABELS } from "../../../shared/ssh-log-defaults";
import type { SshApplicationConfiguration } from "../types";
import { AppSelect } from "./AppSelect";
import { globToFileRegex, generalizeFileRegex } from "../../../shared/ssh-file-patterns";
import { useAddedConfigurationItem } from "./useAddedConfigurationItem";

interface Props {
  applications: SshApplicationConfiguration[];
  onChange: (applications: SshApplicationConfiguration[]) => void;
  disabled?: boolean;
}
const SourceParameters = ({ source, onChange, disabled }: { source: SshLogSource; onChange: (source: SshLogSource) => void; disabled: boolean }) => {
  const update = (changes: Partial<SshLogSource>) => onChange({ ...source, ...changes });
  const errorId = useId();
  const parsed = sshLogSourceSchema.safeParse(source);
  const issues = parsed.success ? [] : parsed.error.issues;
  const pathErrors = issues.filter((issue) => issue.path[0] === "paths");
  const mappingDrafts = useRef<Partial<Record<typeof SSH_FIELDS[number], { index?: number; regex?: string }>>>({});
  return <div className="ssh-source-parameters">
    {!!issues.length && <div id={errorId} className="ssh-rule-validation">{issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
    <div className="ssh-rule-grid">
      <label><span>日志源名称</span><input disabled={disabled} value={source.name} onChange={(event)=>update({name:event.target.value})}/></label>
      <label><span>用途</span><AppSelect disabled={disabled} value={source.role} ariaLabel="日志源用途" options={Object.entries(SSH_ROLE_LABELS).map(([value,label])=>({value,label}))} onChange={(role)=>update({role:role as SshLogSource["role"]})}/></label>
      {source.role === "transaction" && <label className="is-wide"><span>交易来源优先级</span><AppSelect disabled={disabled} value={source.fallbackOnly?"fallback":"primary"} ariaLabel="交易来源优先级" options={[{value:"primary",label:"主要汇总来源"},{value:"fallback",label:"仅主要汇总无记录时使用"}]} onChange={(value)=>update({fallbackOnly:value==="fallback"})}/><small>备用摘要不会覆盖主要汇总的时间、耗时和结果码；每台服务器独立判断。</small></label>}
      <label className="is-wide"><span>文件选择策略</span><AppSelect disabled={disabled} value={source.fileSelection ?? "all"} ariaLabel="文件选择策略" options={[{value:"all",label:"全部匹配文件"},{value:"latest",label:"仅最新文件（按修改时间）"}]} onChange={(value)=>update({fileSelection:value as SshLogSource["fileSelection"]})}/><small>每台服务器独立选择；“仅最新”在下方所有正则的匹配集合中选一个文件，不会因历史查询无数据而回退旧文件。跨归档查询请选“全部匹配文件”。</small></label>
      <label className="is-wide"><span>文件范围{source.pathMode === "regex" ? "正则" : "（旧版通配符）"}（每行一项）</span><textarea disabled={disabled} spellCheck={false} aria-invalid={pathErrors.length ? true : undefined} aria-describedby={pathErrors.length ? errorId : undefined} rows={2} value={source.paths.join("\n")} onChange={(event)=>update({paths:event.target.value.split("\n")})}/><small>{source.pathMode === "regex" ? <>匹配相对应用根目录的完整路径，目录名、层级和文件名均可用正则，例如 ^filebeat/trc/txn_.*\.lst$。{'{day}'} 表示日期 01～31；点号需转义，不允许绝对路径或 ..。</> : <>相对应用根目录，可自定义目录层级；旧配置保留通配符语义，转换后可编辑正则。</>}</small></label>
      <div className="is-wide"><button type="button" disabled={disabled} onClick={()=>update({pathMode:"regex",paths:source.paths.map((path)=>source.pathMode === "regex" ? generalizeFileRegex(path) : globToFileRegex(path))})}>转换为通用正则</button><small>泛化节点、实例及 IP 后缀；请核对匹配范围。</small><small>示例：<code>{'^trc/{day}/cntr\\.asyncc_cte\\.[A-Za-z][A-Za-z0-9-]*_\\d+_\\d+(?:\\.\\d+){0,3}\\.trc$'}</code></small></div>
      <label><span>字段分隔符</span><AppSelect disabled={disabled} value={source.delimiter || "none"} ariaLabel="字段分隔符" options={[{value:"none",label:"无分隔符（正则提取）"},{value:"|",label:"竖线 |"},{value:" §§ ",label:" §§ "}]} onChange={(delimiter)=>update({delimiter:delimiter === "none"?"":delimiter as SshLogSource["delimiter"]})}/></label>
      <label><span>记录结束标记</span><AppSelect disabled={disabled} value={source.recordEnd} ariaLabel="记录结束标记" options={[{value:"newline",label:"换行（单行记录）"},{value:" §§ logEnd",label:" §§ logEnd（多行记录）"}]} onChange={(recordEnd)=>update({recordEnd:recordEnd as SshLogSource["recordEnd"]})}/></label>
      <label><span>时间格式</span><AppSelect disabled={disabled} value={source.timestampStyle} ariaLabel="时间格式" options={[{value:"full",label:"年-月-日 时:分:秒.毫秒"},{value:"month-day",label:"月-日 时:分:秒,毫秒"}]} onChange={(timestampStyle)=>update({timestampStyle:timestampStyle as SshLogSource["timestampStyle"]})}/></label>
      <label><span>成功结果码正则</span><input disabled={disabled} aria-invalid={issues.some((issue)=>issue.path[0]==="successPattern") || undefined} aria-describedby={issues.some((issue)=>issue.path[0]==="successPattern") ? errorId : undefined} value={source.successPattern} onChange={(event)=>update({successPattern:event.target.value})}/></label>
      <label><span>记录时间有序</span><AppSelect disabled={disabled} value={source.ordered?"yes":"no"} ariaLabel="记录时间有序" options={[{value:"no",label:"不保证有序"},{value:"yes",label:"按时间递增（允许定位读取）"}]} onChange={(value)=>update({ordered:value==="yes"})}/></label>
      <label><span>异步日志 ID 后缀</span><AppSelect disabled={disabled} value={source.stripAsyncSuffix?"merge":"keep"} ariaLabel="异步日志 ID 后缀" options={[{value:"keep",label:"保留完整 ID"},{value:"merge",label:"合并 -数字 后缀到主交易"}]} onChange={(value)=>update({stripAsyncSuffix:value==="merge"})}/></label>
    </div>
    <div className="ssh-field-heading"><strong>字段映射</strong><small>字段位置从 0 开始；正则的第一个捕获组作为值。未映射字段留空。</small></div>
    <div className="ssh-field-list">{SSH_FIELDS.map((field)=>{
      const mapping=source.fields[field]; const mode=mapping?.regex !== undefined?"regex":mapping?.index !== undefined?"index":"none";
      if (mapping) mappingDrafts.current[field] = { ...mappingDrafts.current[field], ...mapping };
      const required=field==="timestamp" || (field==="logId" && ["transaction","transactionEvent","detail"].includes(source.role));
      const setMapping=(next: SshLogSource["fields"][typeof field])=>{const fields={...source.fields}; if(next===undefined)delete fields[field]; else fields[field]=next; update({fields});};
      return <div className="ssh-field-row" key={field}><span>{SSH_FIELD_LABELS[field]}{required && <i title="必填"> *</i>}<small>{field}</small></span>
        <AppSelect disabled={disabled} value={mode} ariaLabel={`${SSH_FIELD_LABELS[field]}提取方式`} options={[{value:"none",label:"未映射"},{value:"index",label:"字段位置"},{value:"regex",label:"正则提取"}]} onChange={(value)=>setMapping(value==="none"?undefined:value==="index"?{index:mappingDrafts.current[field]?.index ?? 0}:{regex:mappingDrafts.current[field]?.regex ?? ""})}/>
        {mode === "index"?<input disabled={disabled} type="number" min={0} max={100} aria-invalid={issues.some((issue)=>issue.path[1]===field) || undefined} aria-describedby={issues.some((issue)=>issue.path[1]===field) ? errorId : undefined} aria-label={`${SSH_FIELD_LABELS[field]}字段位置`} value={mapping?.index ?? ""} onChange={(event)=>setMapping({index:event.target.value===""?NaN:Number(event.target.value)})}/>:mode === "regex"?<input disabled={disabled} className="ssh-regex-input" aria-invalid={issues.some((issue)=>issue.path[1]===field) || undefined} aria-describedby={issues.some((issue)=>issue.path[1]===field) ? errorId : undefined} aria-label={`${SSH_FIELD_LABELS[field]}提取正则`} value={mapping?.regex ?? ""} onChange={(event)=>setMapping({regex:event.target.value})}/>:<small>不参与该字段检索</small>}
      </div>;
    })}</div>
  </div>;
};

export const SshLogRulesEditor = ({ applications, onChange, disabled = false }: Props) => {
  const { containerRef, revealAdded } = useAddedConfigurationItem();
  const [undo, setUndo] = useState<{ applications: SshApplicationConfiguration[]; message: string }>();
  const sourceKeys = useRef(new WeakMap<SshLogSource, number>());
  const sequence = useRef(0);
  const sourceKey = (source: SshLogSource): number => {
    const existing = sourceKeys.current.get(source);
    if (existing !== undefined) return existing;
    const key = ++sequence.current; sourceKeys.current.set(source, key); return key;
  };
  const templates = useRef(defaultSshLogSources());
  const update = (index: number, sources: SshLogSource[], reset = false, undoMessage?: string) => {
    setUndo(undoMessage ? { applications, message: undoMessage } : undefined);
    onChange(applications.map((app,current)=>current===index?{...app,logSources:reset?undefined:sources,...(reset?{analysisNotes:[]}: {})}:app));
  };
  return <div ref={containerRef} className="ssh-rules-editor">{undo && <div className="ssh-rule-undo" role="status">{undo.message}，尚未保存。<button type="button" disabled={disabled} onClick={() => { onChange(undo.applications); setUndo(undefined); }}>撤销</button></div>}{applications.map((app,index)=>{
    const sources=app.logSources?.length?app.logSources:templates.current;
    return <div className="ssh-app-rules" key={index}>
      <div className="ssh-app-rule-heading"><strong>{app.name || "未命名应用"}</strong><span>{app.logSources?.length?"自定义参数":"内置参数"} · {sources.length} 个日志源</span><div><button type="button" disabled={disabled || sources.length>=12} onClick={()=>{ revealAdded(`[data-source-key="${index}-${sources.length}"]`); update(index,[...sources,newSshLogSource()]); }}>＋ 添加日志源</button><button type="button" disabled={disabled} onClick={()=>update(index,templates.current,true,"已恢复默认参数")}>恢复默认</button></div></div>
      {!app.logSources?.length && <p>内置模板：读取 filebeat/trc、log 或 log 按日目录下最新 .lst。路径与字段尚未验证，请按实际日志修改或使用 AI 分析。</p>}
      {sources.map((source,sourceIndex)=><details className="ssh-source-card" data-source-key={`${index}-${sourceIndex}`} data-invalid={!sshLogSourceSchema.safeParse(source).success} key={`${index}-${sourceKey(source)}`}>
        <summary><strong>{source.name || "未命名日志源"}</strong><span>{SSH_ROLE_LABELS[source.role]}</span>{!sshLogSourceSchema.safeParse(source).success && <span className="ssh-rule-invalid-badge">参数需修正</span>}<small>{source.paths.join("，")}</small></summary>
        <SourceParameters disabled={disabled} source={source} onChange={(next)=>{sourceKeys.current.set(next,sourceKey(source));update(index,sources.map((item,current)=>current===sourceIndex?next:item));}}/>
        <div className="ssh-source-footer"><button type="button" disabled={disabled || sources.length<=1} onClick={()=>update(index,sources.filter((_,current)=>current!==sourceIndex),false,`已删除日志源“${source.name}”`)}>删除日志源</button></div>
      </details>)}
      {!!app.analysisNotes?.length && <details className="ssh-rule-notes"><summary>分析说明与待确认事项（{app.analysisNotes.length}）</summary><ul>{app.analysisNotes.map((note,n)=><li key={n}>{note}</li>)}</ul></details>}
    </div>;
  })}</div>;
};

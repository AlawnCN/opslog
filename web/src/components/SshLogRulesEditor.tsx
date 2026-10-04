import { SSH_FIELDS, type SshLogSource } from "../../../shared/ssh-log-rules";
import { defaultSshLogSources, newSshLogSource, SSH_FIELD_LABELS, SSH_ROLE_LABELS } from "../../../shared/ssh-log-defaults";
import type { SshApplicationConfiguration } from "../types";
import { AppSelect } from "./AppSelect";
import { globToFileRegex, generalizeFileRegex } from "../../../shared/ssh-file-patterns";

interface Props {
  applications: SshApplicationConfiguration[];
  onChange: (applications: SshApplicationConfiguration[]) => void;
  disabled?: boolean;
}
const SourceParameters = ({ source, onChange, disabled }: { source: SshLogSource; onChange: (source: SshLogSource) => void; disabled: boolean }) => {
  const update = (changes: Partial<SshLogSource>) => onChange({ ...source, ...changes });
  return <div className="ssh-source-parameters">
    <div className="ssh-rule-grid">
      <label><span>日志源名称</span><input disabled={disabled} value={source.name} onChange={(event)=>update({name:event.target.value})}/></label>
      <label><span>用途</span><AppSelect disabled={disabled} value={source.role} ariaLabel="日志源用途" options={Object.entries(SSH_ROLE_LABELS).map(([value,label])=>({value,label}))} onChange={(role)=>update({role:role as SshLogSource["role"]})}/></label>
      <label className="is-wide"><span>文件范围{source.pathMode === "regex" ? "正则" : "（旧版通配符）"}（每行一项）</span><textarea disabled={disabled} spellCheck={false} rows={2} value={source.paths.join("\n")} onChange={(event)=>update({paths:event.target.value.split("\n")})}/><small>{source.pathMode === "regex" ? <>相对应用根目录，以 ^log/ 或 ^trc/ 开头、$ 结尾。{'{day}'} 表示 01～31；目录固定，文件名使用正则，点号需转义。</> : <>旧配置保留通配符语义，转换后可编辑正则。</>}</small></label>
      <div className="is-wide"><button type="button" disabled={disabled} onClick={()=>update({pathMode:"regex",paths:source.paths.map((path)=>source.pathMode === "regex" ? generalizeFileRegex(path) : globToFileRegex(path))})}>转换为通用正则</button><small>泛化可识别的节点 / 实例 / IP 后缀，保留应用名和日志类型；保存前请核对匹配范围。</small><small>示例：<code>{'^trc/{day}/cntr\\.asyncc_cte\\.[A-Za-z][A-Za-z0-9-]*_\\d+_\\d+(?:\\.\\d+){0,3}\\.trc$'}</code></small></div>
      <label><span>字段分隔符</span><AppSelect disabled={disabled} value={source.delimiter || "none"} ariaLabel="字段分隔符" options={[{value:"none",label:"无分隔符（正则提取）"},{value:"|",label:"竖线 |"},{value:" §§ ",label:" §§ "}]} onChange={(delimiter)=>update({delimiter:delimiter === "none"?"":delimiter as SshLogSource["delimiter"]})}/></label>
      <label><span>记录结束标记</span><AppSelect disabled={disabled} value={source.recordEnd} ariaLabel="记录结束标记" options={[{value:"newline",label:"换行（单行记录）"},{value:" §§ logEnd",label:" §§ logEnd（多行记录）"}]} onChange={(recordEnd)=>update({recordEnd:recordEnd as SshLogSource["recordEnd"]})}/></label>
      <label><span>时间格式</span><AppSelect disabled={disabled} value={source.timestampStyle} ariaLabel="时间格式" options={[{value:"full",label:"年-月-日 时:分:秒.毫秒"},{value:"month-day",label:"月-日 时:分:秒,毫秒"}]} onChange={(timestampStyle)=>update({timestampStyle:timestampStyle as SshLogSource["timestampStyle"]})}/></label>
      <label><span>成功结果码正则</span><input disabled={disabled} value={source.successPattern} onChange={(event)=>update({successPattern:event.target.value})}/></label>
      <label><span>记录时间有序</span><AppSelect disabled={disabled} value={source.ordered?"yes":"no"} ariaLabel="记录时间有序" options={[{value:"no",label:"不保证有序"},{value:"yes",label:"按时间递增（允许定位读取）"}]} onChange={(value)=>update({ordered:value==="yes"})}/></label>
      <label><span>异步日志 ID 后缀</span><AppSelect disabled={disabled} value={source.stripAsyncSuffix?"merge":"keep"} ariaLabel="异步日志 ID 后缀" options={[{value:"keep",label:"保留完整 ID"},{value:"merge",label:"合并 -数字 后缀到主交易"}]} onChange={(value)=>update({stripAsyncSuffix:value==="merge"})}/></label>
    </div>
    <div className="ssh-field-heading"><strong>字段映射</strong><small>字段位置从 0 开始；正则的第一个捕获组作为值。未映射字段留空。</small></div>
    <div className="ssh-field-list">{SSH_FIELDS.map((field)=>{
      const mapping=source.fields[field]; const mode=mapping?.regex !== undefined?"regex":mapping?.index !== undefined?"index":"none";
      const required=field==="timestamp" || (field==="logId" && ["transaction","transactionEvent","detail"].includes(source.role));
      const setMapping=(next: SshLogSource["fields"][typeof field])=>{const fields={...source.fields}; if(next===undefined)delete fields[field]; else fields[field]=next; update({fields});};
      return <div className="ssh-field-row" key={field}><span>{SSH_FIELD_LABELS[field]}{required && <i title="必填"> *</i>}<small>{field}</small></span>
        <AppSelect disabled={disabled} value={mode} ariaLabel={`${SSH_FIELD_LABELS[field]}提取方式`} options={[{value:"none",label:"未映射"},{value:"index",label:"字段位置"},{value:"regex",label:"正则提取"}]} onChange={(value)=>setMapping(value==="none"?undefined:value==="index"?{index:0}:{regex:""})}/>
        {mode === "index"?<input disabled={disabled} type="number" min={0} max={100} aria-label={`${SSH_FIELD_LABELS[field]}字段位置`} value={mapping?.index ?? ""} onChange={(event)=>setMapping({index:event.target.value===""?NaN:Number(event.target.value)})}/>:mode === "regex"?<input disabled={disabled} className="ssh-regex-input" aria-label={`${SSH_FIELD_LABELS[field]}提取正则`} value={mapping?.regex ?? ""} onChange={(event)=>setMapping({regex:event.target.value})}/>:<small>不参与该字段检索</small>}
      </div>;
    })}</div>
  </div>;
};

export const SshLogRulesEditor = ({ applications, onChange, disabled = false }: Props) => {
  const update = (index: number, sources: SshLogSource[], reset = false) => onChange(applications.map((app,current)=>current===index?{...app,logSources:reset?undefined:sources,...(reset?{analysisNotes:[]}: {})}:app));
  return <div className="ssh-rules-editor">{applications.map((app,index)=>{
    const sources=app.logSources?.length?app.logSources:defaultSshLogSources();
    return <div className="ssh-app-rules" key={index}>
      <div className="ssh-app-rule-heading"><strong>{app.name || "未命名应用"}</strong><span>{app.logSources?.length?"自定义参数":"内置参数"} · {sources.length} 个日志源</span><div><button type="button" disabled={disabled || sources.length>=12} onClick={()=>update(index,[...sources,newSshLogSource()])}>＋ 添加日志源</button><button type="button" disabled={disabled} onClick={()=>update(index,defaultSshLogSources(),true)}>恢复默认</button></div></div>
      {!app.logSources?.length && <p>当前使用内置兼容检索。以下为可编辑的默认模板；修改并保存后使用自定义参数，请按实际日志格式校正字段映射。</p>}
      {sources.map((source,sourceIndex)=><details className="ssh-source-card" key={sourceIndex}>
        <summary><strong>{source.name || "未命名日志源"}</strong><span>{SSH_ROLE_LABELS[source.role]}</span><small>{source.paths.join("，")}</small></summary>
        <SourceParameters disabled={disabled} source={source} onChange={(next)=>update(index,sources.map((item,current)=>current===sourceIndex?next:item))}/>
        <div className="ssh-source-footer"><button type="button" disabled={disabled || sources.length<=1} onClick={()=>update(index,sources.filter((_,current)=>current!==sourceIndex))}>删除日志源</button></div>
      </details>)}
      {!!app.analysisNotes?.length && <details className="ssh-rule-notes"><summary>分析说明与待确认事项（{app.analysisNotes.length}）</summary><ul>{app.analysisNotes.map((note,n)=><li key={n}>{note}</li>)}</ul></details>}
    </div>;
  })}</div>;
};

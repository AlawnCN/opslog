import { useEffect, useRef, useState } from "react";
import type { CustomLogMarker, CustomLogMarkerRule } from "../custom-log-markers";
import { CloseIcon } from "./Icons";

interface CustomLogMarkerEditorProps {
  marker: CustomLogMarker;
  aliasOnly: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onSave: (marker: CustomLogMarker) => void;
}

const validateRule = (rule: CustomLogMarkerRule): string | undefined => {
  if (!rule.query.trim()) return "查询条件不能为空";
  if (!rule.regex) return undefined;
  try {
    new RegExp(rule.query, "u");
    return undefined;
  } catch {
    return "正则表达式格式有误";
  }
};

export const CustomLogMarkerEditor = ({ marker, aliasOnly, onCancel, onDelete, onSave }: CustomLogMarkerEditorProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(marker);
  const error = aliasOnly ? undefined : draft.rules.map(validateRule).find(Boolean);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !hostRef.current?.contains(event.target)) onCancel();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [onCancel]);

  const updateRule = (id: string, change: Partial<CustomLogMarkerRule>) => setDraft((current) => ({
    ...current,
    rules: current.rules.map((rule) => rule.id === id ? { ...rule, ...change } : rule)
  }));

  const save = () => {
    const label = draft.label.trim();
    if (!label || error) return;
    onSave({ ...draft, label, rules: draft.rules.map((rule) => ({ ...rule, label: rule.label.trim() || rule.query.trim(), query: rule.query.trim() })) });
  };

  return <div className="custom-marker-editor" ref={hostRef} role="dialog" aria-label={aliasOnly ? "修改标记别名" : "编辑自定义标记"}>
    <header><div><span>CUSTOM MARKER</span><strong>{aliasOnly ? "修改别名" : draft.kind === "combine" ? "编辑组合模板" : "编辑标记"}</strong></div><button type="button" aria-label="关闭编辑器" onClick={onCancel}><CloseIcon /></button></header>
    <label className="custom-marker-name"><span>标签名称</span><input autoFocus value={draft.label} maxLength={40} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") save(); }} /></label>
    {!aliasOnly && <div className="custom-marker-rules">
      {draft.rules.map((rule, index) => <div className="custom-marker-rule" key={rule.id}>
        <div className="custom-marker-rule-heading"><b>{String(index + 1).padStart(2, "0")}</b><input value={rule.label} maxLength={40} aria-label={`条件 ${index + 1} 别名`} onChange={(event) => updateRule(rule.id, { label: event.target.value })} /><button type="button" className={rule.regex ? "is-active" : undefined} aria-pressed={rule.regex} onClick={() => updateRule(rule.id, { regex: !rule.regex })}>.*</button></div>
        <textarea value={rule.query} rows={2} spellCheck={false} aria-label={`条件 ${index + 1} 查询内容`} onChange={(event) => updateRule(rule.id, { query: event.target.value })} />
      </div>)}
    </div>}
    {error && <p className="custom-marker-error">{error}</p>}
    <footer><button type="button" className="danger" onClick={onDelete}>删除</button><div><button type="button" onClick={onCancel}>取消</button><button type="button" className="primary" disabled={!draft.label.trim() || Boolean(error)} onClick={save}>保存</button></div></footer>
  </div>;
};

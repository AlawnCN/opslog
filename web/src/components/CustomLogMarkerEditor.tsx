import { useEffect, useRef, useState } from "react";
import type { CustomLogMarker, CustomLogMarkerRule } from "../custom-log-markers";
import { CloseIcon } from "./Icons";
import { CustomLogMarkerRuleEditor } from "./CustomLogMarkerRuleEditor";

interface CustomLogMarkerEditorProps {
  marker: CustomLogMarker;
  aliasOnly: boolean;
  creating?: boolean;
  onCancel: () => void;
  onDelete?: () => void;
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

export const CustomLogMarkerEditor = ({ marker, aliasOnly, creating = false, onCancel, onDelete, onSave }: CustomLogMarkerEditorProps) => {
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

  const save = () => {
    const label = draft.label.trim();
    if (!label || error) return;
    const rules = draft.rules.map((rule) => ({ ...rule, label: rule.label.trim() || rule.query.trim(), query: rule.query.trim() }));
    onSave({ ...draft, label, rules });
  };

  return <div className="custom-marker-editor" ref={hostRef} role="dialog" aria-label={aliasOnly ? "修改标记别名" : "编辑自定义标记"}>
    <header><div><span>{creating ? "NEW CUSTOM MARKER" : "CUSTOM MARKER"}</span><strong>{aliasOnly ? "修改名称" : creating ? "创建标记" : "编辑标记"}</strong></div><button type="button" aria-label="关闭编辑器" onClick={onCancel}><CloseIcon /></button></header>
    <label className="custom-marker-name"><span>标记名称</span><input autoFocus value={draft.label} maxLength={40} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") save(); }} /></label>
    {!aliasOnly && <CustomLogMarkerRuleEditor rules={draft.rules} onChange={(rules) => setDraft((current) => ({ ...current, rules }))} />}
    {error && <p className="custom-marker-error">{error}</p>}
    <footer>{onDelete ? <button type="button" className="danger" onClick={onDelete}>删除</button> : <span />}<div><button type="button" onClick={onCancel}>取消</button><button type="button" className="primary" disabled={!draft.label.trim() || Boolean(error)} onClick={save}>保存</button></div></footer>
  </div>;
};

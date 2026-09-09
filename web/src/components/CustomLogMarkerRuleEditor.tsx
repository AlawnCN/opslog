import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createCustomLogMarkerRule, MAX_CUSTOM_LOG_MARKERS, reorderCustomLogMarkerRules, type CustomLogMarkerRule } from "../custom-log-markers";

interface CustomLogMarkerRuleEditorProps {
  rules: CustomLogMarkerRule[];
  onChange: (rules: CustomLogMarkerRule[]) => void;
}

interface RuleDrag {
  id: string;
  startY: number;
  y: number;
  active: boolean;
  targetId?: string;
  after?: boolean;
}

export const CustomLogMarkerRuleEditor = ({ rules, onChange }: CustomLogMarkerRuleEditorProps) => {
  const rulesRef = useRef(rules);
  const onChangeRef = useRef(onChange);
  const dragRef = useRef<RuleDrag | undefined>(undefined);
  const [drag, setDrag] = useState<RuleDrag>();
  const draggingId = drag?.id;
  rulesRef.current = rules;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!draggingId) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const active = current.active || Math.abs(event.clientY - current.startY) > 4;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-custom-rule-id]");
      const targetId = target?.dataset.customRuleId !== current.id ? target?.dataset.customRuleId : undefined;
      const after = targetId && target ? event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2 : undefined;
      const next = { ...current, y: event.clientY, active, targetId, after };
      dragRef.current = next;
      setDrag(next);
    };
    const stop = () => {
      const current = dragRef.current;
      if (current?.active && current.targetId) {
        onChangeRef.current(reorderCustomLogMarkerRules(rulesRef.current, current.id, current.targetId, Boolean(current.after)));
      }
      dragRef.current = undefined;
      setDrag(undefined);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [draggingId]);

  const beginDrag = (event: ReactPointerEvent, rule: CustomLogMarkerRule) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = { id: rule.id, startY: event.clientY, y: event.clientY, active: false };
    dragRef.current = next;
    setDrag(next);
  };

  const updateRule = (id: string, change: Partial<CustomLogMarkerRule>) => onChange(
    rules.map((rule) => rule.id === id ? { ...rule, ...change } : rule)
  );

  const removeRule = (id: string) => {
    if (rules.length <= 1) return;
    onChange(rules.filter((rule) => rule.id !== id));
  };

  return <div className="custom-marker-rules">
    {rules.map((rule, index) => <div
      className={`custom-marker-rule${drag?.id === rule.id && drag.active ? " is-dragging" : ""}${drag?.targetId === rule.id ? ` is-drop-${drag.after ? "after" : "before"}` : ""}`}
      data-custom-rule-id={rule.id}
      key={rule.id}
    >
      <div className="custom-marker-rule-heading">
        <button type="button" className="custom-marker-rule-grip" aria-label={`拖动条件 ${index + 1} 调整顺序`} title="拖动调整顺序" onPointerDown={(event) => beginDrag(event, rule)}><i aria-hidden="true" /></button>
        <b>{String(index + 1).padStart(2, "0")}</b>
        <input value={rule.label} maxLength={40} aria-label={`条件 ${index + 1} 别名`} onChange={(event) => updateRule(rule.id, { label: event.target.value })} />
        <button type="button" className={`custom-marker-rule-regex${rule.regex ? " is-active" : ""}`} aria-label={`条件 ${index + 1} 使用正则表达式`} aria-pressed={rule.regex} onClick={() => updateRule(rule.id, { regex: !rule.regex })}>.*</button>
        <button type="button" className="custom-marker-rule-remove" disabled={rules.length <= 1} aria-label={`删除条件 ${index + 1}`} title="删除子标签" onClick={() => removeRule(rule.id)}>×</button>
      </div>
      <textarea value={rule.query} rows={2} spellCheck={false} aria-label={`条件 ${index + 1} 查询内容`} onChange={(event) => updateRule(rule.id, { query: event.target.value })} />
    </div>)}
    <button
      type="button"
      className="custom-marker-rule-add"
      disabled={rules.length >= MAX_CUSTOM_LOG_MARKERS}
      onClick={() => onChange([...rules, createCustomLogMarkerRule(rules.length)])}
    ><i aria-hidden="true">＋</i>增加子标签</button>
    {drag?.active && <div className="custom-marker-rule-drag-ghost" style={{ top: drag.y }}>{rules.find(({ id }) => id === drag.id)?.label || "未命名条件"}</div>}
  </div>;
};

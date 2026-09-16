import { useEffect, useMemo, useRef, useState } from "react";
import { parseJavaObjectPreview, type JavaObjectPreviewNode } from "../java-object-preview";
import { CloseIcon } from "./Icons";

interface JavaObjectPreviewDialogProps {
  source: string;
  onClose: () => void;
}

interface ObjectTreePreviewDialogProps {
  closeLabel: string;
  description: string;
  eyebrow: string;
  expandAllByDefault?: boolean;
  root: JavaObjectPreviewNode;
  rootBadge: string;
  title: string;
  onClose: () => void;
}

interface JavaObjectTreeNodeProps {
  depth: number;
  expanded: Set<string>;
  fieldName?: string;
  node: JavaObjectPreviewNode;
  path: string;
  rootBadge: string;
  toggle: (path: string) => void;
}

const nodeSummary = (node: JavaObjectPreviewNode): string => {
  if (node.kind === "scalar") return node.value ?? "";
  if (node.kind === "object") return `${node.typeName ?? "Object"} (${node.members.length} fields)`;
  return `${node.typeName} [${node.members.length}]`;
};

const expandablePaths = (node: JavaObjectPreviewNode, path = "root"): string[] => {
  if (node.kind === "scalar") return [];
  return [path, ...node.members.flatMap((member, index) => expandablePaths(member.value, `${path}.${index}`))];
};

const JavaObjectTreeNode = ({ depth, expanded, fieldName, node, path, rootBadge, toggle }: JavaObjectTreeNodeProps) => {
  const expandable = node.kind !== "scalar";
  const opened = expanded.has(path);
  return <>
    <div className={`java-object-row is-${node.kind}`} style={{ paddingLeft: `${12 + depth * 20}px` }}>
      {expandable
        ? <button type="button" className="java-object-toggle" aria-label={opened ? "折叠字段" : "展开字段"} onClick={() => toggle(path)}>{opened ? "⌄" : "›"}</button>
        : <span className="java-object-toggle-spacer" />}
      <span className={`java-object-kind is-${fieldName ? "field" : "class"}`}>{fieldName ? "f" : rootBadge}</span>
      {fieldName && <><span className="java-object-field">{fieldName}</span><span className="java-object-equals">=</span></>}
      <span className={node.kind === "scalar" ? `java-object-value is-${node.scalarKind}` : "java-object-type"}>{nodeSummary(node)}</span>
    </div>
    {expandable && opened && node.members.map((member, index) =>
      <JavaObjectTreeNode
        key={`${path}.${index}`}
        depth={depth + 1}
        expanded={expanded}
        fieldName={member.name}
        node={member.value}
        path={`${path}.${index}`}
        rootBadge={rootBadge}
        toggle={toggle}
      />)}
  </>;
};

export const ObjectTreePreviewDialog = ({ closeLabel, description, eyebrow, expandAllByDefault = false, root, rootBadge, title, onClose }: ObjectTreePreviewDialogProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  const paths = useMemo(() => expandablePaths(root), [root]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(expandAllByDefault ? paths : ["root"]));

  useEffect(() => dialogRef.current?.focus(), []);
  useEffect(() => setExpanded(new Set(expandAllByDefault ? paths : ["root"])), [expandAllByDefault, paths]);

  const toggle = (path: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  return <div className="structured-preview-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className="structured-preview-dialog java-object-preview-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span>{eyebrow}</span><strong>{title}</strong></div>
        <button type="button" aria-label={closeLabel} title="关闭" onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="structured-preview-toolbar">
        <span>{description}</span>
        <div>
          <button type="button" onClick={() => setExpanded(new Set())}>全部折叠</button>
          <button type="button" onClick={() => setExpanded(new Set(paths))}>全部展开</button>
        </div>
      </div>
      <div className="java-object-tree" role="tree">
        <JavaObjectTreeNode depth={0} expanded={expanded} node={root} path="root" rootBadge={rootBadge} toggle={toggle} />
      </div>
    </section>
  </div>;
};

export const JavaObjectPreviewDialog = ({ source, onClose }: JavaObjectPreviewDialogProps) => {
  const root = useMemo(() => parseJavaObjectPreview(source), [source]);
  return <ObjectTreePreviewDialog
    closeLabel="关闭 Java 对象预览"
    description="按字段查看对象结构与嵌套类型"
    eyebrow="OBJECT INSPECTOR"
    root={root}
    rootBadge="C"
    title="Java 对象预览"
    onClose={onClose}
  />;
};

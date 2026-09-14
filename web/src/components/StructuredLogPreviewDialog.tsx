import { useEffect, useMemo, useRef } from "react";
import { logHighlightClassName } from "../log-highlight-presentation";
import { formatStructuredLogPreview, type InspectableLogStructureKind } from "../structured-log-preview";
import type { LogHighlight } from "../transaction-log-model";
import { CloseIcon } from "./Icons";

interface StructuredLogPreviewDialogProps {
  kind: InspectableLogStructureKind;
  source: string;
  onClose: () => void;
}

const highlightedContent = (content: string, highlights: LogHighlight[]) => {
  const segments = [];
  let cursor = 0;
  highlights
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .forEach(({ from, to, kind }, index) => {
      if (from < cursor || from >= to) return;
      if (from > cursor) segments.push(<span key={`plain-${index}`}>{content.slice(cursor, from)}</span>);
      segments.push(<span key={`mark-${index}`} className={logHighlightClassName(kind)}>{content.slice(from, to)}</span>);
      cursor = to;
    });
  if (cursor < content.length) segments.push(<span key="plain-end">{content.slice(cursor)}</span>);
  return segments;
};

export const StructuredLogPreviewDialog = ({ kind, source, onClose }: StructuredLogPreviewDialogProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  const preview = useMemo(() => formatStructuredLogPreview(kind, source), [kind, source]);

  useEffect(() => dialogRef.current?.focus(), []);

  return <div className="structured-preview-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className="structured-preview-dialog" role="dialog" aria-modal="true" aria-label={`${kind.toUpperCase()} 格式化预览`} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span>STRUCTURED PREVIEW</span><strong>{kind.toUpperCase()} 格式化预览</strong></div>
        <button type="button" aria-label="关闭格式化预览" title="关闭" onClick={onClose}><CloseIcon /></button>
      </header>
      {preview.error && <div className="structured-preview-error" role="status">{preview.error}</div>}
      <pre><code>{highlightedContent(preview.content, preview.highlights)}</code></pre>
    </section>
  </div>;
};

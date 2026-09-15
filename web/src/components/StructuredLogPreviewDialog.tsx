import { useEffect, useMemo, useRef } from "react";
import { formatStructuredLogPreview, type InspectableLogStructureKind } from "../structured-log-preview";
import { CloseIcon } from "./Icons";
import { StructuredLogPreviewEditor, type StructuredLogPreviewEditorHandle } from "./StructuredLogPreviewEditor";

interface StructuredLogPreviewDialogProps {
  kind: InspectableLogStructureKind;
  source: string;
  onClose: () => void;
}

export const StructuredLogPreviewDialog = ({ kind, source, onClose }: StructuredLogPreviewDialogProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  const editorRef = useRef<StructuredLogPreviewEditorHandle>(null);
  const preview = useMemo(() => formatStructuredLogPreview(kind, source), [kind, source]);

  useEffect(() => dialogRef.current?.focus(), []);

  return <div className="structured-preview-backdrop" onMouseDown={onClose}>
    <section ref={dialogRef} className="structured-preview-dialog" role="dialog" aria-modal="true" aria-label={`${kind.toUpperCase()} 格式化预览`} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><span>STRUCTURED PREVIEW</span><strong>{kind.toUpperCase()} 格式化预览</strong></div>
        <button type="button" aria-label="关闭格式化预览" title="关闭" onClick={onClose}><CloseIcon /></button>
      </header>
      {preview.error && <div className="structured-preview-error" role="status">{preview.error}</div>}
      <div className="structured-preview-toolbar">
        <span>点击行首箭头折叠层级</span>
        <div>
          <button type="button" onClick={() => editorRef.current?.foldAll()}>全部折叠</button>
          <button type="button" onClick={() => editorRef.current?.unfoldAll()}>全部展开</button>
        </div>
      </div>
      <StructuredLogPreviewEditor ref={editorRef} preview={preview} />
    </section>
  </div>;
};

import { codeFolding, foldEffect, foldedRanges, foldGutter, foldKeymap, foldService, unfoldEffect } from "@codemirror/language";
import { EditorState, StateEffect, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { logHighlightClassName } from "../log-highlight-presentation";
import { directChildStructuredPreviewFolds, type StructuredLogPreview } from "../structured-log-preview";
import { collapseRangesOneLevel, visibleCollapsedRanges, type ExpansionRange } from "../progressive-expansion";

export interface StructuredLogPreviewEditorHandle {
  foldAll: () => void;
  unfoldAll: () => void;
  unfoldLevel: () => void;
  foldLevel: () => void;
}

interface StructuredLogPreviewEditorProps {
  preview: StructuredLogPreview;
}

const unfoldAllPreviewEffect = StateEffect.define<null>();

const unfoldedPreviewRanges = (effects: readonly StateEffect<unknown>[]): Array<{ from: number; to: number }> => effects
  .filter((effect) => effect.is(unfoldEffect))
  .map((effect) => effect.value);

const previewTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--editor-surface, #061421)", color: "var(--theme-text, #b9ccda)" },
  ".cm-scroller": { fontFamily: "var(--type-log-font,var(--font-mono))", fontSize: "var(--type-log-size,11px)", lineHeight: "1.72", overflow: "auto" },
  ".cm-content": { padding: "16px 20px 36px 6px", caretColor: "transparent" },
  ".cm-line": { padding: "0 12px 0 4px" },
  ".cm-gutters": { backgroundColor: "var(--editor-surface, #061421)", color: "var(--theme-muted, #557f96)", border: "0", paddingLeft: "10px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 5px", cursor: "pointer" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--theme-surface, #0d2b3d)", border: "1px solid var(--theme-line, #28536a)", color: "var(--theme-muted, #82a8bd)", padding: "0 6px" },
  "&.cm-focused": { outline: "none" }
}, { dark: true });

export const StructuredLogPreviewEditor = forwardRef<StructuredLogPreviewEditorHandle, StructuredLogPreviewEditorProps>(({
  preview
}, forwardedRef) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    const measure = () => viewRef.current?.requestMeasure();
    window.addEventListener("opslog-typography-change", measure);
    return () => window.removeEventListener("opslog-typography-change", measure);
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    foldLevel: () => {
      const view = viewRef.current;
      if (!view) return;
      const ranges: ExpansionRange[] = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { ranges.push({ from, to }); });
      const effects = collapseRangesOneLevel(preview.folds, ranges).map((range) => foldEffect.of(range));
      if (effects.length) view.dispatch({ effects });
    },
    foldAll: () => {
      viewRef.current?.dispatch({ effects: preview.folds.map((fold) => foldEffect.of(fold)) });
    },
    unfoldAll: () => {
      const view = viewRef.current;
      if (!view) return;
      const effects: StateEffect<unknown>[] = [unfoldAllPreviewEffect.of(null)];
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        effects.push(unfoldEffect.of({ from, to }));
      });
      view.dispatch({ effects });
    },
    unfoldLevel: () => {
      const view = viewRef.current;
      if (!view) return;
      const ranges: ExpansionRange[] = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { ranges.push({ from, to }); });
      // The existing transaction extender keeps the direct children folded.
      const effects = visibleCollapsedRanges(ranges).map((parent) => unfoldEffect.of(parent));
      if (effects.length) view.dispatch({ effects });
    }
  }), [preview.folds]);

  useEffect(() => {
    if (!hostRef.current) return;
    const foldsByLine = new Map(preview.folds.map((fold) => [fold.lineFrom, fold]));
    const decorations: Array<Range<Decoration>> = preview.highlights.map(({ from, to, kind }) =>
      Decoration.mark({ class: logHighlightClassName(kind) }).range(from, to)
    );
    const view = new EditorView({
      state: EditorState.create({
        doc: preview.content,
        extensions: [
          foldGutter({ openText: "⌄", closedText: "›" }),
          codeFolding({ placeholderText: "…" }),
          foldService.of((_state, lineFrom) => foldsByLine.get(lineFrom) ?? null),
          EditorState.transactionExtender.of((transaction) => {
            if (transaction.effects.some((effect) => effect.is(unfoldAllPreviewEffect))) return null;
            const children = unfoldedPreviewRanges(transaction.effects)
              .flatMap((parent) => directChildStructuredPreviewFolds(preview.folds, parent));
            return children.length ? { effects: children.map((fold) => foldEffect.of(fold)) } : null;
          }),
          keymap.of(foldKeymap),
          EditorView.decorations.of(Decoration.set(decorations, true)),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": `${preview.kind.toUpperCase()} 格式化预览内容`, tabindex: "0", role: "textbox", "aria-readonly": "true" }),
          previewTheme
        ]
      }),
      parent: hostRef.current
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [preview]);

  return <div className="structured-preview-editor" ref={hostRef} />;
});

import { codeFolding, foldAll, foldedRanges, foldGutter, foldKeymap, foldService, unfoldAll, unfoldEffect } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { logHighlightClassName } from "../log-highlight-presentation";
import type { LogReaderFoldMode } from "../log-reader-preferences";
import type { LogHighlight, TransactionLogAnalysis } from "../transaction-log-analysis";
import type { LogLineStyle } from "../transaction-log-model";
import { createLogFoldPlaceholder, type LogFoldPlaceholderData } from "./LogFoldPlaceholder";

export interface StructuredLogViewerHandle {
  foldAll: () => void;
  unfoldAll: () => void;
  jumpTo: (position: number) => void;
}

interface StructuredLogViewerProps {
  analysis: TransactionLogAnalysis;
  content: string;
  matches: number[];
  activeMatch: number;
  queryLength: number;
  wrapLines: boolean;
  foldMode: LogReaderFoldMode;
}

const setSemanticDecorations = StateEffect.define<DecorationSet>();
const setSearchDecorations = StateEffect.define<DecorationSet>();
const setOutlineTargetDecoration = StateEffect.define<DecorationSet>();

const semanticDecorationState = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setSemanticDecorations)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const searchDecorationState = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setSearchDecorations)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const outlineTargetDecorationState = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setOutlineTargetDecoration)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const createSemanticDecorations = (
  highlights: LogHighlight[],
  lineStyles: LogLineStyle[]
): DecorationSet => {
  const ranges: Array<Range<Decoration>> = highlights.map(({ from, to, kind }) =>
    Decoration.mark({ class: logHighlightClassName(kind) }).range(from, to)
  );
  lineStyles.forEach(({ at, tone }) => ranges.push(Decoration.line({ class: `cm-log-service-band-${tone}` }).range(at)));
  return Decoration.set(ranges, true);
};

const createSearchDecorations = (matches: number[], activeMatch: number, queryLength: number): DecorationSet => {
  const ranges: Array<Range<Decoration>> = [];
  if (queryLength > 0) matches.forEach((from, index) => {
    ranges.push(Decoration.mark({ class: index === activeMatch ? "cm-log-search-active" : "cm-log-search-hit" }).range(from, from + queryLength));
  });
  return Decoration.set(ranges, true);
};

const logTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "#061421", color: "#b9ccda" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", lineHeight: "1.72" },
  ".cm-content": { padding: "12px 0", caretColor: "#2ad4e0" },
  ".cm-line": { padding: "0 14px 0 8px" },
  ".cm-gutters": { backgroundColor: "#071827", color: "#486d84", border: "0", borderRight: "1px solid #14364b" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "44px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 6px", color: "#6793aa" },
  ".cm-activeLine": { backgroundColor: "rgba(26, 72, 98, .24)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(42, 212, 224, .24) !important" },
  ".cm-cursor": { borderLeftColor: "#2ad4e0" },
  ".cm-foldPlaceholder": { backgroundColor: "#0d2b3d", border: "1px solid #28536a", color: "#82a8bd", padding: "0 6px" },
  "&.cm-focused": { outline: "none" }
}, { dark: true });

export const StructuredLogViewer = forwardRef<StructuredLogViewerHandle, StructuredLogViewerProps>(({
  analysis, content, matches, activeMatch, queryLength, wrapLines, foldMode
}, forwardedRef) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const outlineTargetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useImperativeHandle(forwardedRef, () => ({
    foldAll: () => { if (viewRef.current) foldAll(viewRef.current); },
    unfoldAll: () => { if (viewRef.current) unfoldAll(viewRef.current); },
    jumpTo: (position: number) => {
      const view = viewRef.current;
      if (!view) return;
      const unfoldEffects: Array<StateEffect<unknown>> = [];
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        if (position >= from && position <= to) unfoldEffects.push(unfoldEffect.of({ from, to }));
      });
      const line = view.state.doc.lineAt(position);
      const target = Decoration.set([Decoration.line({ class: "cm-log-outline-target" }).range(line.from)]);
      view.dispatch({
        selection: { anchor: position },
        effects: [...unfoldEffects, setOutlineTargetDecoration.of(target), EditorView.scrollIntoView(position, { y: "center" })]
      });
      if (outlineTargetTimerRef.current) clearTimeout(outlineTargetTimerRef.current);
      outlineTargetTimerRef.current = setTimeout(() => {
        viewRef.current?.dispatch({ effects: setOutlineTargetDecoration.of(Decoration.none) });
      }, 1800);
    }
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const foldsByLine = new Map(analysis.folds.map((fold) => [fold.lineFrom, fold]));
    const foldsByRange = new Map(analysis.folds.map((fold) => [`${fold.from}:${fold.to}`, fold]));
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter({ openText: "⌄", closedText: "›" }),
      codeFolding({
        preparePlaceholder: (state, range): LogFoldPlaceholderData => ({
          ...range,
          lines: state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number + 1,
          kind: foldsByRange.get(`${range.from}:${range.to}`)?.kind
        }),
        placeholderDOM: (view, onUnfold, prepared) =>
          createLogFoldPlaceholder(view, onUnfold, prepared as LogFoldPlaceholderData)
      }),
      keymap.of(foldKeymap),
      foldService.of((_state, lineStart) => {
        const fold = foldsByLine.get(lineStart);
        return fold ? { from: fold.from, to: fold.to } : null;
      }),
      semanticDecorationState,
      searchDecorationState,
      outlineTargetDecorationState,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ "aria-label": "结构化交易日志内容" }),
      logTheme
    ];
    if (wrapLines) extensions.push(EditorView.lineWrapping);
    const view = new EditorView({ state: EditorState.create({ doc: content, extensions }), parent: hostRef.current });
    viewRef.current = view;
    view.dispatch({ effects: [
      setSemanticDecorations.of(createSemanticDecorations(analysis.highlights, analysis.lineStyles)),
      setSearchDecorations.of(createSearchDecorations(matches, activeMatch, queryLength))
    ] });
    if (foldMode === "folded") foldAll(view);
    return () => {
      if (outlineTargetTimerRef.current) clearTimeout(outlineTargetTimerRef.current);
      view.destroy();
      viewRef.current = null;
    };
  }, [analysis, content, wrapLines]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setSearchDecorations.of(createSearchDecorations(matches, activeMatch, queryLength)) });
  }, [activeMatch, matches, queryLength]);

  useEffect(() => {
    const view = viewRef.current;
    const position = matches[activeMatch];
    if (!view || position === undefined) return;
    unfoldAll(view);
    view.dispatch({ selection: { anchor: position, head: position + queryLength }, effects: EditorView.scrollIntoView(position, { y: "center" }) });
  }, [activeMatch, matches, queryLength]);

  return <div className="structured-log-viewer" ref={hostRef} />;
});

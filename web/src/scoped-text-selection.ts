import { EditorView } from "@codemirror/view";
import { isSelectAllShortcut } from "./keyboard-shortcuts";

// Capture before React/page shortcuts or WebView native select-all can escape
// the focused text control. CodeMirror selection uses document positions so
// folded and virtualized content is selected without expanding/rendering it.
export const selectFocusedText = (target: Element): boolean => {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (target instanceof HTMLInputElement && !["text", "search", "url", "tel", "email", "password", "number"].includes(target.type)) return false;
    target.ownerDocument.getSelection()?.removeAllRanges();
    target.select();
    return true;
  }
  const editor = target instanceof HTMLElement ? EditorView.findFromDOM(target) : null;
  if (editor) {
    target.ownerDocument.getSelection()?.removeAllRanges();
    editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length }, userEvent: "select" });
    editor.focus();
    return true;
  }
  const textbox = target.closest<HTMLElement>("[contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only'], [role='textbox']");
  if (!textbox) return false;
  const selection = textbox.ownerDocument.getSelection();
  if (!selection) return false;
  const range = textbox.ownerDocument.createRange();
  range.selectNodeContents(textbox);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
};

export const installScopedTextSelection = (document: Document): (() => void) => {
  const handle = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isSelectAllShortcut(event)) return;
    const target = document.activeElement instanceof Element && document.activeElement !== document.body
      ? document.activeElement : event.target;
    if (!(target instanceof Element) || !selectFocusedText(target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener("keydown", handle, true);
  return () => document.removeEventListener("keydown", handle, true);
};

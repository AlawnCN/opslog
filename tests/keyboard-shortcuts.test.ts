import assert from "node:assert/strict";
import test from "node:test";
import { EditorView } from "@codemirror/view";
import { installScopedTextSelection } from "../web/src/scoped-text-selection";
import { isEditableFocusTarget, isQueryFocusShortcut, isSelectAllShortcut } from "../web/src/keyboard-shortcuts";

const keyEvent = (change: Partial<Parameters<typeof isQueryFocusShortcut>[0]> = {}) => ({
  key: "f",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...change
});

test("macOS uses Command-F to focus the active query input", () => {
  assert.equal(isQueryFocusShortcut(keyEvent({ metaKey: true }), "MacIntel"), true);
  assert.equal(isQueryFocusShortcut(keyEvent({ ctrlKey: true }), "MacIntel"), false);
  assert.equal(isQueryFocusShortcut(keyEvent({ altKey: true }), "MacIntel"), false);
});

test("Windows uses Alt-F to focus the active query input", () => {
  assert.equal(isQueryFocusShortcut(keyEvent({ altKey: true }), "Win32"), true);
  assert.equal(isQueryFocusShortcut(keyEvent({ ctrlKey: true }), "Win32"), false);
  assert.equal(isQueryFocusShortcut(keyEvent({ metaKey: true }), "Win32"), false);
});

test("modified or composing keystrokes do not trigger query focus", () => {
  assert.equal(isQueryFocusShortcut(keyEvent({ altKey: true, shiftKey: true }), "Win32"), false);
  assert.equal(isQueryFocusShortcut(keyEvent({ metaKey: true, isComposing: true }), "MacIntel"), false);
  assert.equal(isQueryFocusShortcut(keyEvent({ key: "g", metaKey: true }), "MacIntel"), false);
});

test("Escape treats editable controls as a focus layer before a window layer", () => {
  assert.equal(isEditableFocusTarget({ tagName: "input" }), true);
  assert.equal(isEditableFocusTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableFocusTarget({ tagName: "select" }), true);
  assert.equal(isEditableFocusTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isEditableFocusTarget({ tagName: "DIV", getAttribute: (name) => name === "role" ? "searchbox" : null }), true);
  assert.equal(isEditableFocusTarget({ tagName: "BUTTON" }), false);
});

test("select-all recognizes macOS and Windows without consuming modified/composing shortcuts", () => {
  assert.equal(isSelectAllShortcut(keyEvent({ key: "a", metaKey: true })), true);
  assert.equal(isSelectAllShortcut(keyEvent({ key: "A", ctrlKey: true })), true);
  for (const change of [{}, { altKey: true, ctrlKey: true }, { shiftKey: true, metaKey: true }, { isComposing: true, metaKey: true }]) {
    assert.equal(isSelectAllShortcut(keyEvent({ key: "a", ...change })), false);
  }
});

test("select-all stays in focused inputs, readonly editors and editable regions, not the page", () => {
  const keys = ["Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"] as const;
  const saved = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  class ElementStub { closest() { return null; } }
  class InputStub extends ElementStub { type = "text"; selected = false; select() { this.selected = true; } }
  class TextareaStub extends InputStub {}
  const nativeFind = EditorView.findFromDOM;
  let editorTarget: ElementStub | undefined;
  let editorSelection: unknown;
  let focused = false;
  let cleared = 0;
  let contents: unknown;
  let handler: ((event: unknown) => void) | undefined;
  const document = {
    body: new ElementStub(), activeElement: undefined as ElementStub | undefined,
    getSelection: () => ({ removeAllRanges: () => cleared++, addRange: () => undefined }),
    createRange: () => ({ selectNodeContents: (target: unknown) => contents = target }),
    addEventListener: (_key: string, callback: (event: unknown) => void, capture: boolean) => { assert.equal(capture, true); handler = callback; },
    removeEventListener: () => { handler = undefined; }
  };
  try {
    for (const [index, value] of [ElementStub, ElementStub, InputStub, TextareaStub].entries()) Object.defineProperty(globalThis, keys[index]!, { value, configurable: true });
    EditorView.findFromDOM = ((target: unknown) => target === editorTarget ? { state: { doc: { length: 100_000 } }, dispatch: (value: unknown) => editorSelection = value, focus: () => focused = true } : null) as typeof EditorView.findFromDOM;
    const remove = installScopedTextSelection(document as unknown as Document);
    const press = (target: ElementStub, ctrlKey = false) => {
      document.activeElement = target;
      Object.assign(target, { ownerDocument: document });
      let prevented = false, stopped = false;
      handler!({ key: "a", metaKey: !ctrlKey, ctrlKey, altKey: false, shiftKey: false, target, preventDefault: () => prevented = true, stopPropagation: () => stopped = true });
      return { prevented, stopped };
    };
    const input = new InputStub();
    assert.deepEqual(press(input), { prevented: true, stopped: true });
    assert.equal(input.selected, true);
    const textarea = new TextareaStub();
    assert.equal(press(textarea, true).prevented, true);
    assert.equal(textarea.selected, true);
    editorTarget = new ElementStub();
    assert.equal(press(editorTarget).prevented, true);
    assert.deepEqual(editorSelection, { selection: { anchor: 0, head: 100_000 }, userEvent: "select" });
    assert.equal(focused, true);
    const editable = new ElementStub();
    editable.closest = () => editable as never;
    assert.equal(press(editable).prevented, true);
    assert.equal(contents, editable);
    assert.deepEqual(press(new ElementStub()), { prevented: false, stopped: false });
    assert.equal(cleared, 4);
    remove(); assert.equal(handler, undefined);
  } finally {
    EditorView.findFromDOM = nativeFind;
    keys.forEach((key, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
});

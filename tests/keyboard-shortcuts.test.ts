import assert from "node:assert/strict";
import test from "node:test";
import { isEditableFocusTarget, isQueryFocusShortcut } from "../web/src/keyboard-shortcuts";

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

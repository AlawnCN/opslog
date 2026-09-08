interface ShortcutKeyboardEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

interface FocusTarget {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const EDITABLE_ROLES = new Set(["combobox", "searchbox", "spinbutton", "textbox"]);

const currentPlatform = (): string => {
  if (typeof navigator === "undefined") return "";
  return navigator.platform || navigator.userAgent;
};

const isMacPlatform = (platform: string): boolean => /mac|iphone|ipad|ipod/i.test(platform);

export const isEditableFocusTarget = (target: FocusTarget | null | undefined): boolean => {
  if (!target) return false;
  if (target.isContentEditable || EDITABLE_TAGS.has(target.tagName?.toLocaleUpperCase() ?? "")) return true;
  return EDITABLE_ROLES.has(target.getAttribute?.("role")?.toLocaleLowerCase() ?? "");
};

export const isQueryFocusShortcut = (
  event: ShortcutKeyboardEvent,
  platform = currentPlatform()
): boolean => {
  if (event.isComposing || event.shiftKey || event.key.toLocaleLowerCase() !== "f") return false;
  if (isMacPlatform(platform)) return event.metaKey && !event.altKey && !event.ctrlKey;
  return event.altKey && !event.metaKey && !event.ctrlKey;
};

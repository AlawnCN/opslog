import type { EditorView } from "@codemirror/view";
import type { LogFoldBlock } from "../transaction-log-model";

export interface LogFoldPlaceholderData {
  from: number;
  to: number;
  lines: number;
  kind?: LogFoldBlock["kind"];
}

const KIND_LABELS: Record<LogFoldBlock["kind"], string> = {
  json: "JSON",
  xml: "XML",
  java: "Java 对象",
  stack: "异常栈",
  service: "服务区段"
};

const legacyCopy = (text: string): boolean => {
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
};

const copyText = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Desktop webviews may expose the API while denying it; use the local fallback.
    }
  }
  if (!legacyCopy(text)) throw new Error("clipboard unavailable");
};

const showCopyResult = (button: HTMLButtonElement, succeeded: boolean) => {
  const original = button.textContent ?? "复制";
  button.textContent = succeeded ? "已复制" : "复制失败";
  button.classList.toggle("is-copied", succeeded);
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove("is-copied");
  }, 1200);
};

export const createLogFoldPlaceholder = (
  view: EditorView,
  onUnfold: (event: Event) => void,
  prepared: LogFoldPlaceholderData
): HTMLElement => {
  const container = document.createElement("span");
  container.className = "cm-foldPlaceholder cm-log-fold-placeholder";

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "cm-log-fold-summary";
  summary.textContent = `… ${prepared.kind ? KIND_LABELS[prepared.kind] : "折叠内容"} · ${prepared.lines} 行`;
  summary.title = "点击展开";
  summary.onclick = onUnfold;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "cm-log-fold-copy";
  copy.textContent = "复制";
  copy.title = "复制完整折叠内容";
  copy.setAttribute("aria-label", "复制完整折叠内容");
  copy.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = view.state.doc.sliceString(prepared.from, prepared.to);
    void copyText(text).then(() => showCopyResult(copy, true), () => showCopyResult(copy, false));
  };

  container.append(summary, copy);
  return container;
};

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

const createEyeIcon = (): SVGSVGElement => {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const eye = document.createElementNS(namespace, "path");
  eye.setAttribute("d", "M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z");
  const pupil = document.createElementNS(namespace, "circle");
  pupil.setAttribute("cx", "12");
  pupil.setAttribute("cy", "12");
  pupil.setAttribute("r", "2.5");
  icon.append(eye, pupil);
  return icon;
};

export const createLogFoldPlaceholder = (
  view: EditorView,
  onUnfold: (event: Event) => void,
  prepared: LogFoldPlaceholderData,
  onInspect?: () => void
): HTMLElement => {
  const container = document.createElement("span");
  container.className = "cm-foldPlaceholder cm-log-fold-placeholder";

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "cm-log-fold-summary";
  summary.textContent = `… ${prepared.kind ? KIND_LABELS[prepared.kind] : "折叠内容"} · ${prepared.lines} 行`;
  summary.title = "点击展开";
  summary.onclick = onUnfold;

  const inspect = document.createElement("button");
  inspect.type = "button";
  inspect.className = "cm-log-fold-preview";
  inspect.title = `格式化预览 ${prepared.kind?.toUpperCase() ?? "结构块"}`;
  inspect.setAttribute("aria-label", inspect.title);
  inspect.append(createEyeIcon());
  inspect.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onInspect?.();
  };

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

  container.append(summary);
  if (onInspect) container.append(inspect);
  container.append(copy);
  return container;
};

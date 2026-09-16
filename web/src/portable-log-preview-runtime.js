(function (global) {
  "use strict";

  var activeBackdrop;

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, title) {
    var node = element("button", className, text);
    node.type = "button";
    if (title) node.title = title;
    return node;
  }

  function createEyeIcon() {
    var namespace = "http://www.w3.org/2000/svg";
    var icon = document.createElementNS(namespace, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    var eye = document.createElementNS(namespace, "path");
    eye.setAttribute("d", "M2.5 12s3.4-5 9.5-5 9.5 5 9.5 5-3.4 5-9.5 5-9.5-5-9.5-5Z");
    var pupil = document.createElementNS(namespace, "circle");
    pupil.setAttribute("cx", "12");
    pupil.setAttribute("cy", "12");
    pupil.setAttribute("r", "2.5");
    icon.append(eye, pupil);
    return icon;
  }

  function close() {
    if (activeBackdrop) activeBackdrop.remove();
    activeBackdrop = undefined;
  }

  function open(kind, source) {
    close();
    var javaPreview = global.OpsLogPortableJavaPreview;
    var structuredPreview = global.OpsLogPortableStructuredPreview;
    var objectTree = kind === "java" || kind === "sql-result";
    if (objectTree && !javaPreview) return;
    if (!objectTree && !structuredPreview) return;

    var backdrop = element("div", "portable-preview-backdrop");
    var dialog = element("section", "portable-preview-dialog" + (objectTree ? " java-object-preview-dialog" : ""));
    dialog.tabIndex = -1;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    var title = kind === "java" ? "Java 对象预览" : kind === "sql-result" ? "SQL Result 预览" : kind.toUpperCase() + " 格式化预览";
    dialog.setAttribute("aria-label", title);

    var header = element("header");
    var heading = element("div");
    heading.append(element("span", "", kind === "java" ? "OBJECT INSPECTOR" : kind === "sql-result" ? "RESULT INSPECTOR" : "STRUCTURED PREVIEW"), element("strong", "", title));
    var closeButton = button("", "×", "关闭预览");
    header.append(heading, closeButton);

    var toolbar = element("div", "portable-preview-toolbar");
    toolbar.append(element("span", "", kind === "java" ? "按字段查看对象结构与嵌套类型" : kind === "sql-result" ? "按记录与字段查看查询结果" : "点击行首箭头折叠层级"));
    var actions = element("div");
    var foldAll = button("", "全部折叠");
    var unfoldAll = button("", "全部展开");
    actions.append(foldAll, unfoldAll);
    toolbar.append(actions);

    var body = element("div", objectTree ? "java-object-tree" : "portable-preview-code");
    var controller;
    if (objectTree) controller = javaPreview.mount(body, source, kind === "sql-result" ? "R" : "C", kind === "sql-result");
    else {
      var preview = structuredPreview.format(kind, source);
      if (preview.error) dialog.append(header, element("div", "portable-preview-error", preview.error), toolbar, body);
      else dialog.append(header, toolbar, body);
      controller = structuredPreview.mount(body, preview);
    }
    if (objectTree) dialog.append(header, toolbar, body);
    foldAll.addEventListener("click", controller.foldAll);
    unfoldAll.addEventListener("click", controller.unfoldAll);
    closeButton.addEventListener("click", close);
    backdrop.addEventListener("mousedown", function (event) { if (event.target === backdrop) close(); });
    backdrop.append(dialog);
    document.body.append(backdrop);
    activeBackdrop = backdrop;
    dialog.focus();
  }

  if (typeof document !== "undefined") document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && activeBackdrop) close();
  });

  global.OpsLogPortablePreview = { close: close, createEyeIcon: createEyeIcon, open: open };
})(typeof window === "undefined" ? globalThis : window);

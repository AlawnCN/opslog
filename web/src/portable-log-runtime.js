(async function () {
  "use strict";

  var dataNode = document.getElementById("opslog-data");
  var app = document.getElementById("app");
  if (!dataNode || !app) return;

  async function decodeSnapshot(encoded, encoding) {
    var binary = atob(encoded.trim());
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (encoding === "gzip-base64") {
      if (typeof DecompressionStream === "undefined") throw new Error("This browser does not support gzip streams");
      var decompressedStream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(decompressedStream).arrayBuffer());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  var snapshot;
  try {
    await new Promise(function (resolve) { requestAnimationFrame(resolve); });
    snapshot = await decodeSnapshot(dataNode.textContent || "", dataNode.dataset.encoding || "base64");
    if (snapshot.format !== "opslog-portable-reader" || snapshot.version !== 1) throw new Error("unsupported snapshot");
  } catch (error) {
    app.innerHTML = '<div class="boot"><strong>无法读取此 OpsLog 离线快照</strong></div>';
    app.setAttribute("aria-busy", "false");
    return;
  }

  var content = snapshot.content;
  var lowercaseContent = content.toLocaleLowerCase();
  var analysis = snapshot.analysis;
  var lineStarts = [0];
  for (var newline = content.indexOf("\n"); newline >= 0; newline = content.indexOf("\n", newline + 1)) lineStarts.push(newline + 1);
  var lines = content.split("\n");
  var collapsed = new Set();
  if (snapshot.initiallyFolded) analysis.folds.forEach(function (_, index) { collapsed.add(index); });
  var matches = [];
  var activeMatch = 0;
  var searchTimer;
  var activeMarker = "";
  var semanticPriority = [
    "cm-log-sql-muted", "cm-log-timestamp", "cm-log-source", "cm-log-level-info",
    "cm-log-json-punctuation", "cm-log-xml-punctuation", "cm-log-json-string", "cm-log-json-number",
    "cm-log-json-literal", "cm-log-json-key", "cm-log-xml-string", "cm-log-xml-attribute",
    "cm-log-xml-name", "cm-log-xml-tag", "cm-log-sql-keyword", "cm-log-sql-table",
    "cm-log-service-entry", "cm-log-service-name", "cm-log-message-key", "cm-log-trace-key",
    "cm-log-trace-value", "cm-log-code-success", "cm-log-message-info", "cm-log-level-warn",
    "cm-log-code-error", "cm-log-level-error", "cm-log-exception", "cm-log-custom-match"
  ];

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

  function lineIndexAt(position) {
    var low = 0;
    var high = lineStarts.length - 1;
    while (low < high) {
      var middle = Math.ceil((low + high) / 2);
      if (lineStarts[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  function addRangesByLine(ranges, target) {
    ranges.forEach(function (range, rangeIndex) {
      var first = lineIndexAt(range.from);
      var last = lineIndexAt(Math.max(range.from, range.to - 1));
      for (var lineIndex = first; lineIndex <= last; lineIndex += 1) {
        if (!target[lineIndex]) target[lineIndex] = [];
        target[lineIndex].push({ from: range.from, to: range.to, kind: range.kind, rangeIndex: rangeIndex });
      }
    });
  }

  var highlightsByLine = [];
  addRangesByLine(analysis.highlights, highlightsByLine);
  var searchByLine = [];
  var foldByLine = new Map();
  var foldsStartingByLine = new Map();
  analysis.folds.forEach(function (fold, index) {
    var lineIndex = lineIndexAt(fold.lineFrom);
    if (!foldsStartingByLine.has(lineIndex)) foldsStartingByLine.set(lineIndex, []);
    foldsStartingByLine.get(lineIndex).push({ fold: fold, index: index });
    var current = foldByLine.get(lineIndex);
    if (!current || fold.to - fold.from > current.fold.to - current.fold.from) foldByLine.set(lineIndex, { fold: fold, index: index });
  });
  var toneByLine = new Map();
  analysis.lineStyles.forEach(function (style) { toneByLine.set(lineIndexAt(style.at), style.tone); });

  app.textContent = "";
  app.setAttribute("aria-busy", "false");
  var shell = element("div", "shell");
  var header = element("header", "header");
  var brand = element("div", "brand");
  brand.append(element("div", "brand-mark", "⌁"));
  var heading = element("div");
  heading.append(element("span", "eyebrow", "OPSLOG · PORTABLE READER"));
  heading.append(element("h1", "", "日志阅读快照"));
  heading.append(element("div", "log-id", snapshot.logId));
  brand.append(heading);
  var meta = element("div", "snapshot-meta");
  meta.append(element("b", "", "离线只读 · 无网络请求"));
  meta.append(document.createTextNode("导出于 " + new Date(snapshot.exportedAt).toLocaleString()));
  header.append(brand, meta);

  var toolbar = element("div", "toolbar");
  var searchShell = element("label", "search");
  var searchInput = element("input");
  searchInput.placeholder = "查询日志内容";
  searchInput.setAttribute("aria-label", "查询日志内容");
  searchShell.append(searchInput);
  var regexButton = button("btn regex", ".*", "正则表达式查询");
  var matchCount = element("span", "match-count", "");
  var previousButton = button("btn", "上一个", "上一个命中");
  var nextButton = button("btn", "下一个", "下一个命中");
  var wrapLabel = element("label", "toggle");
  var wrapInput = element("input");
  wrapInput.type = "checkbox";
  wrapInput.checked = snapshot.initialWrapLines;
  wrapLabel.append(wrapInput, document.createTextNode("自动换行"));
  toolbar.append(searchShell, regexButton, matchCount, previousButton, nextButton, wrapLabel);

  var summary = element("div", "summary");
  var categoryLabels = {
    service: "微服务",
    call: "调用标记",
    sql: "SQL",
    "failed-result": "失败线索",
    exception: "ERROR/异常",
    structured: "结构块"
  };
  var categories = ["service", "call", "sql", "failed-result", "exception", "structured"];
  var statKeys = { service: "services", call: "calls", sql: "sql", "failed-result": "failedResults", exception: "exceptions", structured: "structured" };
  var builtInButtons = [];
  summary.append(element("span", "marker", analysis.stats.lines.toLocaleString() + " 行"));
  categories.forEach(function (category) {
    var markerButton = button("marker" + ((category === "failed-result" || category === "exception") && analysis.stats[statKeys[category]] ? " error" : ""), "", "打开 " + categoryLabels[category] + " Outline");
    markerButton.dataset.category = category;
    markerButton.append(element("b", "", String(analysis.stats[statKeys[category]])), document.createTextNode(" " + categoryLabels[category]));
    summary.append(markerButton);
    builtInButtons.push(markerButton);
  });
  if (snapshot.customMarkers.length) {
    summary.append(element("span", "divider"), element("span", "custom-label", "自定义标记"));
    snapshot.customMarkers.forEach(function (marker) {
      var markerButton = button("marker", "", "打开自定义标记 " + marker.label);
      markerButton.dataset.customMarker = marker.id;
      markerButton.append(element("b", "", String(marker.outline.items.length)), document.createTextNode(" " + marker.label));
      summary.append(markerButton);
    });
  }
  summary.append(element("span", "readonly", "READ ONLY · 标记已固化在快照中"));
  var foldAllButton = button("marker", "全部折叠", "折叠全部结构");
  var unfoldAllButton = button("marker", "全部展开", "展开全部结构");
  summary.append(foldAllButton, unfoldAllButton);

  var viewer = element("section", "viewer" + (snapshot.initialWrapLines ? " wrap" : ""));
  var log = element("div", "log");
  viewer.append(log);
  shell.append(header, toolbar, summary, viewer);
  app.append(shell);
  var defaultLineHeight = 22;
  var viewportOverscan = 36;
  var lineHeights = new Array(lines.length).fill(defaultLineHeight);
  var visibleLineIndexes = [];
  var visiblePositionByLine = new Int32Array(lines.length);
  var visibleOffsets = [0];
  var renderedWindow = { from: -1, to: -1 };
  var renderFrame;
  var renderGeneration = 0;
  var maximumLineLength = lines.reduce(function (maximum, line) { return Math.max(maximum, line.length); }, 0);

  function syncLogWidth() {
    log.style.minWidth = wrapInput.checked ? "100%" : Math.max(100, Math.min(50000, maximumLineLength + 12)) + "ch";
  }

  function activeRangesForLine(lineIndex, from, to) {
    var ranges = (highlightsByLine[lineIndex] || []).map(function (range) {
      return { from: Math.max(from, range.from), to: Math.min(to, range.to), className: "cm-log-" + range.kind };
    }).filter(function (range) { return range.to > range.from; });
    (searchByLine[lineIndex] || []).forEach(function (range) {
      ranges.push({ from: Math.max(from, range.from), to: Math.min(to, range.to), className: range.rangeIndex === activeMatch ? "search-active" : "search-hit" });
    });
    return ranges.filter(function (range) { return range.to > range.from; });
  }

  function appendHighlighted(parent, lineIndex, from, to, extraRanges) {
    if (to <= from) return;
    var ranges = activeRangesForLine(lineIndex, from, to);
    (extraRanges || []).forEach(function (range) {
      if (range.to > from && range.from < to) ranges.push({ from: Math.max(from, range.from), to: Math.min(to, range.to), className: "cm-log-" + range.kind });
    });
    var boundaries = [from, to];
    ranges.forEach(function (range) { boundaries.push(range.from, range.to); });
    boundaries.sort(function (left, right) { return left - right; });
    boundaries = boundaries.filter(function (value, index) { return index === 0 || value !== boundaries[index - 1]; });
    for (var index = 0; index < boundaries.length - 1; index += 1) {
      var segmentFrom = boundaries[index];
      var segmentTo = boundaries[index + 1];
      var classNames = ranges.filter(function (range) { return range.from <= segmentFrom && range.to >= segmentTo; }).map(function (range) { return range.className; });
      var searchClass = classNames.includes("search-active") ? "search-active" : (classNames.includes("search-hit") ? "search-hit" : "");
      var semanticClass = semanticPriority.reduce(function (selected, className) { return classNames.includes(className) ? className : selected; }, "");
      classNames = [semanticClass, searchClass].filter(Boolean);
      var text = content.slice(segmentFrom, segmentTo);
      if (classNames.length) parent.append(element("span", Array.from(new Set(classNames)).join(" "), text));
      else parent.append(document.createTextNode(text));
    }
  }

  function rebuildVisibleOffsets() {
    visibleOffsets = new Array(visibleLineIndexes.length + 1);
    visibleOffsets[0] = 0;
    for (var index = 0; index < visibleLineIndexes.length; index += 1) {
      visibleOffsets[index + 1] = visibleOffsets[index] + lineHeights[visibleLineIndexes[index]];
    }
  }

  function rebuildVisibleLines() {
    visibleLineIndexes = [];
    visiblePositionByLine.fill(-1);
    for (var lineIndex = 0; lineIndex < lines.length;) {
      visiblePositionByLine[lineIndex] = visibleLineIndexes.length;
      visibleLineIndexes.push(lineIndex);
      var skipThrough = lineIndex;
      (foldsStartingByLine.get(lineIndex) || []).forEach(function (entry) {
        if (collapsed.has(entry.index)) skipThrough = Math.max(skipThrough, lineIndexAt(Math.max(entry.fold.from, entry.fold.to - 1)));
      });
      lineIndex = skipThrough + 1;
    }
    rebuildVisibleOffsets();
    renderedWindow = { from: -1, to: -1 };
  }

  function visibleIndexAtOffset(offset) {
    var low = 0;
    var high = Math.max(0, visibleOffsets.length - 2);
    while (low < high) {
      var middle = Math.floor((low + high) / 2);
      if (visibleOffsets[middle + 1] < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function displayedFoldForLine(lineIndex) {
    var entries = foldsStartingByLine.get(lineIndex) || [];
    var collapsedEntries = entries.filter(function (entry) { return collapsed.has(entry.index); });
    var candidates = collapsedEntries.length ? collapsedEntries : entries;
    return candidates.reduce(function (selected, entry) {
      return !selected || entry.fold.to - entry.fold.from > selected.fold.to - selected.fold.from ? entry : selected;
    }, undefined) || foldByLine.get(lineIndex);
  }

  function copyText(text, trigger) {
    var done = function () {
      var before = trigger.textContent;
      trigger.textContent = "已复制";
      setTimeout(function () { trigger.textContent = before; }, 1100);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }

  function createLogRow(lineIndex) {
    var lineStart = lineStarts[lineIndex];
    var lineEnd = lineStart + lines[lineIndex].length;
    var row = element("div", "log-line");
    row.dataset.line = String(lineIndex + 1);
    var tone = toneByLine.get(lineIndex);
    if (tone !== undefined) row.classList.add("tone-" + tone);
    var gutter = element("div", "gutter");
    var foldEntry = displayedFoldForLine(lineIndex);
    if (foldEntry) {
      var foldToggle = button("fold-toggle", collapsed.has(foldEntry.index) ? "›" : "⌄", collapsed.has(foldEntry.index) ? "展开结构" : "折叠结构");
      foldToggle.dataset.fold = String(foldEntry.index);
      gutter.append(foldToggle);
    } else gutter.append(element("span", "fold-toggle", ""));
    gutter.append(element("span", "line-no", String(lineIndex + 1)));
    var text = element("div", "line-text");
    if (foldEntry && collapsed.has(foldEntry.index)) {
      var prefixEnd = Math.max(lineStart, Math.min(lineEnd, foldEntry.fold.from));
      appendHighlighted(text, lineIndex, lineStart, prefixEnd);
      var chip = element("span", "fold-chip");
      var foldedLines = Math.max(1, lineIndexAt(Math.max(foldEntry.fold.from, foldEntry.fold.to - 1)) - lineIndex + 1);
      var open = button("", "… " + foldEntry.fold.kind.toUpperCase() + " · " + foldedLines + " 行", "展开折叠区域");
      open.dataset.fold = String(foldEntry.index);
      var copy = button("", "复制", "复制折叠区域");
      copy.addEventListener("click", function (event) {
        event.stopPropagation();
        var index = Number(event.currentTarget.parentElement.firstElementChild.dataset.fold);
        var fold = analysis.folds[index];
        copyText(content.slice(fold.from, fold.to), event.currentTarget);
      });
      chip.append(open, copy);
      text.append(chip);
    } else appendHighlighted(text, lineIndex, lineStart, lineEnd);
    row.append(gutter, text);
    return row;
  }

  function measureRenderedRows(from, topSpacer, bottomSpacer) {
    var rows = log.querySelectorAll(".log-line");
    var changed = false;
    rows.forEach(function (row, index) {
      var lineIndex = visibleLineIndexes[from + index];
      var height = Math.max(defaultLineHeight, row.getBoundingClientRect().height);
      if (Math.abs(lineHeights[lineIndex] - height) > .5) {
        lineHeights[lineIndex] = height;
        changed = true;
      }
    });
    if (!changed) return;
    var anchorDelta = viewer.scrollTop - visibleOffsets[from];
    rebuildVisibleOffsets();
    viewer.scrollTop = Math.max(0, visibleOffsets[from] + anchorDelta);
    topSpacer.style.height = visibleOffsets[from] + "px";
    bottomSpacer.style.height = Math.max(0, visibleOffsets[visibleLineIndexes.length] - visibleOffsets[renderedWindow.to]) + "px";
  }

  function renderViewport(force) {
    if (!visibleLineIndexes.length) {
      log.textContent = "";
      return;
    }
    var viewportTop = viewer.scrollTop;
    var viewportBottom = viewportTop + viewer.clientHeight;
    var from = Math.max(0, visibleIndexAtOffset(viewportTop) - viewportOverscan);
    var to = Math.min(visibleLineIndexes.length, visibleIndexAtOffset(viewportBottom) + viewportOverscan + 1);
    if (!force && renderedWindow.from === from && renderedWindow.to === to) return;
    var generation = ++renderGeneration;
    renderedWindow = { from: from, to: to };
    log.textContent = "";
    var fragment = document.createDocumentFragment();
    var topSpacer = element("div", "virtual-spacer");
    topSpacer.style.height = visibleOffsets[from] + "px";
    fragment.append(topSpacer);
    for (var visibleIndex = from; visibleIndex < to; visibleIndex += 1) fragment.append(createLogRow(visibleLineIndexes[visibleIndex]));
    var bottomSpacer = element("div", "virtual-spacer");
    bottomSpacer.style.height = Math.max(0, visibleOffsets[visibleLineIndexes.length] - visibleOffsets[to]) + "px";
    fragment.append(bottomSpacer);
    log.append(fragment);
    requestAnimationFrame(function () {
      if (generation === renderGeneration) measureRenderedRows(from, topSpacer, bottomSpacer);
    });
  }

  function scheduleViewportRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(function () {
      renderFrame = undefined;
      renderViewport(false);
    });
  }

  function toggleFold(index) {
    if (collapsed.has(index)) collapsed.delete(index);
    else collapsed.add(index);
    rebuildVisibleLines();
    renderViewport(true);
  }

  log.addEventListener("click", function (event) {
    var trigger = event.target.closest("[data-fold]");
    if (trigger) toggleFold(Number(trigger.dataset.fold));
  });

  function expandAt(position) {
    var changed = false;
    analysis.folds.forEach(function (fold, index) {
      if (position >= fold.from && position < fold.to && collapsed.delete(index)) changed = true;
    });
    return changed;
  }

  function jumpTo(position, lineNumber) {
    if (expandAt(position)) rebuildVisibleLines();
    var visibleIndex = visiblePositionByLine[lineNumber - 1];
    if (visibleIndex < 0) return;
    viewer.scrollTop = Math.max(0, visibleOffsets[visibleIndex] - viewer.clientHeight * .42);
    renderViewport(true);
    requestAnimationFrame(function () {
      var row = log.querySelector('[data-line="' + lineNumber + '"]');
      if (!row) return;
      row.classList.add("target");
      setTimeout(function () { row.classList.remove("target"); }, 1900);
    });
  }

  function findMatches() {
    var query = searchInput.value;
    matches = [];
    searchByLine = [];
    regexButton.classList.remove("invalid");
    if (query) {
      if (regexButton.classList.contains("active")) {
        try {
          var expression = new RegExp(query, "giu");
          var match;
          while ((match = expression.exec(content)) && matches.length < 5000) {
            if (match[0].length) matches.push({ from: match.index, to: match.index + match[0].length });
            else expression.lastIndex += 1;
          }
        } catch (error) {
          regexButton.classList.add("invalid");
          matchCount.textContent = "正则有误";
          renderViewport(true);
          return;
        }
      } else {
        var lowerQuery = query.toLocaleLowerCase();
        for (var from = lowercaseContent.indexOf(lowerQuery); from >= 0 && matches.length < 5000; from = lowercaseContent.indexOf(lowerQuery, from + Math.max(1, lowerQuery.length))) matches.push({ from: from, to: from + query.length });
      }
    }
    activeMatch = Math.min(activeMatch, Math.max(0, matches.length - 1));
    addRangesByLine(matches, searchByLine);
    matchCount.textContent = matches.length ? (activeMatch + 1) + " / " + (matches.length === 5000 ? "5000+" : matches.length) : (query ? "未找到" : "");
    previousButton.disabled = !matches.length;
    nextButton.disabled = !matches.length;
    renderViewport(true);
  }

  function moveMatch(direction) {
    if (!matches.length) return;
    activeMatch = (activeMatch + direction + matches.length) % matches.length;
    matchCount.textContent = (activeMatch + 1) + " / " + (matches.length === 5000 ? "5000+" : matches.length);
    jumpTo(matches[activeMatch].from, lineIndexAt(matches[activeMatch].from) + 1);
  }

  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(findMatches, 120);
  });
  searchInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
  });
  regexButton.addEventListener("click", function () { regexButton.classList.toggle("active"); activeMatch = 0; findMatches(); });
  previousButton.addEventListener("click", function () { moveMatch(-1); });
  nextButton.addEventListener("click", function () { moveMatch(1); });
  wrapInput.addEventListener("change", function () {
    viewer.classList.toggle("wrap", wrapInput.checked);
    syncLogWidth();
    lineHeights.fill(defaultLineHeight);
    rebuildVisibleOffsets();
    renderViewport(true);
  });
  foldAllButton.addEventListener("click", function () {
    analysis.folds.forEach(function (_, index) { collapsed.add(index); });
    rebuildVisibleLines();
    renderViewport(true);
  });
  unfoldAllButton.addEventListener("click", function () {
    collapsed.clear();
    rebuildVisibleLines();
    renderViewport(true);
  });
  viewer.addEventListener("scroll", scheduleViewportRender, { passive: true });
  window.addEventListener("resize", function () {
    if (wrapInput.checked) lineHeights.fill(defaultLineHeight);
    rebuildVisibleOffsets();
    renderViewport(true);
  });

  var outline;
  function closeOutline() {
    if (outline) outline.remove();
    outline = undefined;
    activeMarker = "";
    summary.querySelectorAll(".marker.active").forEach(function (node) { node.classList.remove("active"); });
  }

  function openOutline(title, eyebrow, items, trigger, extraHighlights) {
    if (activeMarker === trigger) { closeOutline(); return; }
    closeOutline();
    activeMarker = trigger;
    var sourceButton = summary.querySelector('[data-category="' + trigger + '"], [data-custom-marker="' + trigger + '"]');
    if (sourceButton) sourceButton.classList.add("active");
    outline = element("aside", "outline");
    var outlineHead = element("div", "outline-head");
    var outlineHeading = element("div");
    outlineHeading.append(element("span", "eyebrow", eyebrow), element("h2", "", title + " · " + items.length + " 个定位点"));
    var close = button("", "×", "关闭 Outline");
    outlineHead.append(outlineHeading, close);
    var list = element("div", "outline-list");
    var extraHighlightsByLine = [];
    addRangesByLine(extraHighlights || [], extraHighlightsByLine);
    if (!items.length) list.append(element("div", "outline-empty", "当前日志没有匹配内容"));
    items.forEach(function (item) {
      var row = button("outline-item", "");
      var preview = element("span", "outline-preview");
      appendHighlighted(preview, item.line - 1, item.from, item.to, extraHighlightsByLine[item.line - 1]);
      row.append(element("span", "outline-line", "L" + item.line), preview);
      if (item.detail) row.append(element("span", "outline-detail", item.detail));
      row.addEventListener("click", function () { jumpTo(item.from, item.line); closeOutline(); });
      list.append(row);
    });
    var foot = element("div", "outline-foot");
    var outlineWrapLabel = element("label");
    var outlineWrap = element("input");
    outlineWrap.type = "checkbox";
    outlineWrap.checked = snapshot.initialOutlineWrapLines;
    outline.classList.toggle("wrap-preview", outlineWrap.checked);
    outlineWrapLabel.append(outlineWrap, document.createTextNode("自动换行"));
    outlineWrap.addEventListener("change", function () { outline.classList.toggle("wrap-preview", outlineWrap.checked); });
    foot.append(outlineWrapLabel, document.createTextNode("拖动标题移动 · 拖动右下角缩放 · 点击条目定位"));
    outline.append(outlineHead, list, foot);
    shell.append(outline);
    var viewerBounds = viewer.getBoundingClientRect();
    outline.style.top = Math.max(viewerBounds.top + 8, outline.offsetTop) + "px";
    close.addEventListener("click", closeOutline);
    makeDraggable(outline, outlineHead);
  }

  builtInButtons.forEach(function (markerButton) {
    markerButton.addEventListener("click", function () {
      var category = markerButton.dataset.category;
      openOutline(categoryLabels[category], "LOG OUTLINE", analysis.outline[category], category);
    });
  });
  snapshot.customMarkers.forEach(function (marker) {
    var markerButton = summary.querySelector('[data-custom-marker="' + marker.id + '"]');
    markerButton.addEventListener("click", function () { openOutline(marker.label, "CUSTOM MARKER · READ ONLY", marker.outline.items, marker.id, marker.outline.highlights); });
  });

  function makeDraggable(panel, handle) {
    var start;
    handle.addEventListener("pointerdown", function (event) {
      if (event.target.closest("button")) return;
      start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", function (event) {
      if (!start) return;
      var left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, start.left + event.clientX - start.x));
      var top = Math.max(viewer.getBoundingClientRect().top + 8, Math.min(window.innerHeight - 100, start.top + event.clientY - start.y));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
    });
    handle.addEventListener("pointerup", function () { start = undefined; });
  }

  document.addEventListener("pointerdown", function (event) {
    if (outline && !outline.contains(event.target) && !event.target.closest(".marker")) closeOutline();
  });
  document.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") { event.preventDefault(); searchInput.focus(); searchInput.select(); }
    if (event.key === "Escape" && outline) closeOutline();
  });

  previousButton.disabled = true;
  nextButton.disabled = true;
  syncLogWidth();
  rebuildVisibleLines();
  renderViewport(true);
})();

(function (global) {
  "use strict";

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function xmlTagEnd(source, start) {
    if (source.startsWith("<!--", start)) {
      var commentEnd = source.indexOf("-->", start + 4);
      return commentEnd < 0 ? source.length : commentEnd + 3;
    }
    if (source.startsWith("<![CDATA[", start)) {
      var cdataEnd = source.indexOf("]]>", start + 9);
      return cdataEnd < 0 ? source.length : cdataEnd + 3;
    }
    if (source.startsWith("<?", start)) {
      var instructionEnd = source.indexOf("?>", start + 2);
      return instructionEnd < 0 ? source.length : instructionEnd + 2;
    }
    var quote = "";
    for (var index = start + 1; index < source.length; index += 1) {
      var character = source[index];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") quote = character;
      else if (character === ">") return index + 1;
    }
    return source.length;
  }

  function openingTagName(source) {
    var match = /^<\s*([A-Za-z_][\w:.-]*)/.exec(source);
    return match ? match[1] : undefined;
  }

  function closingTagName(source) {
    var match = /^<\/\s*([A-Za-z_][\w:.-]*)/.exec(source);
    return match ? match[1] : undefined;
  }

  function standaloneTag(source) {
    return /^<(?:\?|!)/.test(source) || /\/\s*>$/.test(source);
  }

  function formatXml(source) {
    var input = source.trim();
    var tokens = [];
    var cursor = 0;
    while (cursor < input.length) {
      if (input[cursor] === "<") {
        var tagEnd = xmlTagEnd(input, cursor);
        tokens.push({ source: input.slice(cursor, tagEnd), tag: true });
        cursor = tagEnd;
      } else {
        var next = input.indexOf("<", cursor);
        var textEnd = next < 0 ? input.length : next;
        tokens.push({ source: input.slice(cursor, textEnd), tag: false });
        cursor = textEnd;
      }
    }
    var lines = [];
    var depth = 0;
    for (var index = 0; index < tokens.length; index += 1) {
      var token = tokens[index];
      if (!token.tag) {
        token.source.trim().split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean)
          .forEach(function (line) { lines.push("  ".repeat(depth) + line); });
        continue;
      }
      var opening = openingTagName(token.source);
      var text = tokens[index + 1];
      var closing = tokens[index + 2];
      if (opening && text && !text.tag && closing && closing.tag && closingTagName(closing.source) === opening) {
        lines.push("  ".repeat(depth) + token.source + text.source.trim() + closing.source);
        index += 2;
        continue;
      }
      if (closingTagName(token.source)) depth = Math.max(0, depth - 1);
      lines.push("  ".repeat(depth) + token.source.trim());
      if (opening && !standaloneTag(token.source)) depth += 1;
    }
    return lines.join("\n");
  }

  function jsonFolds(content) {
    var folds = [];
    var stack = [];
    var line = 0, quoted = false, escaped = false;
    for (var index = 0; index < content.length; index += 1) {
      var character = content[index];
      if (character === "\n") line += 1;
      if (escaped) { escaped = false; continue; }
      if (quoted) {
        if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") { quoted = true; continue; }
      if (character === "{" || character === "[") {
        stack.push({ close: character === "{" ? "}" : "]", fromLine: line });
        continue;
      }
      var opened = stack[stack.length - 1];
      if (!opened || character !== opened.close) continue;
      stack.pop();
      if (line > opened.fromLine) folds.push({ fromLine: opened.fromLine, toLine: line });
    }
    return folds;
  }

  function xmlFolds(content) {
    var folds = [];
    var stack = [];
    content.split("\n").forEach(function (line, lineIndex) {
      var tags = /<[^>]+>/g;
      for (var match = tags.exec(line); match; match = tags.exec(line)) {
        var closing = closingTagName(match[0]);
        if (closing) {
          var opened = stack[stack.length - 1];
          if (opened && opened.name === closing) {
            stack.pop();
            if (lineIndex > opened.fromLine) folds.push({ fromLine: opened.fromLine, toLine: lineIndex });
          }
        } else {
          var opening = openingTagName(match[0]);
          if (opening && !standaloneTag(match[0])) stack.push({ name: opening, fromLine: lineIndex });
        }
      }
    });
    return folds;
  }

  function format(kind, source) {
    var content = source.trim();
    var error;
    if (kind === "json") {
      try {
        var parsed = JSON.parse(source);
        var preview = Array.isArray(parsed) && parsed.length === 1 && parsed[0] && typeof parsed[0] === "object" && !Array.isArray(parsed[0]) ? parsed[0] : parsed;
        content = JSON.stringify(preview, null, 2);
      } catch (_) {
        error = "JSON 内容不完整，暂时显示原始结构";
      }
    } else content = formatXml(source);
    var folds = kind === "json" ? jsonFolds(content) : xmlFolds(content);
    folds.sort(function (left, right) { return left.fromLine - right.fromLine || right.toLine - left.toLine; });
    return { kind: kind, content: content, folds: folds, error: error };
  }

  function appendSegments(parent, source, ranges) {
    var boundaries = [0, source.length];
    ranges.forEach(function (range) { boundaries.push(range.from, range.to); });
    boundaries.sort(function (left, right) { return left - right; });
    boundaries = boundaries.filter(function (value, index) { return index === 0 || value !== boundaries[index - 1]; });
    for (var index = 0; index < boundaries.length - 1; index += 1) {
      var from = boundaries[index], to = boundaries[index + 1];
      var range = ranges.filter(function (candidate) { return candidate.from <= from && candidate.to >= to; }).at(-1);
      parent.append(range ? element("span", range.className, source.slice(from, to)) : document.createTextNode(source.slice(from, to)));
    }
  }

  function appendJson(parent, source) {
    var ranges = [];
    var tokens = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\]]/g;
    for (var match = tokens.exec(source); match; match = tokens.exec(source)) {
      var className = "cm-log-json-punctuation";
      if (match[0][0] === "\"") className = /^\s*:/.test(source.slice(match.index + match[0].length)) ? "cm-log-json-key" : "cm-log-json-string";
      else if (/^-?\d/.test(match[0])) className = "cm-log-json-number";
      else if (/^(?:true|false|null)$/.test(match[0])) className = "cm-log-json-literal";
      ranges.push({ from: match.index, to: match.index + match[0].length, className: className });
    }
    appendSegments(parent, source, ranges);
  }

  function appendXmlTag(parent, source) {
    if (/^<!--/.test(source)) { parent.append(element("span", "cm-log-xml-comment", source)); return; }
    var ranges = [];
    var name = /^<(?:\/\s*)?([A-Za-z_][\w:.-]*)/.exec(source);
    if (name) {
      var nameFrom = source.indexOf(name[1]);
      ranges.push({ from: 0, to: nameFrom, className: "cm-log-xml-punctuation" });
      ranges.push({ from: nameFrom, to: nameFrom + name[1].length, className: "cm-log-xml-name" });
    }
    var attributes = /([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
    for (var attribute = attributes.exec(source); attribute; attribute = attributes.exec(source)) {
      var valueFrom = attribute.index + attribute[0].lastIndexOf(attribute[2]);
      ranges.push({ from: attribute.index, to: attribute.index + attribute[1].length, className: "cm-log-xml-attribute" });
      ranges.push({ from: valueFrom, to: valueFrom + attribute[2].length, className: "cm-log-xml-string" });
    }
    var suffix = Math.max(source.lastIndexOf("/>"), source.lastIndexOf(">"));
    if (suffix >= 0) ranges.push({ from: suffix, to: source.length, className: "cm-log-xml-punctuation" });
    appendSegments(parent, source, ranges);
  }

  function appendXml(parent, source) {
    var cursor = 0;
    for (var tagFrom = source.indexOf("<"); tagFrom >= 0; tagFrom = source.indexOf("<", cursor)) {
      if (tagFrom > cursor) parent.append(document.createTextNode(source.slice(cursor, tagFrom)));
      var tagTo = xmlTagEnd(source, tagFrom);
      appendXmlTag(parent, source.slice(tagFrom, tagTo));
      cursor = tagTo;
    }
    if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
  }

  function directChildren(folds, parentIndex) {
    var parent = folds[parentIndex];
    return folds.map(function (fold, index) { return { fold: fold, index: index }; }).filter(function (candidate) {
      if (candidate.fold.fromLine <= parent.fromLine || candidate.fold.toLine >= parent.toLine) return false;
      return !folds.some(function (possibleParent) {
        return possibleParent.fromLine > parent.fromLine && possibleParent.toLine < parent.toLine
          && possibleParent.fromLine < candidate.fold.fromLine && possibleParent.toLine > candidate.fold.toLine;
      });
    }).map(function (candidate) { return candidate.index; });
  }

  function mount(container, preview) {
    var lines = preview.content.split("\n");
    var collapsed = new Set();
    var foldsByLine = new Map();
    preview.folds.forEach(function (fold, index) {
      var current = foldsByLine.get(fold.fromLine);
      if (!current || fold.toLine - fold.fromLine > current.fold.toLine - current.fold.fromLine) foldsByLine.set(fold.fromLine, { fold: fold, index: index });
    });
    function render() {
      container.textContent = "";
      var fragment = document.createDocumentFragment();
      for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        var row = element("div", "portable-preview-code-row");
        var entry = foldsByLine.get(lineIndex);
        var toggle = element("button", "portable-preview-code-toggle", entry ? (collapsed.has(entry.index) ? "›" : "⌄") : "");
        toggle.type = "button";
        if (entry) toggle.addEventListener("click", (function (foldIndex) { return function () {
          if (collapsed.has(foldIndex)) {
            collapsed.delete(foldIndex);
            directChildren(preview.folds, foldIndex).forEach(function (child) { collapsed.add(child); });
          } else collapsed.add(foldIndex);
          render();
        }; })(entry.index));
        var code = element("code", "portable-preview-code-line");
        if (preview.kind === "json") appendJson(code, lines[lineIndex]);
        else appendXml(code, lines[lineIndex]);
        if (entry && collapsed.has(entry.index)) {
          code.append(element("span", "portable-preview-ellipsis", " … "));
          lineIndex = entry.fold.toLine - 1;
        }
        row.append(toggle, code);
        fragment.append(row);
      }
      container.append(fragment);
    }
    render();
    return {
      foldAll: function () { preview.folds.forEach(function (_, index) { collapsed.add(index); }); render(); },
      unfoldAll: function () { collapsed.clear(); render(); }
    };
  }

  global.OpsLogPortableStructuredPreview = { format: format, mount: mount };
})(typeof window === "undefined" ? globalThis : window);

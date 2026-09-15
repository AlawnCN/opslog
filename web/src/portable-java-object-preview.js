(function (global) {
  "use strict";

  var compositePairs = { "(": ")", "[": "]", "{": "}" };

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function topLevelParts(source, assignmentsOnly) {
    var parts = [];
    var stack = [];
    var from = 0, quote = "", escaped = false;
    for (var index = 0; index < source.length; index += 1) {
      var character = source[index];
      if (escaped) { escaped = false; continue; }
      if (quote) {
        if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "\"" || character === "'") { quote = character; continue; }
      if (compositePairs[character]) { stack.push(compositePairs[character]); continue; }
      if (character === stack[stack.length - 1]) { stack.pop(); continue; }
      var startsNextField = /^\s*[A-Za-z_$][\w$]*\s*=/.test(source.slice(index + 1));
      if (character === "," && stack.length === 0 && (!assignmentsOnly || startsNextField)) {
        parts.push(source.slice(from, index).trim());
        from = index + 1;
      }
    }
    parts.push(source.slice(from).trim());
    return parts.filter(Boolean);
  }

  function topLevelAssignment(source) {
    var stack = [];
    var quote = "", escaped = false;
    for (var index = 0; index < source.length; index += 1) {
      var character = source[index];
      if (escaped) { escaped = false; continue; }
      if (quote) {
        if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === "\"" || character === "'") { quote = character; continue; }
      if (compositePairs[character]) { stack.push(compositePairs[character]); continue; }
      if (character === stack[stack.length - 1]) { stack.pop(); continue; }
      if (character === "=" && stack.length === 0) return index;
    }
    return -1;
  }

  function scalarNode(source) {
    var value = source.trim();
    var scalarKind = value === "null" ? "null"
      : /^(?:true|false)$/i.test(value) ? "boolean"
        : /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ? "number"
          : /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(value) ? "string" : "plain";
    return { kind: "scalar", scalarKind: scalarKind, value: value, members: [] };
  }

  function parseMembers(source, depth, indexed) {
    return topLevelParts(source, !indexed).map(function (part, index) {
      if (indexed) return { name: "[" + index + "]", value: parseValue(part, depth + 1) };
      var assignment = topLevelAssignment(part);
      if (assignment < 0) return { name: "[" + index + "]", value: parseValue(part, depth + 1) };
      return { name: part.slice(0, assignment).trim(), value: parseValue(part.slice(assignment + 1), depth + 1) };
    });
  }

  function parseValue(source, depth) {
    var value = source.trim();
    if ((depth || 0) > 80) return scalarNode(value);
    var object = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^>]+>)?)\s*\(([\s\S]*)\)$/.exec(value);
    if (object) return { kind: "object", typeName: object[1], members: parseMembers(object[2], depth || 0, false) };
    if (value.startsWith("[") && value.endsWith("]")) return { kind: "list", typeName: "List", members: parseMembers(value.slice(1, -1), depth || 0, true) };
    if (value.startsWith("{") && value.endsWith("}")) return { kind: "map", typeName: "Map", members: parseMembers(value.slice(1, -1), depth || 0, false) };
    return scalarNode(value);
  }

  function nodeSummary(node) {
    if (node.kind === "scalar") return node.value || "";
    if (node.kind === "object") return (node.typeName || "Object") + " (" + node.members.length + " fields)";
    return node.typeName + " [" + node.members.length + "]";
  }

  function expandablePaths(node, path) {
    if (node.kind === "scalar") return [];
    return [path].concat(node.members.flatMap(function (member, index) { return expandablePaths(member.value, path + "." + index); }));
  }

  function mount(container, source) {
    var root = parseValue(source, 0);
    var paths = expandablePaths(root, "root");
    var expanded = new Set(["root"]);
    function renderNode(fragment, node, fieldName, path, depth) {
      var expandable = node.kind !== "scalar";
      var opened = expanded.has(path);
      var row = element("div", "java-object-row is-" + node.kind);
      row.style.paddingLeft = (12 + depth * 20) + "px";
      if (expandable) {
        var toggle = element("button", "java-object-toggle", opened ? "⌄" : "›");
        toggle.type = "button";
        toggle.title = opened ? "折叠字段" : "展开字段";
        toggle.addEventListener("click", function () {
          if (expanded.has(path)) expanded.delete(path);
          else expanded.add(path);
          render();
        });
        row.append(toggle);
      } else row.append(element("span", "java-object-toggle-spacer"));
      row.append(element("span", "java-object-kind " + (fieldName ? "is-field" : "is-class"), fieldName ? "f" : "C"));
      if (fieldName) row.append(element("span", "java-object-field", fieldName), element("span", "java-object-equals", "="));
      row.append(element("span", node.kind === "scalar" ? "java-object-value is-" + node.scalarKind : "java-object-type", nodeSummary(node)));
      fragment.append(row);
      if (!expandable || !opened) return;
      node.members.forEach(function (member, index) { renderNode(fragment, member.value, member.name, path + "." + index, depth + 1); });
    }
    function render() {
      container.textContent = "";
      var fragment = document.createDocumentFragment();
      renderNode(fragment, root, undefined, "root", 0);
      container.append(fragment);
    }
    render();
    return {
      foldAll: function () { expanded.clear(); render(); },
      unfoldAll: function () { expanded = new Set(paths); render(); }
    };
  }

  global.OpsLogPortableJavaPreview = { mount: mount, parse: function (source) { return parseValue(source, 0); } };
})(typeof window === "undefined" ? globalThis : window);

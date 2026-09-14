import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleaseNotesMarkdown } from "../web/src/components/ReleaseNotesMarkdown";
import { normalizeReleaseNotes } from "../web/src/update-release-notes";

test("keeps complete updater release notes", () => {
  assert.equal(
    normalizeReleaseNotes("\r\n## 新功能\r\n\r\n- 支持完整更新说明\r\n"),
    "## 新功能\n\n- 支持完整更新说明"
  );
});

test("rejects the legacy GitHub redirect placeholder", () => {
  assert.equal(
    normalizeReleaseNotes("OpsLog 3.0.19 已发布。完整更新说明请查看 GitHub Release。"),
    undefined
  );
  assert.equal(normalizeReleaseNotes("   "), undefined);
});

test("renders GitHub release markdown", () => {
  const html = renderToStaticMarkup(createElement(ReleaseNotesMarkdown, {
    notes: "## 新功能\n\n- 支持 **A**\n- 支持 `B`\n\n```bash\nxattr -dr app\n```"
  }));

  assert.match(html, /<h2>新功能<\/h2>/);
  assert.match(html, /<li>支持 <strong>A<\/strong><\/li>/);
  assert.match(html, /<code>B<\/code>/);
  assert.match(html, /language-bash/);
});

test("does not render release HTML or unsafe links and images", () => {
  const html = renderToStaticMarkup(createElement(ReleaseNotesMarkdown, {
    notes: "<script>alert(1)</script>\n\n[危险](javascript:alert(1)) [安全](https://example.com/release)\n\n![远程图](https://example.com/image.png)"
  }));

  assert.doesNotMatch(html, /<script|javascript:|<img/i);
  assert.match(html, /href="https:\/\/example\.com\/release"/);
  assert.match(html, /\[图片：远程图\]/);
});

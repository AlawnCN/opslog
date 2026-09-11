import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReleaseNotes, parseReleaseNotes } from "../web/src/update-release-notes";

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

test("parses GitHub release markdown into safe display blocks", () => {
  assert.deepEqual(parseReleaseNotes("## 新功能\n\n- 支持 A\n- 支持 `B`\n\n说明 **完成**。\n\n```bash\nxattr -dr app\n```"), [
    { type: "heading", level: 2, text: "新功能" },
    { type: "list", items: ["支持 A", "支持 B"] },
    { type: "paragraph", text: "说明 完成。" },
    { type: "code", text: "xattr -dr app" }
  ]);
});

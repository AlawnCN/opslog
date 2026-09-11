const LEGACY_RELEASE_NOTES = [
  /完整更新说明请查看\s*GitHub\s*Release/i,
  /full release notes (?:are )?available on\s*GitHub/i
];

export const normalizeReleaseNotes = (notes: string | null | undefined): string | undefined => {
  const normalized = notes?.replace(/\r\n?/g, "\n").trim();
  if (!normalized || LEGACY_RELEASE_NOTES.some((pattern) => pattern.test(normalized))) return undefined;
  return normalized;
};

export type ReleaseNotesBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; text: string };

const cleanInlineMarkdown = (value: string): string => value
  .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, "$1 — $2")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .trim();

export const parseReleaseNotes = (notes: string): ReleaseNotesBlock[] => {
  const blocks: ReleaseNotesBlock[] = [];
  const lines = notes.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | undefined;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: cleanInlineMarkdown(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push({ type: "list", items: list.map(cleanInlineMarkdown) });
    list = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push({ type: "code", text: code.join("\n") });
        code = undefined;
      } else {
        flushParagraph();
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: cleanInlineMarkdown(heading[2]) });
      continue;
    }

    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    flushList();

    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  if (code) blocks.push({ type: "code", text: code.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
};

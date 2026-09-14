const LEGACY_RELEASE_NOTES = [
  /完整更新说明请查看\s*GitHub\s*Release/i,
  /full release notes (?:are )?available on\s*GitHub/i
];

export const normalizeReleaseNotes = (notes: string | null | undefined): string | undefined => {
  const normalized = notes?.replace(/\r\n?/g, "\n").trim();
  if (!normalized || LEGACY_RELEASE_NOTES.some((pattern) => pattern.test(normalized))) return undefined;
  return normalized;
};

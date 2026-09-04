const quote = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

export const toCsv = (columns: string[], rows: Record<string, unknown>[]): string => {
  const lines = [columns.map(quote).join(",")];
  for (const row of rows) lines.push(columns.map((column) => quote(row[column])).join(","));
  return `\uFEFF${lines.join("\r\n")}`;
};

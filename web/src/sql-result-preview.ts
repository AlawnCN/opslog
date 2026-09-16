import { parseJavaObjectPreview, type JavaObjectPreviewNode } from "./java-object-preview";

export const parseSqlResultPreview = (source: string): JavaObjectPreviewNode =>
  parseJavaObjectPreview(source.trim());

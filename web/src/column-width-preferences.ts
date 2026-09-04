import { useEffect, useState } from "react";
import type { LogKind } from "./types";

export const MIN_COLUMN_WIDTH = 110;
export const MAX_COLUMN_WIDTH = 720;

const storageKey = (kind: LogKind): string => `opslog.column-widths.${kind}.v1`;

const clampWidth = (value: number): number => Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(value)));

export const defaultColumnWidth = (column: string): number => {
  if (column === "message" || column.endsWith(".message.info")) return 360;
  if (column.endsWith(".id")) return 340;
  if (column.includes("trace")) return 260;
  if (column.endsWith(".service") || column.endsWith(".business")) return 220;
  return 170;
};

const readPreference = (kind: LogKind, available: string[]): Record<string, number> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey(kind)) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    const saved = stored as Record<string, unknown>;
    return Object.fromEntries(available.flatMap((column) => {
      const width = saved[column];
      return typeof width === "number" && Number.isFinite(width) ? [[column, clampWidth(width)]] : [];
    }));
  } catch {
    return {};
  }
};

const savePreference = (kind: LogKind, widths: Record<string, number>): void => {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(widths));
  } catch {
    // Storage may be disabled by browser policy; resizing still works for this session.
  }
};

export const useColumnWidthPreferences = (kind: LogKind, available: string[]) => {
  const [widths, setWidths] = useState<Record<string, number>>(() => readPreference(kind, available));
  const signature = available.join("\u0000");

  useEffect(() => {
    setWidths(readPreference(kind, available));
  }, [kind, signature]);

  const setWidth = (column: string, width: number) => {
    const next = { ...widths, [column]: clampWidth(width) };
    setWidths(next);
    savePreference(kind, next);
  };

  const resetWidth = (column: string) => {
    if (!(column in widths)) return;
    const next = { ...widths };
    delete next[column];
    setWidths(next);
    savePreference(kind, next);
  };

  return {
    widthOf: (column: string): number => widths[column] ?? defaultColumnWidth(column),
    setWidth,
    resetWidth
  };
};

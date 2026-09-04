import { useEffect, useMemo, useState } from "react";
import type { LogKind } from "./types";

const storageKey = (kind: LogKind): string => `opslog.visible-columns.${kind}.v1`;

const readPreference = (kind: LogKind, available: string[]): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(kind)) ?? "[]");
    if (!Array.isArray(stored)) return available;
    const availableSet = new Set(available);
    const valid = [...new Set(stored.filter((value): value is string =>
      typeof value === "string" && availableSet.has(value)
    ))];
    return valid.length > 0 ? valid : available;
  } catch {
    return available;
  }
};

const savePreference = (kind: LogKind, columns: string[]): void => {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(columns));
  } catch {
    // Storage may be disabled by browser policy; column selection still works for this session.
  }
};

export const useColumnPreferences = (kind: LogKind, available: string[]) => {
  const [selected, setSelected] = useState<string[]>(() => readPreference(kind, available));
  const signature = available.join("\u0000");

  useEffect(() => {
    setSelected(readPreference(kind, available));
  }, [kind, signature]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const availableSet = useMemo(() => new Set(available), [signature]);
  const visible = selected.filter((column) => availableSet.has(column));
  const options = [...visible, ...available.filter((column) => !selectedSet.has(column))];

  const update = (next: string[]) => {
    const ordered = [...new Set(next.filter((column) => availableSet.has(column)))];
    if (ordered.length === 0) return;
    setSelected(ordered);
    savePreference(kind, ordered);
  };

  const toggle = (column: string) => {
    if (selectedSet.has(column)) {
      update(selected.filter((candidate) => candidate !== column));
      return;
    }
    update([...selected, column]);
  };

  const move = (column: string, direction: -1 | 1) => {
    const currentIndex = selected.indexOf(column);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= selected.length) return;
    const next = [...selected];
    [next[currentIndex], next[targetIndex]] = [next[targetIndex]!, next[currentIndex]!];
    update(next);
  };

  return {
    visible,
    options,
    selected: selectedSet,
    toggle,
    move,
    selectAll: () => update(available),
    reset: () => update(available)
  };
};

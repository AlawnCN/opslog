import { findPlainLogMatchesInLowercase, findRegexLogMatches, MAX_LOG_SEARCH_MATCHES, type LogSearchMatch } from "./transaction-log-search";
import type { LogHighlight, LogOutlineItem } from "./transaction-log-model";

export interface CustomLogMarkerRule {
  id: string;
  label: string;
  query: string;
  regex: boolean;
}

export interface CustomLogMarker {
  id: string;
  label: string;
  rules: CustomLogMarkerRule[];
}

export interface CustomLogMarkerOutline {
  items: LogOutlineItem[];
  highlights: LogHighlight[];
}

interface MarkerStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const CUSTOM_LOG_MARKERS_KEY = "opslog.transaction-log.custom-markers.v1";
export const MAX_CUSTOM_LOG_MARKERS = 40;
const MAX_RULES = MAX_CUSTOM_LOG_MARKERS;

const createId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const cleanText = (value: unknown, maximum: number): string => typeof value === "string" ? value.trim().slice(0, maximum) : "";
const defaultLabel = (query: string): string => query.length > 18 ? `${query.slice(0, 17)}…` : query;

export const createCustomLogMarkerRule = (index = 0): CustomLogMarkerRule => ({
  id: createId(),
  label: `条件 ${index + 1}`,
  query: "",
  regex: false
});

const normalizeRule = (value: unknown): CustomLogMarkerRule | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CustomLogMarkerRule>;
  const query = cleanText(candidate.query, 500);
  if (!query) return undefined;
  return {
    id: cleanText(candidate.id, 80) || createId(),
    label: cleanText(candidate.label, 40) || defaultLabel(query),
    query,
    regex: candidate.regex === true
  };
};

const normalizeMarker = (value: unknown): CustomLogMarker | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<CustomLogMarker>;
  const rules = Array.isArray(candidate.rules)
    ? candidate.rules.map(normalizeRule).filter((rule): rule is CustomLogMarkerRule => Boolean(rule)).slice(0, MAX_RULES)
    : [];
  if (!rules.length) return undefined;
  const storedLabel = cleanText(candidate.label, 40);
  const legacyGeneratedLabel = storedLabel === "新建组合标记" || /^组合 · \d+$/.test(storedLabel);
  return {
    id: cleanText(candidate.id, 80) || createId(),
    label: !storedLabel || legacyGeneratedLabel ? rules[0].label : storedLabel,
    rules
  };
};

export const normalizeCustomLogMarkers = (value: unknown, maximum = MAX_CUSTOM_LOG_MARKERS): CustomLogMarker[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeMarker)
    .filter((marker): marker is CustomLogMarker => Boolean(marker))
    .slice(0, Math.max(0, maximum));
};

export const readCustomLogMarkers = (storage: MarkerStorage = localStorage): CustomLogMarker[] => {
  try {
    const value = JSON.parse(storage.getItem(CUSTOM_LOG_MARKERS_KEY) ?? "[]") as unknown;
    return normalizeCustomLogMarkers(value);
  } catch {
    return [];
  }
};

export const storeCustomLogMarkers = (markers: CustomLogMarker[], storage: MarkerStorage = localStorage): void => {
  try {
    storage.setItem(CUSTOM_LOG_MARKERS_KEY, JSON.stringify(markers.slice(0, MAX_CUSTOM_LOG_MARKERS)));
  } catch {
    // Markers remain usable for the current session when storage is unavailable.
  }
};

export const createCustomLogMarker = (query: string, regex: boolean): CustomLogMarker => {
  const normalizedQuery = query.trim();
  const rule: CustomLogMarkerRule = { id: createId(), label: defaultLabel(normalizedQuery), query: normalizedQuery, regex };
  return { id: createId(), label: rule.label, rules: [rule] };
};

export const createEmptyCustomLogMarker = (): CustomLogMarker => ({
  id: createId(),
  label: "新建标记",
  rules: [createCustomLogMarkerRule()]
});

export const cloneCustomLogMarker = (markers: CustomLogMarker[], markerId: string): CustomLogMarker[] => {
  if (markers.length >= MAX_CUSTOM_LOG_MARKERS) return markers;
  const markerIndex = markers.findIndex(({ id }) => id === markerId);
  if (markerIndex < 0) return markers;
  const marker = markers[markerIndex];
  const label = `${marker.label} 副本`.slice(0, 40);
  const clone: CustomLogMarker = {
    ...marker,
    id: createId(),
    label,
    rules: marker.rules.map((rule) => ({ ...rule, id: createId() }))
  };
  const next = [...markers];
  next.splice(markerIndex + 1, 0, clone);
  return next;
};

export const reorderCustomLogMarkers = (markers: CustomLogMarker[], sourceId: string, targetId: string, after: boolean): CustomLogMarker[] => {
  const sourceIndex = markers.findIndex(({ id }) => id === sourceId);
  const targetIndex = markers.findIndex(({ id }) => id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return markers;
  const next = [...markers];
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTarget = next.findIndex(({ id }) => id === targetId);
  next.splice(adjustedTarget + (after ? 1 : 0), 0, source);
  return next;
};

export const reorderCustomLogMarkerRules = (rules: CustomLogMarkerRule[], sourceId: string, targetId: string, after: boolean): CustomLogMarkerRule[] => {
  const sourceIndex = rules.findIndex(({ id }) => id === sourceId);
  const targetIndex = rules.findIndex(({ id }) => id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return rules;
  const next = [...rules];
  const [source] = next.splice(sourceIndex, 1);
  const adjustedTarget = next.findIndex(({ id }) => id === targetId);
  next.splice(adjustedTarget + (after ? 1 : 0), 0, source);
  return next;
};

export const combineCustomLogMarkers = (markers: CustomLogMarker[], sourceId: string, targetId: string): CustomLogMarker[] => {
  if (sourceId === targetId) return markers;
  const source = markers.find(({ id }) => id === sourceId);
  const target = markers.find(({ id }) => id === targetId);
  if (!source || !target) return markers;
  const targetIndex = markers.findIndex(({ id }) => id === targetId);
  const insertionIndex = markers
    .slice(0, targetIndex)
    .filter(({ id }) => id !== sourceId && id !== targetId)
    .length;
  const rules = [...target.rules, ...source.rules].slice(0, MAX_RULES);
  const combined: CustomLogMarker = {
    id: createId(),
    label: target.label,
    rules
  };
  const next = markers.filter(({ id }) => id !== sourceId && id !== targetId);
  next.splice(insertionIndex, 0, combined);
  return next;
};

const lineStartsFor = (content: string): number[] => {
  const starts = [0];
  for (let index = content.indexOf("\n"); index >= 0; index = content.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
};

const lineIndexAt = (starts: number[], position: number): number => {
  let low = 0, high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
};

const matchesForRule = (content: string, lowercaseContent: string, rule: CustomLogMarkerRule, limit: number): LogSearchMatch[] => rule.regex
  ? findRegexLogMatches(content, rule.query, limit).matches
  : findPlainLogMatchesInLowercase(lowercaseContent, rule.query, limit);

export const buildCustomLogMarkerOutline = (content: string, marker: CustomLogMarker): CustomLogMarkerOutline => {
  if (!content) return { items: [], highlights: [] };
  const starts = lineStartsFor(content);
  const lowercaseContent = content.toLocaleLowerCase();
  const matches: Array<LogSearchMatch & { ruleIndex: number; ruleLabel: string }> = [];
  marker.rules.forEach((rule, ruleIndex) => {
    const remainingRules = marker.rules.length - ruleIndex;
    const quota = Math.max(1, Math.ceil((MAX_LOG_SEARCH_MATCHES - matches.length) / remainingRules));
    matches.push(...matchesForRule(content, lowercaseContent, rule, quota)
      .map((match) => ({ ...match, ruleIndex, ruleLabel: rule.label })));
  });
  matches.sort((left, right) => left.from - right.from || left.ruleIndex - right.ruleIndex || left.to - right.to);

  const highlights: LogHighlight[] = [];
  const items: LogOutlineItem[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const lineIndex = lineIndexAt(starts, match.from);
    const lineFrom = starts[lineIndex];
    const newline = content.indexOf("\n", lineFrom);
    const lineTo = newline < 0 ? content.length : newline;
    const key = `${match.from}:${match.to}:${match.ruleLabel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ line: lineIndex + 1, from: lineFrom, to: lineTo, detail: match.ruleLabel });
    highlights.push({ from: match.from, to: match.to, kind: "custom-match" });
  }
  return { items, highlights };
};

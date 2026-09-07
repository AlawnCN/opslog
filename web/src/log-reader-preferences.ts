export type LogReaderFoldMode = "folded" | "expanded";

export interface LogReaderPreferences {
  wrapLines: boolean;
  outlineWrapLines: boolean;
  foldMode: LogReaderFoldMode;
}

interface ReaderPreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const LOG_READER_PREFERENCES_KEY = "opslog.transaction-log-reader.preferences.v1";
export const DEFAULT_LOG_READER_PREFERENCES: LogReaderPreferences = {
  wrapLines: false,
  outlineWrapLines: false,
  foldMode: "expanded"
};

const normalizePreferences = (value: unknown): LogReaderPreferences => {
  if (!value || typeof value !== "object") return DEFAULT_LOG_READER_PREFERENCES;
  const candidate = value as Partial<LogReaderPreferences>;
  return {
    wrapLines: typeof candidate.wrapLines === "boolean" ? candidate.wrapLines : DEFAULT_LOG_READER_PREFERENCES.wrapLines,
    outlineWrapLines: typeof candidate.outlineWrapLines === "boolean"
      ? candidate.outlineWrapLines
      : DEFAULT_LOG_READER_PREFERENCES.outlineWrapLines,
    foldMode: candidate.foldMode === "folded" || candidate.foldMode === "expanded"
      ? candidate.foldMode
      : DEFAULT_LOG_READER_PREFERENCES.foldMode
  };
};

export const readLogReaderPreferences = (storage: ReaderPreferenceStorage = localStorage): LogReaderPreferences => {
  try {
    return normalizePreferences(JSON.parse(storage.getItem(LOG_READER_PREFERENCES_KEY) ?? "null"));
  } catch {
    return DEFAULT_LOG_READER_PREFERENCES;
  }
};

export const storeLogReaderPreferences = (
  preferences: LogReaderPreferences,
  storage: ReaderPreferenceStorage = localStorage
) => {
  try {
    storage.setItem(LOG_READER_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Reader controls remain usable when local storage is disabled.
  }
};

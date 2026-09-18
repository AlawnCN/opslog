import { invoke, isTauri } from "@tauri-apps/api/core";

export const READER_SETTINGS_KEYS = [
  "opslog.transaction-log.custom-markers.v1",
  "opslog.transaction-log-reader.preferences.v1",
  "opslog.transaction-log.custom-marker-width-ratio.v1",
  "opslog.transaction-log-reader.width-ratio.v1",
  "opslog.transaction-log-outline.geometry.v1"
] as const;

const isReaderSettingKey = (key: string): boolean =>
  READER_SETTINGS_KEYS.some((candidate) => candidate === key);

const browserStorage = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export const readerSettingsStorage = {
  getItem: (key: string): string | null => browserStorage()?.getItem(key) ?? null,
  setItem: (key: string, value: string): void => {
    browserStorage()?.setItem(key, value);
    if (!isTauri() || !isReaderSettingKey(key)) return;
    void invoke("save_reader_setting", { input: { key, value } }).catch(() => {
      // Local settings remain available if the shared native store cannot be written.
    });
  }
};

export const hydrateReaderSettings = async (): Promise<void> => {
  if (!isTauri()) return;
  const storage = browserStorage();
  if (!storage) return;
  try {
    const shared = await invoke<Record<string, string>>("load_reader_settings");
    await Promise.all(READER_SETTINGS_KEYS.map(async (key) => {
      const sharedValue = shared[key];
      if (typeof sharedValue === "string") {
        storage.setItem(key, sharedValue);
        return;
      }
      const legacyValue = storage.getItem(key);
      if (legacyValue !== null) {
        await invoke("save_reader_setting", { input: { key, value: legacyValue } });
      }
    }));
  } catch {
    // Existing local preferences continue to work if native hydration fails.
  }
};

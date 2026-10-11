import { invoke, isTauri } from "@tauri-apps/api/core";

export const READER_SETTINGS_KEYS = [
  "opslog.appearance.theme.v1",
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

// Keep rapid preference changes ordered, including changes shared with Reader.
let nativeWrites: Promise<void> = Promise.resolve();
const saveNativeSetting = (key: string, value: string): Promise<void> => {
  nativeWrites = nativeWrites.then(() =>
    invoke<void>("save_reader_setting", { input: { key, value } })
  ).catch(() => {
    // A failed write must not prevent later preferences from being saved.
  });
  return nativeWrites;
};

export const readerSettingsStorage = {
  getItem: (key: string): string | null => browserStorage()?.getItem(key) ?? null,
  setItem: (key: string, value: string): void => {
    try {
      browserStorage()?.setItem(key, value);
    } catch {
      // Native persistence remains available when browser storage is disabled.
    }
    if (!isTauri() || !isReaderSettingKey(key)) return;
    void saveNativeSetting(key, value);
  }
};

export const hydrateReaderSettings = async (): Promise<void> => {
  if (!isTauri()) return;
  const storage = browserStorage();
  if (!storage) return;
  try {
    await nativeWrites;
    const shared = await invoke<Record<string, string>>("load_reader_settings");
    await Promise.all(READER_SETTINGS_KEYS.map(async (key) => {
      const sharedValue = shared[key];
      if (typeof sharedValue === "string") {
        storage.setItem(key, sharedValue);
        return;
      }
      const legacyValue = storage.getItem(key);
      if (legacyValue !== null) {
        await saveNativeSetting(key, legacyValue);
      }
    }));
  } catch {
    // Existing local preferences continue to work if native hydration fails.
  }
};

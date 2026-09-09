interface MarkerLayoutStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const CUSTOM_MARKER_WIDTH_RATIO_KEY = "opslog.transaction-log.custom-marker-width-ratio.v1";
export const DEFAULT_CUSTOM_MARKER_WIDTH_RATIO = .28;
export const MIN_CUSTOM_MARKER_WIDTH_RATIO = .16;
export const MAX_CUSTOM_MARKER_WIDTH_RATIO = .58;

export const clampCustomMarkerWidthRatio = (ratio: number): number =>
  Math.min(MAX_CUSTOM_MARKER_WIDTH_RATIO, Math.max(MIN_CUSTOM_MARKER_WIDTH_RATIO, ratio));

export const readCustomMarkerWidthRatio = (storage: MarkerLayoutStorage = localStorage): number => {
  try {
    const ratio = Number.parseFloat(storage.getItem(CUSTOM_MARKER_WIDTH_RATIO_KEY) ?? "");
    return clampCustomMarkerWidthRatio(Number.isFinite(ratio) ? ratio : DEFAULT_CUSTOM_MARKER_WIDTH_RATIO);
  } catch {
    return DEFAULT_CUSTOM_MARKER_WIDTH_RATIO;
  }
};

export const storeCustomMarkerWidthRatio = (ratio: number, storage: MarkerLayoutStorage = localStorage): void => {
  try {
    storage.setItem(CUSTOM_MARKER_WIDTH_RATIO_KEY, String(clampCustomMarkerWidthRatio(ratio)));
  } catch {
    // Resizing remains available for the current session when storage is unavailable.
  }
};

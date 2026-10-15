const SIDEBAR_COLLAPSED_KEY = "opslog.navigation.collapsed.v1";

export const readNavigationCollapsed = (): boolean => {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"; }
  catch { return false; }
};

export const storeNavigationCollapsed = (collapsed: boolean): void => {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed)); }
  catch { /* The current layout still works when preferences cannot be saved. */ }
};

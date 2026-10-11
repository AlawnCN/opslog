import React, { useSyncExternalStore } from "react";
import { currentTheme, normalizeTheme, setTheme, subscribeTheme, THEMES } from "../theme";
import { AppSelect } from "./AppSelect";

const themeOptions = THEMES.map(({ value, label, description }) => ({ value, label, description }));

export const ThemePicker = () => {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "cyberpunk" as const);
  return <AppSelect className="theme-picker" ariaLabel="界面主题" value={theme} options={themeOptions} menuClassName="theme-picker-menu" menuMinWidth={280} onChange={(value) => setTheme(normalizeTheme(value))} leadingIcon={
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4C21 6.4 17 3 12 3Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="10.5" cy="7" r=".8"/><circle cx="15" cy="7.5" r=".8"/></svg>
  } />;
};

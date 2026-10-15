import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { hydrateReaderSettings } from "./reader-settings-storage";
import { installScopedTextSelection } from "./scoped-text-selection";
import "./styles.css";
import "./themes.css";
import { initializeTheme } from "./theme";
import { initializeTypography } from "./typography-preferences";
import "./typography.css";
import "./header-toolbar.css";

const start = async () => {
  installScopedTextSelection(document);
  initializeTheme();
  initializeTypography();
  await hydrateReaderSettings();
  initializeTheme();
  initializeTypography();
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
};

void start();

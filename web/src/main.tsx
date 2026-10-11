import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { hydrateReaderSettings } from "./reader-settings-storage";
import { installScopedTextSelection } from "./scoped-text-selection";
import "./styles.css";
import "./themes.css";
import { initializeTheme } from "./theme";

const start = async () => {
  installScopedTextSelection(document);
  initializeTheme();
  await hydrateReaderSettings();
  initializeTheme();
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
};

void start();

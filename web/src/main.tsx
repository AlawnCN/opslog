import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { hydrateReaderSettings } from "./reader-settings-storage";
import { installScopedTextSelection } from "./scoped-text-selection";
import "./styles.css";

const start = async () => {
  installScopedTextSelection(document);
  await hydrateReaderSettings();
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
};

void start();

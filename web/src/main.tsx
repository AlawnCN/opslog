import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { hydrateReaderSettings } from "./reader-settings-storage";
import "./styles.css";

const start = async () => {
  await hydrateReaderSettings();
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
};

void start();

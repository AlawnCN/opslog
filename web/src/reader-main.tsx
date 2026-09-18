import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ReaderApp from "./ReaderApp";
import { hydrateReaderSettings } from "./reader-settings-storage";
import "./styles.css";

const start = async () => {
  await hydrateReaderSettings();
  createRoot(document.getElementById("root")!).render(<StrictMode><ReaderApp /></StrictMode>);
};

void start();

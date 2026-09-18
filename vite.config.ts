import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), "web/index.html"),
        reader: resolve(process.cwd(), "web/reader.html")
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" }
  }
});

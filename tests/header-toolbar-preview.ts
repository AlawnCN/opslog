// APP header fixture: no Tauri bridge, live credentials or LAN exposure.
import { createServer } from "vite";
import path from "node:path";
import express from "express";

const vite = await createServer({ configFile: path.resolve("vite.config.ts"), server: { middlewareMode: true, open: false } });
const app = express();
app.use(async (request, response, next) => {
  if (request.path !== "/__header-preview") { next(); return; }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>APP toolbar preview</title></head><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Header} from '/src/components/Header.tsx';
    import {setTheme} from '/src/theme.ts'; import {initializeTypography} from '/src/typography-preferences.ts';
    import '/src/styles.css'; import '/src/themes.css'; import '/src/typography.css'; import '/src/header-toolbar.css';
    setTheme('cyber-anime'); initializeTypography();
    const noop=()=>{};
    const environment={name:'faulu-m5-prd',sourceType:'elk',timeZone:'Africa/Nairobi',sshApplications:[],insecureTls:false};
    createRoot(document.getElementById('root')).render(React.createElement('div',{className:'app-shell'},React.createElement(Header,{
      environments:[environment],selected:environment.name,onSelect:noop,loading:false,desktopMode:true,canImportConfig:true,
      lanShare:{enabled:false,busy:false,enable:async()=>{},disable:async()=>{}},onConfigure:noop,
      updateAvailable:true,updateBusy:false,onCheckForUpdates:noop
    })));
  </script></body></html>`;
  response.type("html").send(await vite.transformIndexHtml(request.url, html));
});
app.use(vite.middlewares);
const listener = app.listen(18819, "127.0.0.1", () => console.log("Header preview: http://127.0.0.1:18819/__header-preview"));
process.once("SIGINT", async () => { listener.close(); await vite.close(); process.exit(0); });

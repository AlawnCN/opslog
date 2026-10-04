import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PointerEvent } from "react";
import { desktopMode } from "../api";

export const ReaderTitlebar = () => {
  if (!desktopMode) return null;
  const mac = navigator.userAgent.includes("Macintosh");
  const drag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  };
  return <header className={`reader-titlebar${mac?" is-macos-overlay":""}`} onPointerDown={drag} onDoubleClick={(event)=>{
    if (!(event.target as HTMLElement).closest("button")) void getCurrentWindow().toggleMaximize().catch(()=>undefined);
  }}>
    <span>OPSLOG <b>READER</b></span>
    {!mac && <div className="reader-window-controls">
      <button type="button" aria-label="最小化" title="最小化" onClick={()=>void getCurrentWindow().minimize()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10"/></svg></button>
      <button type="button" aria-label="最大化或还原" title="最大化 / 还原" onClick={()=>void getCurrentWindow().toggleMaximize()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v10H3z"/></svg></button>
      <button type="button" className="is-close" aria-label="关闭窗口" title="关闭" onClick={()=>void getCurrentWindow().close()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13"/></svg></button>
    </div>}
  </header>;
};

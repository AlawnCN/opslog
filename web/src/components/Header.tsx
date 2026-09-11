import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Environment } from "../types";
import type { LanShareController } from "../use-lan-share";
import { ImportIcon, PulseIcon } from "./Icons";
import { LanShareControl } from "./LanShareControl";

interface HeaderProps {
  environments: Environment[];
  selected: string;
  onSelect: (name: string) => void;
  loading: boolean;
  desktopMode: boolean;
  canImportConfig: boolean;
  lanShare: LanShareController;
  onImportConfig: (file: File) => Promise<void>;
  updateAvailable: boolean;
  updateBusy: boolean;
  onCheckForUpdates: () => void;
}

export const Header = ({ environments, selected, onSelect, loading, desktopMode, canImportConfig, lanShare, onImportConfig, updateAvailable, updateBusy, onCheckForUpdates }: HeaderProps) => {
  const environment = environments.find((item) => item.name === selected);
  const configInput = useRef<HTMLInputElement>(null);
  const macDesktop = desktopMode && navigator.userAgent.includes("Macintosh");

  const selectConfig = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    await onImportConfig(file);
    if (configInput.current) configInput.current.value = "";
  };

  const startWindowDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!macDesktop || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, select, option, label")) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  return (
    <header className={`topbar${macDesktop ? " is-macos-overlay" : ""}`} onPointerDown={startWindowDrag}>
      <div className="brand">
        <div className="brand-mark"><PulseIcon /></div>
        <div>
          <strong>OPSLOG</strong>
          <span>OBSERVABILITY CONSOLE</span>
        </div>
      </div>
      <div className="topbar-context">
        {canImportConfig && <>
          <button className="config-import" type="button" disabled={loading} onClick={() => configInput.current?.click()}><ImportIcon />导入配置</button>
          <input ref={configInput} className="config-file-input" type="file" accept="application/json,.json" onChange={(event) => void selectConfig(event.currentTarget.files)} />
        </>}
        <div className="environment-control">
          <label htmlFor="environment">运行环境</label>
          <select id="environment" value={selected} onChange={(event) => onSelect(event.target.value)}>
            {environments.map((item) => <option key={item.name}>{item.name}</option>)}
          </select>
        </div>
        <div className={`connection-state ${environment?.insecureTls ? "warning" : ""}`}>
          <i />
          {loading ? "正在查询" : environment?.insecureTls ? "TLS 兼容模式" : "查询网关就绪"}
        </div>
        {desktopMode && <LanShareControl controller={lanShare} />}
        {desktopMode
          ? <button className={`version-chip is-interactive${updateAvailable ? " has-update" : ""}`} disabled={updateBusy} title={updateAvailable ? "有新版本可安装" : "检查更新"} onClick={onCheckForUpdates}>APP · 3.0.20<span aria-hidden="true" /></button>
          : <div className="version-chip">WEB · 3.0.20</div>}
      </div>
    </header>
  );
};

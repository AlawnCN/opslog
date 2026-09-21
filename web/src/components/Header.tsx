import { getCurrentWindow } from "@tauri-apps/api/window";
import { type PointerEvent as ReactPointerEvent } from "react";
import type { Environment } from "../types";
import type { LanShareController } from "../use-lan-share";
import { PulseIcon, SettingsIcon } from "./Icons";
import { LanShareControl } from "./LanShareControl";
import { AppSelect } from "./AppSelect";

interface HeaderProps {
  environments: Environment[];
  selected: string;
  onSelect: (name: string) => void;
  loading: boolean;
  desktopMode: boolean;
  canImportConfig: boolean;
  lanShare: LanShareController;
  onConfigure: () => void;
  updateAvailable: boolean;
  updateBusy: boolean;
  onCheckForUpdates: () => void;
}

export const Header = ({ environments, selected, onSelect, loading, desktopMode, canImportConfig, lanShare, onConfigure, updateAvailable, updateBusy, onCheckForUpdates }: HeaderProps) => {
  const environment = environments.find((item) => item.name === selected);
  const macDesktop = desktopMode && navigator.userAgent.includes("Macintosh");

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
        <div className="environment-control">
          <span>运行环境</span>
          <div className="environment-composite-control">
            <AppSelect value={selected} ariaLabel="运行环境" options={environments.map((item) => ({ value: item.name, label: item.name }))} onChange={onSelect} />
            {canImportConfig && <button className="environment-config-trigger" type="button" disabled={loading} title="管理运行环境" onClick={onConfigure}><SettingsIcon /><span>配置</span></button>}
          </div>
        </div>
        <div className={`connection-state ${environment?.insecureTls ? "warning" : ""}`}>
          <i />
          {loading ? "正在查询" : environment?.insecureTls ? "TLS 兼容模式" : "查询网关就绪"}
        </div>
        {desktopMode && <LanShareControl controller={lanShare} />}
        {desktopMode
          ? <button className={`version-chip is-interactive${updateAvailable ? " has-update" : ""}`} disabled={updateBusy} title={updateAvailable ? "有新版本可安装" : "检查更新"} onClick={onCheckForUpdates}>APP · 3.0.33<span aria-hidden="true" /></button>
          : <div className="version-chip">WEB · 3.0.33</div>}
      </div>
    </header>
  );
};

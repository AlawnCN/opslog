import { useRef } from "react";
import type { Environment } from "../types";
import { ImportIcon, PulseIcon } from "./Icons";

interface HeaderProps {
  environments: Environment[];
  selected: string;
  onSelect: (name: string) => void;
  loading: boolean;
  desktopMode: boolean;
  onImportConfig: (file: File) => Promise<void>;
}

export const Header = ({ environments, selected, onSelect, loading, desktopMode, onImportConfig }: HeaderProps) => {
  const environment = environments.find((item) => item.name === selected);
  const configInput = useRef<HTMLInputElement>(null);

  const selectConfig = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    await onImportConfig(file);
    if (configInput.current) configInput.current.value = "";
  };

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><PulseIcon /></div>
        <div>
          <strong>OPSLOG</strong>
          <span>OBSERVABILITY CONSOLE</span>
        </div>
      </div>
      <div className="topbar-context">
        {desktopMode && <>
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
        <div className="version-chip">{desktopMode ? "APP · 3.0.7" : "WEB · 3.0.7"}</div>
      </div>
    </header>
  );
};

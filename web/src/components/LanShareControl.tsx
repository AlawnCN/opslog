import { useEffect, useRef, useState } from "react";
import type { LanShareController } from "../use-lan-share";

interface LanShareControlProps {
  controller: LanShareController;
}

const legacyCopy = (text: string): boolean => {
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
};

export const LanShareControl = ({ controller }: LanShareControlProps) => {
  const [copied, setCopied] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPanelOpen(controller.enabled || Boolean(controller.error));
  }, [controller.enabled, controller.error]);

  useEffect(() => {
    if (!panelOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!controlRef.current?.contains(event.target as Node)) setPanelOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setPanelOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [panelOpen]);

  const copyUrl = async () => {
    if (!controller.url) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(controller.url);
      else if (!legacyCopy(controller.url)) throw new Error("clipboard unavailable");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return <div ref={controlRef} className={`lan-share-control${controller.enabled ? " is-enabled" : ""}`}>
    <button
      className="lan-share-switch"
      type="button"
      role="switch"
      aria-checked={controller.enabled}
      aria-label={controller.enabled ? "关闭局域网分享" : "开启局域网分享"}
      disabled={controller.busy}
      onClick={() => void controller.toggle()}
    >
      <span className="lan-share-switch-track"><i /></span>
      <b>{controller.busy ? "启动中" : "LAN"}</b>
    </button>
    {controller.enabled && <button
      className={`lan-share-details${panelOpen ? " is-active" : ""}`}
      type="button"
      aria-label="查看局域网分享地址"
      aria-expanded={panelOpen}
      onClick={() => setPanelOpen((current) => !current)}
    >URL</button>}
    {panelOpen && (controller.enabled || controller.error) && <div className="lan-share-panel" role="dialog" aria-label="局域网分享详情">
      <button className="lan-share-panel-close" type="button" aria-label="关闭局域网分享详情" onClick={() => setPanelOpen(false)}>×</button>
      <span className="eyebrow">LOCAL NETWORK SHARE</span>
      <strong>{controller.enabled ? "局域网访问已开启" : "局域网分享启动失败"}</strong>
      {controller.url && <div className="lan-share-url-row">
        <code>{controller.url}</code>
        <button type="button" onClick={() => void copyUrl()}>{copied ? "已复制" : "复制"}</button>
      </div>}
      <small>{controller.error ?? "同一局域网设备可直接访问；请求将通过本机网络与 VPN 转发。"}</small>
      {controller.enabled && <em>仅在可信局域网内开启，退出 APP 后自动停止。</em>}
    </div>}
  </div>;
};

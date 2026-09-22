import type { EnvironmentConfiguration } from "../types";
import { EnvironmentSourceBadge } from "./EnvironmentSourceBadge";

interface EnvironmentImportReviewProps {
  candidates: EnvironmentConfiguration[];
  selected: Set<number>;
  onToggle: (index: number) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export const EnvironmentImportReview = ({ candidates, selected, onToggle, onSelectAll, onClear, onCancel, onConfirm }: EnvironmentImportReviewProps) => <div className="environment-import-review-backdrop" role="presentation" onMouseDown={(event) => { event.stopPropagation(); onCancel(); }}>
  <section className="environment-import-review" role="dialog" aria-modal="true" aria-labelledby="environment-import-title" onMouseDown={(event) => event.stopPropagation()}>
    <header><div><span className="eyebrow">IMPORT ENVIRONMENTS</span><h3 id="environment-import-title">选择导入范围</h3><p>同名同源配置将更新；异源同名配置将新增为副本。本机凭据不受空值覆盖。</p></div><button type="button" aria-label="关闭导入预览" onClick={onCancel}>×</button></header>
    <div className="environment-import-review-toolbar"><span>已选择 {selected.size} / {candidates.length}</span><div><button type="button" onClick={onSelectAll}>全选</button><button type="button" onClick={onClear}>清空</button></div></div>
    <div className="environment-import-review-list">{candidates.map((item, index) => <button type="button" className={selected.has(index) ? "is-selected" : undefined} key={`${item.name}-${index}`} onClick={() => onToggle(index)}>
      <span className="environment-selection-check" aria-hidden="true">{selected.has(index) ? "✓" : ""}</span><EnvironmentSourceBadge source={item.sourceType} /><span className="environment-import-copy"><strong>{item.name || "未命名环境"}</strong><small>{item.sourceType === "ssh" ? `${item.sshServers?.length ?? 0} 台服务器 · ${item.sshMonitoredApplications?.length ?? 0} 个应用` : item.kibanaUrl || "未配置网关"}</small></span>
    </button>)}</div>
    <footer><button type="button" onClick={onCancel}>取消</button><button type="button" className="primary" disabled={!selected.size} onClick={onConfirm}>导入所选</button></footer>
  </section>
</div>;

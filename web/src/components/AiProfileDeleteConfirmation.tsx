import type { SaveAiConfigurationInput } from "../api";
import { CloseIcon, TrashIcon } from "./Icons";
import { useMovableDialog } from "./useMovableDialog";

interface Props {
  profile: SaveAiConfigurationInput;
  active: boolean;
  saving: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export const AiProfileDeleteConfirmation = ({ profile, active, saving, error, onCancel, onConfirm }: Props) => {
  const movable = useMovableDialog<HTMLElement>();
  return <div className="ai-delete-confirm-backdrop" role="presentation" onMouseDown={(event) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onCancel();
  }}>
    <section ref={movable.dialogRef} style={movable.dialogStyle} className="ai-delete-confirm-dialog movable-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ai-delete-title" aria-describedby="ai-delete-description" onMouseDown={(event) => event.stopPropagation()}>
      <header onPointerDown={movable.startMove}><span>DELETE MODEL CONNECTION</span><button type="button" aria-label="取消删除" onClick={onCancel}><CloseIcon /></button></header>
      <div className="ai-delete-confirm-body"><div className="ai-delete-confirm-icon"><TrashIcon /></div><div><h3 id="ai-delete-title">删除模型连接？</h3><p id="ai-delete-description">删除后，连接地址、模型参数及已保存的 API Key 将从当前设备移除，此操作无法撤销。</p></div></div>
      <dl><div><dt>连接</dt><dd>{profile.name}</dd></div><div><dt>模型</dt><dd>{profile.model || "未选择模型"}</dd></div></dl>
      {active && <p className="ai-delete-active-warning">这是当前默认模型。删除后，系统会自动将列表中的另一项设为默认模型。</p>}
      {error && <p className="ai-delete-confirm-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onCancel} disabled={saving}>取消</button><button type="button" className="danger" onClick={onConfirm} disabled={saving}>{saving ? "正在删除…" : "删除连接"}</button></footer>
    </section>
  </div>;
};

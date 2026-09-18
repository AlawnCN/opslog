import type { TrcAssociationStatus } from "../api";

interface TrcAssociationGuideProps {
  status: TrcAssociationStatus;
  pending: boolean;
  onAssociate: () => void;
  onDismiss: () => void;
}

export const TrcAssociationGuide = ({ status, pending, onAssociate, onDismiss }: TrcAssociationGuideProps) => <section className="trc-association-guide" aria-labelledby="trc-association-title">
  <div className="trc-association-icon" aria-hidden="true">.trc</div>
  <div>
    <span>首次使用</span>
    <h2 id="trc-association-title">是否关联 TRC 文件？</h2>
    <p>关联后，双击 <code>.trc</code> 文件会直接使用 OpsLog Reader 打开。暂不关联也可以继续手动选择文件。</p>
  </div>
  <div className="trc-association-actions">
    <button type="button" className="secondary" disabled={pending} onClick={onDismiss}>暂不关联</button>
    <button type="button" className="primary" disabled={pending || !status.supported} onClick={onAssociate}>{pending ? "正在关联…" : `关联到 ${status.platform}`}</button>
  </div>
</section>;

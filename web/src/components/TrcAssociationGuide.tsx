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
    <span>文件关联</span>
    <h2 id="trc-association-title">设置 TRC 默认打开方式</h2>
    <p>关联后，双击 <code>.trc</code> 文件即可在 OpsLog Reader 中打开。也可以稍后在设置中完成关联。</p>
  </div>
  <div className="trc-association-actions">
    <button type="button" className="secondary" disabled={pending} onClick={onDismiss}>稍后设置</button>
    <button type="button" className="primary" disabled={pending || !status.supported} onClick={onAssociate}>{pending ? "正在设置…" : `设为 ${status.platform} 默认应用`}</button>
  </div>
</section>;

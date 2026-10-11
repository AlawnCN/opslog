interface LogFoldActionsProps {
  onFoldLevel: () => void;
  onUnfoldLevel: () => void;
  onFoldAll: () => void;
  onUnfoldAll: () => void;
}

const FoldIcon = ({ expand, all = false }: { expand: boolean; all?: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {all && <path d="M7 3h14v14" />}
    <rect x="3" y={all ? 7 : 4} width="14" height="14" rx="2" />
    <path d={all ? "M7 14h6" : "M7 11h6"} />
    {expand && <path d={all ? "M10 11v6" : "M10 8v6"} />}
  </svg>
);

export const LogFoldActions = ({ onFoldLevel, onUnfoldLevel, onFoldAll, onUnfoldAll }: LogFoldActionsProps) => (
  <div className="log-fold-actions" role="group" aria-label="结构折叠操作">
    <button type="button" title="收起当前可见的最内层结构" onClick={onFoldLevel}><FoldIcon expand={false} /><span>折叠</span></button>
    <button type="button" title="展开当前可见结构的下一层" onClick={onUnfoldLevel}><FoldIcon expand /><span>展开</span></button>
    <span className="log-fold-actions-divider" aria-hidden="true" />
    <button type="button" title="折叠全部结构" onClick={onFoldAll}><FoldIcon expand={false} all /><span>全部折叠</span></button>
    <button type="button" title="展开全部结构" onClick={onUnfoldAll}><FoldIcon expand all /><span>全部展开</span></button>
  </div>
);

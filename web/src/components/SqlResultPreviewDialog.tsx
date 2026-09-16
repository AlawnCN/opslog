import { useMemo } from "react";
import { parseSqlResultPreview } from "../sql-result-preview";
import { ObjectTreePreviewDialog } from "./JavaObjectPreviewDialog";

interface SqlResultPreviewDialogProps {
  source: string;
  onClose: () => void;
}

export const SqlResultPreviewDialog = ({ source, onClose }: SqlResultPreviewDialogProps) => {
  const root = useMemo(() => parseSqlResultPreview(source), [source]);
  return <ObjectTreePreviewDialog
    closeLabel="关闭 SQL Result 预览"
    description="按记录与字段查看查询结果"
    eyebrow="RESULT INSPECTOR"
    expandAllByDefault
    root={root}
    rootBadge="R"
    title="SQL Result 预览"
    onClose={onClose}
  />;
};

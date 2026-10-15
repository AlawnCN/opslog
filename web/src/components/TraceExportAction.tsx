import { useEffect, useRef, useState } from "react";
import { savePortableLogHtml } from "../api";
import { buildTraceHtml, traceExportFilename } from "../trace-export";
import { DownloadIcon } from "./Icons";

interface TraceExportActionProps {
  traceId: string;
  rows: Record<string, unknown>[];
  timeZone: string;
  keyword: string;
  collapsed: ReadonlySet<string>;
  columnWidth: number;
  loading: boolean;
}

export const TraceExportAction = (props: TraceExportActionProps) => {
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const activeTrace = useRef(props.traceId);
  activeTrace.current = props.traceId;
  useEffect(() => { setNotice(undefined); }, [props.traceId, props.rows]);

  const exportHtml = async () => {
    if (exporting || props.loading || !props.rows.length) return;
    const id = props.traceId;
    setExporting(true);
    setNotice(undefined);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    try {
      const filename = traceExportFilename(id);
      const path = await savePortableLogHtml(filename, buildTraceHtml(props));
      if (activeTrace.current === id) setNotice({ text: path ? `已保存：${path}` : `已导出 ${filename}` });
    } catch (error) {
      if (activeTrace.current === id) setNotice({ text: `导出失败：${error instanceof Error ? error.message : String(error)}`, error: true });
    } finally { setExporting(false); }
  };

  return <div className="trace-export-action">
    <button type="button" className="portable-log-export" disabled={props.loading || !props.rows.length || exporting} aria-busy={exporting} title="导出完整调用链，支持离线搜索和折叠" onClick={exportHtml}><DownloadIcon />{exporting ? "导出中…" : "导出 HTML"}</button>
    {notice && <span className="portable-log-export-notice" role={notice.error ? "alert" : "status"}>{notice.text}</span>}
  </div>;
};

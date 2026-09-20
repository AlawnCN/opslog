import { useRef, useState } from "react";
import { buildAiAnalysisHtml, buildAiAnalysisMarkdown, type AiAnalysisExportFormat } from "../ai-analysis-export";
import { errorMessage, saveAiAnalysisResult, type AiAnalyzeResult } from "../api";
import { AiSparkIcon, CloseIcon, DownloadIcon, HtmlFileIcon, MarkdownFileIcon } from "./Icons";
import { SafeMarkdown } from "./SafeMarkdown";

interface AiLogAnalysisDialogProps {
  logId: string;
  loading: boolean;
  result?: AiAnalyzeResult;
  error?: string;
  onClose: () => void;
  onRetry?: () => void;
}

export const AiLogAnalysisDialog = ({ logId, loading, result, error, onClose, onRetry }: AiLogAnalysisDialogProps) => {
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  const [exportFormat, setExportFormat] = useState<AiAnalysisExportFormat>("md");
  const articleRef = useRef<HTMLElement>(null);

  const exportResult = async () => {
    if (!result || exporting) return;
    setExporting(true);
    setExportStatus("");
    try {
      const contents = exportFormat === "html"
        ? buildAiAnalysisHtml(logId, result, articleRef.current?.innerHTML)
        : buildAiAnalysisMarkdown(logId, result);
      const path = await saveAiAnalysisResult(logId, exportFormat, contents);
      setExportStatus(path ? `已导出至 ${path}` : "分析结果已导出");
    } catch (cause) {
      setExportStatus(`导出失败：${errorMessage(cause)}`);
    } finally {
      setExporting(false);
    }
  };

  return <div className="ai-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="ai-analysis-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-analysis-title" aria-busy={loading} onMouseDown={(event) => event.stopPropagation()}>
      <header><div className="ai-analysis-emblem"><AiSparkIcon /></div><div><span className="eyebrow">AI LOG ANALYSIS</span><h2 id="ai-analysis-title">AI 日志分析</h2>{result && <p>{result.provider} · {result.model} · {(result.durationMs / 1000).toFixed(1)}s{loading ? " · 正在生成" : ""}</p>}</div><div className="ai-analysis-header-actions">{result && !loading && <div className="ai-analysis-export"><button type="button" className="ai-analysis-export-action" title={`导出为 ${exportFormat.toUpperCase()}`} aria-label={`导出 ${exportFormat.toUpperCase()} 分析结果`} aria-busy={exporting} disabled={exporting} onClick={() => void exportResult()}>{exporting ? <span className="button-spinner" aria-hidden="true" /> : <DownloadIcon />}<span>导出</span></button><div className="ai-analysis-formats" role="group" aria-label="导出格式"><button type="button" className={exportFormat === "md" ? "is-active" : undefined} title="Markdown 文件" aria-label="选择 Markdown 格式" aria-pressed={exportFormat === "md"} disabled={exporting} onClick={() => setExportFormat("md")}><MarkdownFileIcon /></button><button type="button" className={exportFormat === "html" ? "is-active" : undefined} title="HTML 文件" aria-label="选择 HTML 格式" aria-pressed={exportFormat === "html"} disabled={exporting} onClick={() => setExportFormat("html")}><HtmlFileIcon /></button></div></div>}<button type="button" title="关闭" aria-label="关闭 AI 日志分析" onClick={onClose}><CloseIcon /></button></div></header>
      <div className="ai-analysis-body">
        {loading && !result && <div className="ai-analysis-loading" role="status"><div aria-hidden="true"><i/><i/><i/></div><strong>正在分析日志</strong><span>正在提取关键链路、异常与标记命中，请稍候…</span></div>}
        {!loading && error && <div className="ai-analysis-error" role="alert"><strong>分析失败</strong><p>{error}</p>{onRetry && <button type="button" onClick={onRetry}>重试</button>}</div>}
        {result && <><div className="ai-analysis-meta"><span>输入 {result.inputCharacters.toLocaleString()} 字符</span>{result.truncated && <b>已智能压缩</b>}{loading && <b className="is-streaming" role="status">正在生成</b>}{exportStatus && <em role="status">{exportStatus}</em>}</div><article ref={articleRef} className={`ai-analysis-markdown${loading ? " is-streaming" : ""}`}><SafeMarkdown source={result.content} imageLabel="模型图片" /></article></>}
      </div>
      <span className="ai-analysis-resize-hint" aria-hidden="true" />
    </section>
  </div>;
};

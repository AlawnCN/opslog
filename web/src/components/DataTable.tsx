import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { useColumnPreferences } from "../column-preferences";
import { MIN_COLUMN_WIDTH, useColumnWidthPreferences } from "../column-width-preferences";
import { keepLoadingFeedbackVisible, MINIMUM_LOADING_FEEDBACK_MS } from "../loading-feedback";
import { displayNairobiTime } from "../time";
import type { LogKind, SearchResponse } from "../types";
import { ColumnSelector } from "./ColumnSelector";
import { DownloadIcon, TextReaderIcon, TraceIcon } from "./Icons";

const LABELS: Record<string, string> = {
  "ecp.txn.timestamp": "时间",
  "ecp.txn.id": "日志 ID",
  "ecp.txn.no": "流水号",
  "ecp.txn.business": "业务 Key",
  "ecp.txn.node": "节点",
  "ecp.txn.service": "交易码",
  "ecp.txn.duration": "耗时",
  "ecp.txn.message.code": "结果码",
  "ecp.txn.message.info": "结果信息",
  "ecp.txn.trace": "Trace ID",
  "ecp.log.timestamp": "时间",
  "ecp.log.application": "应用",
  "ecp.log.level": "级别",
  "ecp.log.file": "文件",
  "ecp.log.thread": "线程",
  "trace.id": "Trace ID",
  "host.name": "主机",
  "@timestamp": "时间",
  message: "日志内容"
};

const timestampFields = new Set(["ecp.txn.timestamp", "ecp.log.timestamp", "@timestamp"]);

const text = (value: unknown): string => {
  if (value == null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const resultTone = (row: Record<string, unknown>): string => {
  const code = text(row["ecp.txn.message.code"]);
  if (code === "—") return "neutral";
  return code.endsWith("00000") ? "success" : "error";
};

interface DataTableProps {
  kind: LogKind;
  result?: SearchResponse;
  loading: boolean;
  queryPerformance?: { durationMs: number; cached: boolean };
  onTransactionLog: (row: Record<string, unknown>) => Promise<void>;
  onReadTransactionLog: (row: Record<string, unknown>) => void;
  onTrace: (row: Record<string, unknown>) => void;
}

export const DataTable = ({ kind, result, loading, queryPerformance, onTransactionLog, onReadTransactionLog, onTrace }: DataTableProps) => {
  const [downloadingRows, setDownloadingRows] = useState<Set<string>>(() => new Set());
  const [draggingColumn, setDraggingColumn] = useState<{ column: string; width: number }>();
  const resizeSession = useRef<{ column: string; startX: number; startWidth: number; width: number } | undefined>(undefined);
  const columns = result?.columns ?? [];
  const rows = result?.rows ?? [];
  const columnPreferences = useColumnPreferences(kind, columns);
  const columnWidths = useColumnWidthPreferences(kind, columns);
  const visibleColumns = columnPreferences.visible;

  useEffect(() => () => document.body.classList.remove("is-resizing-columns"), []);

  const widthOf = (column: string): number => draggingColumn?.column === column ? draggingColumn.width : columnWidths.widthOf(column);
  const widthStyle = (column: string): CSSProperties => {
    const width = widthOf(column);
    return { width, minWidth: width, maxWidth: width };
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>, column: string) => {
    event.preventDefault();
    event.stopPropagation();
    const startWidth = columnWidths.widthOf(column);
    resizeSession.current = { column, startX: event.clientX, startWidth, width: startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-columns");
    setDraggingColumn({ column, width: startWidth });
  };

  const resize = (event: PointerEvent<HTMLButtonElement>) => {
    const session = resizeSession.current;
    if (!session) return;
    const width = Math.max(MIN_COLUMN_WIDTH, Math.min(720, session.startWidth + event.clientX - session.startX));
    session.width = width;
    setDraggingColumn({ column: session.column, width });
  };

  const finishResize = () => {
    const session = resizeSession.current;
    if (!session) return;
    columnWidths.setWidth(session.column, session.width);
    resizeSession.current = undefined;
    document.body.classList.remove("is-resizing-columns");
    setDraggingColumn(undefined);
  };

  const downloadTransactionLog = async (row: Record<string, unknown>, key: string) => {
    if (downloadingRows.has(key)) return;
    setDownloadingRows((current) => new Set(current).add(key));
    const startedAt = performance.now();
    try {
      await onTransactionLog(row);
    } finally {
      await keepLoadingFeedbackVisible(startedAt, MINIMUM_LOADING_FEEDBACK_MS.transactionLogDownload);
      setDownloadingRows((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  if (!result && !loading) {
    return <section className="empty-state"><div className="radar"><span /><span /><i /></div><h2>等待查询条件</h2><p>选择环境和时间范围，输入你已知的业务标识。</p></section>;
  }

  return (
    <section className="results-panel">
      <div className="results-heading">
        <div className="results-heading-copy">
          <span className="eyebrow">SEARCH RESULTS</span>
          <div className="results-heading-main">
            <strong>{loading ? "正在从日志集群读取…" : `本页 ${rows.length} 条记录`}</strong>
            {!loading && queryPerformance && <span className={`query-metric${queryPerformance.cached ? " is-cached" : ""}`} title={queryPerformance.cached ? "本次结果来自当前会话缓存" : "包含 Kibana 查询和 VPN 传输时间"}>{queryPerformance.cached ? "已缓存" : `查询 ${(queryPerformance.durationMs / 1000).toFixed(2)} 秒`}</span>}
          </div>
        </div>
        <div className="results-tools">
          <div className="legend"><span className="ok">成功</span><span className="bad">失败</span></div>
          <ColumnSelector columns={columnPreferences.options} selected={columnPreferences.selected} labels={LABELS} onToggle={columnPreferences.toggle} onReorder={columnPreferences.reorder} onSelectAll={columnPreferences.selectAll} onReset={columnPreferences.reset} />
        </div>
      </div>
      <div className="table-shell" aria-busy={loading}>
        {loading && <div className="loading-line" />}
        <table className={kind === "transaction" ? "has-row-actions" : undefined}>
          <thead><tr>{visibleColumns.map((column) => <th key={column} className={draggingColumn?.column === column ? "is-resizing" : undefined} style={widthStyle(column)}><span className="column-label">{LABELS[column] ?? column}</span><button className="column-resizer" type="button" title="拖拽调整列宽；双击恢复默认宽度" aria-label={`调整 ${LABELS[column] ?? column} 列宽`} onPointerDown={(event) => startResize(event, column)} onPointerMove={resize} onPointerUp={finishResize} onPointerCancel={finishResize} onDoubleClick={() => columnWidths.resetWidth(column)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); columnWidths.setWidth(column, columnWidths.widthOf(column) + (event.key === "ArrowLeft" ? -20 : 20)); } }} /></th>)}{kind === "transaction" && <th>快捷操作</th>}</tr></thead>
          <tbody>
            {rows.map((row, position) => {
              const rowKey = `${text(row["ecp.txn.id"])}-${position}`;
              const downloading = downloadingRows.has(rowKey);
              return <tr key={`${position}-${text(row[columns[0] ?? ""])}`}>
                {visibleColumns.map((column) => {
                  const value = timestampFields.has(column) ? displayNairobiTime(row[column]) : text(row[column]);
                  const tone = column === "ecp.txn.message.code" ? resultTone(row) : "";
                  return <td key={column} style={widthStyle(column)} className={`${tone} ${column === "message" || column.endsWith(".id") ? "mono" : ""}`} title={value}>{column === "ecp.txn.duration" && value !== "—" ? `${value} ms` : value}</td>;
                })}
                {kind === "transaction" && <td className="row-actions"><button className={downloading ? "downloading" : ""} title={downloading ? "正在下载…" : "下载交易日志"} aria-label={downloading ? "正在下载交易日志" : "下载交易日志"} aria-busy={downloading} disabled={downloading} onClick={(event) => { event.stopPropagation(); void downloadTransactionLog(row, rowKey); }}>{downloading ? <span className="button-spinner" aria-hidden="true" /> : <DownloadIcon />}</button><button title="在线浏览交易日志" aria-label="在线浏览交易日志" onClick={(event) => { event.stopPropagation(); onReadTransactionLog(row); }}><TextReaderIcon /></button><button title="查看 Trace" aria-label="查看 Trace" disabled={!row["ecp.txn.trace"]} onClick={(event) => { event.stopPropagation(); onTrace(row); }}><TraceIcon /></button></td>}
              </tr>;
            })}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <div className="no-rows">没有匹配记录，请缩小时间范围或调整条件。</div>}
      </div>
    </section>
  );
};

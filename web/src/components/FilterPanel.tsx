import type { Environment, LogKind, SearchFilters } from "../types";
import { DownloadIcon, SearchIcon } from "./Icons";

interface FilterPanelProps {
  kind: LogKind;
  filters: SearchFilters;
  environment?: Environment;
  loading: boolean;
  selectedRangeDays: number | null;
  onChange: (field: keyof SearchFilters, value: string) => void;
  onSearch: () => void;
  onExport: () => void;
  onRange: (days: number) => void;
}

const Field = ({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) => (
  <label className={`filter-field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>
);

export const FilterPanel = ({ kind, filters, environment, loading, selectedRangeDays, onChange, onSearch, onExport, onRange }: FilterPanelProps) => {
  const input = (field: keyof SearchFilters, placeholder: string, type = "text") => (
    <input
      type={type}
      value={filters[field]}
      placeholder={placeholder}
      onInput={type === "datetime-local" ? (event) => onChange(field, event.currentTarget.value) : undefined}
      onChange={type === "datetime-local" ? undefined : (event) => onChange(field, event.target.value)}
    />
  );
  const indexes = environment
    ? [environment.txnlstIndex, environment.txntrcIndex, environment.applogIndex, environment.apmIndex]
    : [];

  return (
    <section className="filter-panel">
      <div className="filter-heading">
        <div className="filter-heading-title"><span className="eyebrow">QUERY PARAMETERS</span><h1>{kind === "transaction" ? "交易日志检索" : kind === "application" ? "应用服务日志" : kind === "ecp" ? "ECP 服务日志" : "通用日志检索"}</h1></div>
        <i className="filter-heading-divider" aria-hidden="true" />
        <div className="filter-heading-controls">
          <div className="date-range-fields">
            <Field label="开始时间（EAT）">{input("startLocal", "开始时间", "datetime-local")}</Field>
            <Field label="结束时间（EAT）">{input("endLocal", "结束时间", "datetime-local")}</Field>
          </div>
          <div className="range-buttons">
            {[
              { days: 1, label: "24H" },
              { days: 7, label: "7D" },
              { days: 30, label: "30D" },
            ].map(({ days, label }) => (
              <button
                key={days}
                type="button"
                className={selectedRangeDays === days ? "active" : ""}
                aria-pressed={selectedRangeDays === days}
                onClick={() => onRange(days)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="filter-grid">
        {kind === "transaction" && <>
          <Field label="日志 ID">{input("txnId", "支持片段匹配")}</Field>
          <Field label="Trace ID">{input("traceId", "链路标识")}</Field>
          <Field label="流水号">{input("txnNo", "ecp.txn.no")}</Field>
          <Field label="业务 Key">{input("business", "ecp.txn.business")}</Field>
          <Field label="交易码">{input("service", "ecp.txn.service")}</Field>
          <Field label="节点">{input("node", "ecp.txn.node")}</Field>
          <Field label="错误码">{input("messageCode", "message.code")}</Field>
          <Field label="错误信息">{input("messageInfo", "message.info")}</Field>
          <Field label="交易状态"><select value={filters.status} onChange={(event) => onChange("status", event.target.value)}><option value="ALL">全部状态</option><option value="SUCCESS">成功</option><option value="FAIL">失败</option></select></Field>
          <Field label="最小耗时（ms）">{input("minDurationMs", "例如 1000", "number")}</Field>
        </>}

        {(kind === "application" || kind === "ecp" || kind === "generic") && <>
          {kind === "generic" && <Field label="日志索引"><select value={filters.index} onChange={(event) => onChange("index", event.target.value)}>{indexes.map((item) => <option key={item}>{item}</option>)}</select></Field>}
          <Field label="应用名">{input("application", "ecp.log.application")}</Field>
          {kind !== "generic" && <Field label="日志级别">{input("level", "ERROR / WARN / INFO")}</Field>}
          {kind === "ecp" && <Field label="日志文件">{input("file", "ecp.log.file")}</Field>}
          <Field label="关键词" wide>{input("keyword", "跨 message、thread、trace 等规范字段检索")}</Field>
        </>}
      </div>
      <div className="filter-actions">
        <div className="index-hint"><i /> INDEX <code>{kind === "transaction" ? environment?.txnlstIndex : kind === "generic" ? filters.index : environment?.applogIndex}</code></div>
        <div><button className="secondary" onClick={onExport} disabled={loading}><DownloadIcon />导出 CSV</button><button className="primary" onClick={onSearch} disabled={loading}><SearchIcon />{loading ? "查询中…" : "执行查询"}</button></div>
      </div>
    </section>
  );
};

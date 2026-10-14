use crate::local_log_access::application;
pub use crate::local_log_access::{read_transaction, sample_logs};
use crate::local_query_snapshot::snapshot;
use crate::{
    domain::{
        EnvironmentConfig, LogKind, QueryResult, SearchInput, SshApplicationConfig, display_fields,
    },
    local_files::{self, Cancel, ReverseRecords},
    local_log_parser::Parser,
    local_log_rules::{self as parser, Source},
};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

fn sources(app: &SshApplicationConfig) -> Result<Vec<Source>, String> {
    let values = if app.log_sources.is_empty() {
        serde_json::from_str(include_str!("../../shared/file-log-defaults.json"))
            .map_err(|e| format!("默认日志规则无效：{e}"))?
    } else {
        app.log_sources.clone()
    };
    values
        .into_iter()
        .map(|value| serde_json::from_value(value).map_err(|e| format!("日志规则无效：{e}")))
        .collect()
}
fn sort(rows: &mut [Map<String, Value>], kind: LogKind) {
    let key = if kind == LogKind::Transaction {
        "ecp.txn.timestamp"
    } else {
        "@timestamp"
    };
    rows.sort_by(|a, b| {
        let primary = b
            .get(key)
            .and_then(Value::as_str)
            .cmp(&a.get(key).and_then(Value::as_str));
        if kind != LogKind::Transaction {
            return primary;
        }
        primary
            .then_with(|| {
                b.get("ecp.txn.id")
                    .and_then(Value::as_str)
                    .cmp(&a.get("ecp.txn.id").and_then(Value::as_str))
            })
            .then_with(|| {
                b.get("ecp.txn.service")
                    .and_then(Value::as_str)
                    .cmp(&a.get("ecp.txn.service").and_then(Value::as_str))
            })
    });
}
pub async fn search(
    env: &EnvironmentConfig,
    input: &SearchInput,
    export_all: bool,
) -> Result<QueryResult, String> {
    let env = env.clone();
    let input = input.clone();
    local_files::blocking(move |cancel| search_sync(&env, &input, export_all, cancel)).await
}
fn search_sync(
    env: &EnvironmentConfig,
    input: &SearchInput,
    export_all: bool,
    cancel: &Cancel,
) -> Result<QueryResult, String> {
    let app = application(env, input.application.as_deref())?;
    let root = local_files::root(&app.directory)?;
    let shift = parser::offset(env.ssh_log_time_offset.as_deref().unwrap_or("+03:00"))?;
    let (start, end, days) = parser::range(&input.start_time, &input.end_time, shift)?;
    let files = snapshot(env, input, &root, cancel, export_all)?;
    let limit = if export_all {
        20_000
    } else {
        (input.page * input.page_size + 1).min(10_001)
    };
    let mut rules = sources(app)?;
    rules.retain(|source| match input.kind {
        LogKind::Transaction => matches!(source.role.as_str(), "transaction" | "transactionEvent"),
        LogKind::Generic => source.role != "detail",
        _ => source.role == input.kind.as_str(),
    });
    rules.sort_by_key(|source| source.fallback_only);
    let mut rows = Vec::new();
    for source in rules {
        if source.fallback_only && !rows.is_empty() {
            continue;
        }
        let patterns = parser::paths(&source, &days)?;
        let engine = Parser::new(&source).map_err(|error| format!("{}：{error}", source.name))?;
        let mut events: HashMap<String, Map<String, Value>> = HashMap::new();
        let mut matched_files = 0;
        for file in &files {
            local_files::check(cancel)?;
            let mut matched = false;
            for pattern in &patterns {
                if parser::test(pattern, &file.relative)? {
                    matched = true;
                    break;
                }
            }
            if !matched {
                continue;
            }
            if source.file_selection.as_deref() == Some("latest") && matched_files > 0 {
                break;
            }
            matched_files += 1;
            let mut reader = ReverseRecords::new(&root, file, &source.record_end, cancel)?;
            let mut count = 0;
            let mut older = 0;
            let mut boundary_time = None;
            let mut beyond_boundary = 0;
            while let Some(raw) = reader.next()? {
                let Some((time, row)) =
                    engine.parse(&raw, input, shift, &app.name, &file.relative)?
                else {
                    continue;
                };
                if boundary_time.is_some_and(|boundary| time < boundary) {
                    beyond_boundary += 1;
                    if beyond_boundary >= 64 {
                        break;
                    }
                } else {
                    beyond_boundary = 0;
                }
                if time < start {
                    older += 1;
                    if source.ordered && older >= 64 {
                        break;
                    }
                    continue;
                }
                older = 0;
                if time > end {
                    continue;
                }
                if input.kind == LogKind::Transaction && source.role == "transactionEvent" {
                    let id = row
                        .get("ecp.txn.id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if let Some(previous) = events.get_mut(&id) {
                        for (field, value) in &row {
                            if previous
                                .get(field)
                                .is_none_or(|v| v.as_str() == Some("") || v.is_null())
                            {
                                previous.insert(field.clone(), value.clone());
                            }
                        }
                        let duration = previous
                            .get("ecp.txn.duration")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0)
                            .max(
                                row.get("ecp.txn.duration")
                                    .and_then(Value::as_f64)
                                    .unwrap_or(0.0),
                            );
                        previous.insert("ecp.txn.duration".into(), json!(duration));
                    } else {
                        events.insert(id, row);
                        if events.len() > 100_000 {
                            return Err("交易事件超过 100000，请缩小时间范围".into());
                        }
                    }
                    continue;
                }
                if !engine.matches(&row, input)? {
                    continue;
                }
                rows.push(row);
                count += 1;
                if source.ordered && count >= limit && boundary_time.is_none() {
                    boundary_time = Some(time);
                }
                if rows.len() > limit * 2 {
                    sort(&mut rows, input.kind);
                    rows.truncate(limit);
                }
            }
        }
        for row in events.into_values() {
            if engine.matches(&row, input)? {
                rows.push(row);
            }
        }
    }
    sort(&mut rows, input.kind);
    rows.truncate(limit);
    Ok(QueryResult {
        columns: display_fields(input.kind)
            .iter()
            .map(|s| s.to_string())
            .collect(),
        rows,
        warnings: Vec::new(),
    })
}

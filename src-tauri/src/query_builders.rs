use crate::domain::{EnvironmentConfig, LogKind, SearchInput, SearchStatus, display_fields};

const MAX_PAGE_DEPTH: usize = 10_000;

fn literal(value: &str) -> String {
    value
        .trim()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
}

fn index(value: &str) -> Result<&str, String> {
    let allowed = value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ',' | '*' | '-')
    });
    if !allowed || value.is_empty() {
        return Err("索引名称包含不允许的字符".to_string());
    }
    Ok(value)
}

fn time_range(field: &str, input: &SearchInput) -> String {
    format!(
        "{field} >= \"{}\" AND {field} < \"{}\"",
        literal(&input.start_time),
        literal(&input.end_time)
    )
}

fn add_like(conditions: &mut Vec<String>, field: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        conditions.push(format!("{field} LIKE \"*{}*\"", literal(value)));
    }
}

fn add_exact_or_like(
    conditions: &mut Vec<String>,
    field: &str,
    value: Option<&str>,
    looks_complete: fn(&str) -> bool,
) {
    let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
        return;
    };
    let value = value.trim();
    if looks_complete(value) {
        conditions.push(format!("{field} == \"{}\"", literal(value)));
        return;
    }
    conditions.push(format!("{field} LIKE \"*{}*\"", literal(value)));
}

fn full_transaction_id(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    value.len() >= 24
        && [".p_", ".u_", ".s_", ".d_"]
            .iter()
            .any(|marker| normalized.contains(marker))
}

fn full_trace_id(value: &str) -> bool {
    (16..=64).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn resolve_index<'a>(
    input: &'a SearchInput,
    environment: &'a EnvironmentConfig,
) -> Result<&'a str, String> {
    match input.kind {
        LogKind::Transaction => index(&environment.txnlst_index),
        LogKind::Application | LogKind::Ecp => index(&environment.applog_index),
        LogKind::Generic => {
            let selected = input
                .index
                .as_deref()
                .ok_or_else(|| "通用日志必须选择索引".to_string())?;
            let allowed = [
                environment.txnlst_index.as_str(),
                environment.txntrc_index.as_str(),
                environment.applog_index.as_str(),
                environment.apm_index.as_deref().unwrap_or("traces-apm*"),
            ];
            if !allowed.contains(&selected) {
                return Err("该索引未在当前环境中配置".to_string());
            }
            index(selected)
        }
    }
}

fn transaction_conditions(input: &SearchInput) -> Vec<String> {
    // UAT leaves ecp.txn.timestamp empty on part of the transaction stream.
    // The legacy Java client filters this log type by the canonical ingest time.
    let mut conditions = vec![time_range("@timestamp", input)];
    add_exact_or_like(
        &mut conditions,
        "ecp.txn.id",
        input.txn_id.as_deref(),
        full_transaction_id,
    );
    add_exact_or_like(
        &mut conditions,
        "ecp.txn.trace",
        input.trace_id.as_deref(),
        full_trace_id,
    );
    add_like(&mut conditions, "ecp.txn.no", input.txn_no.as_deref());
    add_like(
        &mut conditions,
        "ecp.txn.business",
        input.business.as_deref(),
    );
    add_like(&mut conditions, "ecp.txn.service", input.service.as_deref());
    add_like(
        &mut conditions,
        "ecp.txn.message.code",
        input.message_code.as_deref(),
    );
    add_like(
        &mut conditions,
        "ecp.txn.message.info",
        input.message_info.as_deref(),
    );
    add_like(&mut conditions, "ecp.txn.node", input.node.as_deref());

    match input.status {
        Some(SearchStatus::Success) => {
            conditions.push("RIGHT(ecp.txn.message.code, 5) == \"00000\"".to_string());
        }
        Some(SearchStatus::Fail) => {
            conditions.push("RIGHT(ecp.txn.message.code, 5) != \"00000\"".to_string());
        }
        _ => {}
    }
    if let Some(duration) = input.min_duration_ms.filter(|duration| *duration > 0) {
        conditions.push(format!("TO_INTEGER(ecp.txn.duration) >= {duration}"));
    }
    conditions
}

fn log_conditions(input: &SearchInput) -> Vec<String> {
    let timestamp = if input.kind == LogKind::Generic {
        "@timestamp"
    } else {
        "ecp.log.timestamp"
    };
    let mut conditions = vec![time_range(timestamp, input)];
    add_like(
        &mut conditions,
        "ecp.log.application",
        input.application.as_deref(),
    );
    add_like(&mut conditions, "ecp.log.level", input.level.as_deref());
    if input.kind == LogKind::Ecp {
        add_like(&mut conditions, "ecp.log.file", input.file.as_deref());
    }

    if let Some(keyword) = input
        .keyword
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let fields: &[&str] = if input.kind == LogKind::Generic {
            &[
                "message",
                "ecp.log.application",
                "ecp.log.thread",
                "trace.id",
            ]
        } else {
            &["message", "ecp.log.thread", "trace.id", "host.name"]
        };
        let keyword = literal(keyword);
        let parts = fields
            .iter()
            .map(|field| format!("{field} LIKE \"*{keyword}*\""))
            .collect::<Vec<_>>();
        conditions.push(format!("({})", parts.join(" OR ")));
    }
    conditions
}

pub fn build_search_query(
    input: &SearchInput,
    environment: &EnvironmentConfig,
    export_all: bool,
) -> Result<String, String> {
    let source = resolve_index(input, environment)?;
    let conditions = if input.kind == LogKind::Transaction {
        transaction_conditions(input)
    } else {
        log_conditions(input)
    };
    let timestamp = match input.kind {
        LogKind::Generic => "@timestamp",
        _ => "ecp.log.timestamp",
    };
    let limit = if export_all {
        20_000
    } else {
        (input.page * input.page_size).min(MAX_PAGE_DEPTH)
    };
    let keep = display_fields(input.kind).join(", ");
    if input.kind == LogKind::Transaction {
        return Ok(format!(
            "FROM {source} | WHERE {} | SORT @timestamp DESC | LIMIT {limit} | EVAL ecp.txn.timestamp = COALESCE(ecp.txn.timestamp, @timestamp) | KEEP {keep}",
            conditions.join(" AND ")
        ));
    }

    Ok(format!(
        "FROM {source} | WHERE {} | SORT {timestamp} DESC | LIMIT {limit} | KEEP {keep}",
        conditions.join(" AND ")
    ))
}

pub fn build_trc_query(
    environment: &EnvironmentConfig,
    log_id: &str,
    start_time: &str,
    end_time: &str,
) -> Result<String, String> {
    let source = index(&environment.txntrc_index)?;
    Ok(format!(
        "FROM {source} | WHERE @timestamp >= \"{}\" AND @timestamp < \"{}\" AND ecp.log.id == \"{}\" | SORT ecp.log.timestamp ASC | LIMIT 20000 | KEEP ecp.log.timestamp, ecp.log.application, ecp.log.level, message",
        literal(start_time),
        literal(end_time),
        literal(log_id)
    ))
}

pub fn build_trace_query(
    environment: &EnvironmentConfig,
    trace_id: &str,
    start_time: &str,
    end_time: &str,
) -> Result<String, String> {
    let source = index(environment.apm_index.as_deref().unwrap_or("traces-apm*"))?;
    Ok(format!(
        "FROM {source} | WHERE trace.id == \"{}\" AND @timestamp >= \"{}\" AND @timestamp < \"{}\" | SORT @timestamp ASC | LIMIT 20000 | KEEP @timestamp, trace.id, span.*, transaction.*, processor.event, service.*",
        literal(trace_id),
        literal(start_time),
        literal(end_time)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment() -> EnvironmentConfig {
        EnvironmentConfig {
            name: "test".into(),
            kibana_url: "https://kibana.example.test".into(),
            username: "reader".into(),
            password: "secret".into(),
            txnlst_index: "logs-ecp.txn.lst*".into(),
            txntrc_index: "logs-ecp.txn.trc*".into(),
            applog_index: "logs-ecp.log.*".into(),
            apm_index: None,
            allow_insecure_tls: None,
        }
    }

    fn input() -> SearchInput {
        SearchInput {
            environment: "test".into(),
            kind: LogKind::Transaction,
            start_time: "2026-09-01T00:00:00.000Z".into(),
            end_time: "2026-09-02T00:00:00.000Z".into(),
            page: 2,
            page_size: 50,
            index: None,
            txn_id: Some("approve-\"credit".into()),
            trace_id: None,
            txn_no: None,
            business: None,
            service: None,
            message_code: None,
            message_info: None,
            status: Some(SearchStatus::Fail),
            min_duration_ms: Some(120),
            node: None,
            keyword: None,
            level: None,
            file: None,
            application: None,
        }
    }

    #[test]
    fn preserves_transaction_rules() {
        let query = build_search_query(&input(), &environment(), false).unwrap();
        assert!(query.starts_with("FROM logs-ecp.txn.lst*"));
        assert!(query.contains("ecp.txn.id LIKE \"*approve-\\\"credit*\""));
        assert!(query.contains("RIGHT(ecp.txn.message.code, 5) != \"00000\""));
        assert!(query.contains("TO_INTEGER(ecp.txn.duration) >= 120"));
        assert!(query.contains("@timestamp >= \"2026-09-01T00:00:00.000Z\""));
        assert!(query.contains("EVAL ecp.txn.timestamp = COALESCE(ecp.txn.timestamp, @timestamp)"));
        assert!(query.contains("SORT @timestamp DESC | LIMIT 100 | EVAL"));
        assert!(query.contains("| KEEP ecp.txn.timestamp"));
    }

    #[test]
    fn uses_exact_matching_for_complete_identifiers() {
        let mut input = input();
        input.txn_id = Some("approve-trsFundTransferbui.u_0_7809041716470000000003".into());
        input.trace_id = Some("92d406f1f29331e8d0f273ef9faebc35".into());

        let query = build_search_query(&input, &environment(), false).unwrap();
        assert!(
            query.contains(
                "ecp.txn.id == \"approve-trsFundTransferbui.u_0_7809041716470000000003\""
            )
        );
        assert!(query.contains("ecp.txn.trace == \"92d406f1f29331e8d0f273ef9faebc35\""));
    }

    #[test]
    fn rejects_unconfigured_generic_index() {
        let mut input = input();
        input.kind = LogKind::Generic;
        input.index = Some("secrets-*".into());
        assert_eq!(
            build_search_query(&input, &environment(), false).unwrap_err(),
            "该索引未在当前环境中配置"
        );
    }

    #[test]
    fn limits_trace_payload_to_rendered_fields() {
        let query = build_trace_query(
            &environment(),
            "92d406f1f29331e8d0f273ef9faebc35",
            "2026-09-01T00:00:00.000Z",
            "2026-09-02T00:00:00.000Z",
        )
        .unwrap();
        assert!(query.contains(
            "LIMIT 20000 | KEEP @timestamp, trace.id, span.*, transaction.*, processor.event, service.*"
        ));
    }
}

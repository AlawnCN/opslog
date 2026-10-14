use crate::domain::{LogKind, SearchInput, SearchStatus};
use crate::local_log_rules::{Source, compile, split_fields, test};
use chrono::{DateTime, Datelike, Duration, NaiveDateTime, SecondsFormat, Utc};
use fancy_regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub struct Parser {
    source: Source,
    extractors: HashMap<String, Regex>,
    pub success: Regex,
}
impl Parser {
    pub fn new(source: &Source) -> Result<Self, String> {
        let mut extractors = HashMap::new();
        for (key, field) in &source.fields {
            if let Some(pattern) = &field.regex {
                extractors.insert(key.clone(), compile(pattern)?);
            }
        }
        Ok(Self {
            source: source.clone(),
            extractors,
            success: compile(&source.success_pattern)?,
        })
    }
    pub fn parse(
        &self,
        raw: &str,
        input: &SearchInput,
        shift: i64,
        app: &str,
        file: &str,
    ) -> Result<Option<(i64, Map<String, Value>)>, String> {
        let fields = split_fields(raw, &self.source.delimiter);
        let mut values = HashMap::new();
        for (key, field) in &self.source.fields {
            let value = if let Some(regex) = self.extractors.get(key) {
                regex
                    .captures(raw)
                    .map_err(|e| e.to_string())?
                    .and_then(|captures| captures.get(1).map(|m| m.as_str().to_string()))
                    .unwrap_or_default()
            } else {
                field
                    .index
                    .and_then(|i| fields.get(i))
                    .cloned()
                    .unwrap_or_default()
            };
            values.insert(key.as_str(), value.trim().to_string());
        }
        let value = |key: &str| values.get(key).map(String::as_str).unwrap_or("");
        let normalized = value("timestamp").replace(',', ".");
        let parsed = if self.source.timestamp_style == "full" {
            NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|v| v.and_utc().timestamp_millis() - shift)
        } else {
            let end = DateTime::parse_from_rfc3339(&input.end_time)
                .map_err(|e| e.to_string())?
                .with_timezone(&Utc)
                + Duration::milliseconds(shift);
            (end.year() - 1..=end.year() + 1)
                .filter_map(|year| {
                    NaiveDateTime::parse_from_str(
                        &format!("{year}-{normalized}"),
                        "%Y-%m-%d %H:%M:%S%.f",
                    )
                    .ok()
                    .map(|v| v.and_utc().timestamp_millis() - shift)
                })
                .min_by_key(|time| (time - (end.timestamp_millis() - shift)).abs())
        };
        let Some(time) = parsed else { return Ok(None) };
        let timestamp = DateTime::from_timestamp_millis(time)
            .unwrap()
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let mut row = Map::new();
        if input.kind == LogKind::Transaction {
            let mut id = value("logId").to_string();
            if id.is_empty() {
                return Ok(None);
            }
            if self.source.strip_async_suffix {
                if let Some((base, suffix)) = id.rsplit_once('-') {
                    if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
                        id = base.into();
                    }
                }
            }
            row.insert("ecp.txn.id".into(), json!(id));
            row.insert("ecp.txn.timestamp".into(), json!(timestamp));
            for (field, key) in [
                ("no", "txnNo"),
                ("business", "business"),
                ("service", "service"),
                ("node", "node"),
                ("src.node.id", "sourceNode"),
                ("tenant", "tenant"),
                ("trace", "traceId"),
                ("message.code", "messageCode"),
                ("message.info", "messageInfo"),
            ] {
                row.insert(format!("ecp.txn.{field}"), json!(value(key)));
            }
            row.insert(
                "ecp.txn.duration".into(),
                json!(value("duration").parse::<f64>().unwrap_or(0.0)),
            );
            row.insert("ecp.txn.server".into(), json!("Local"));
        } else {
            row.insert("ecp.log.timestamp".into(), json!(timestamp));
            row.insert("@timestamp".into(), json!(timestamp));
            row.insert(
                "ecp.log.application".into(),
                json!(if value("node").is_empty() {
                    app
                } else {
                    value("node")
                }),
            );
            for (field, key) in [
                ("ecp.log.level", "level"),
                ("ecp.log.thread", "thread"),
                ("trace.id", "traceId"),
            ] {
                row.insert(field.into(), json!(value(key)));
            }
            row.insert("ecp.log.file".into(), json!(file));
            row.insert(
                "message".into(),
                json!(if value("message").is_empty() {
                    raw
                } else {
                    value("message")
                }),
            );
            row.insert("host.name".into(), json!("Local"));
        }
        row.insert("opslog.source.application".into(), json!(app));
        Ok(Some((time, row)))
    }
    pub fn matches(&self, row: &Map<String, Value>, input: &SearchInput) -> Result<bool, String> {
        let includes = |field: &str, filter: Option<&str>| {
            filter.is_none_or(|filter| {
                row.get(field)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .contains(filter.trim())
            })
        };
        if input.kind != LogKind::Transaction {
            return Ok(includes("ecp.log.level", input.level.as_deref())
                && includes("ecp.log.file", input.file.as_deref())
                && includes("message", input.keyword.as_deref()));
        }
        for (field, filter) in [
            ("id", &input.txn_id),
            ("no", &input.txn_no),
            ("trace", &input.trace_id),
            ("business", &input.business),
            ("service", &input.service),
            ("node", &input.node),
            ("message.code", &input.message_code),
            ("message.info", &input.message_info),
        ] {
            if !includes(&format!("ecp.txn.{field}"), filter.as_deref()) {
                return Ok(false);
            }
        }
        let code = row
            .get("ecp.txn.message.code")
            .and_then(Value::as_str)
            .unwrap_or("");
        let success = test(&self.success, code)?;
        if matches!(input.status, Some(SearchStatus::Success)) && (code.is_empty() || !success)
            || matches!(input.status, Some(SearchStatus::Fail)) && (code.is_empty() || success)
        {
            return Ok(false);
        }
        Ok(row
            .get("ecp.txn.duration")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            >= input.min_duration_ms.unwrap_or(0) as f64)
    }
}

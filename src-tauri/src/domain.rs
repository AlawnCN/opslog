use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogKind {
    Transaction,
    Application,
    Ecp,
    Generic,
}

impl LogKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transaction => "transaction",
            Self::Application => "application",
            Self::Ecp => "ecp",
            Self::Generic => "generic",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SearchStatus {
    All,
    Success,
    Fail,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvironmentSource {
    #[default]
    Elk,
    Ssh,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SshAuthentication {
    SshConfig,
    Password,
    PrivateKey,
}

impl Default for SshAuthentication {
    fn default() -> Self {
        Self::SshConfig
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshServerConfig {
    pub name: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub username: Option<String>,
    #[serde(default)]
    pub authentication: SshAuthentication,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub host_key_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshApplicationConfig {
    pub name: String,
    pub directory: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub log_sources: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub analysis_notes: Vec<String>,
}

impl SshApplicationConfig {
    pub fn validate_log_sources(&self) -> Result<(), String> {
        let invalid = || format!("应用 {} 的日志解析规则无效", self.name);
        if self.log_sources.len() > 12 || self.analysis_notes.len() > 30 { return Err(invalid()); }
        for source in &self.log_sources {
            if !source["fileSelection"].is_null() && !["all", "latest"].contains(&source["fileSelection"].as_str().unwrap_or("")) { return Err(invalid()); }
            if !source["fallbackOnly"].is_null() && !source["fallbackOnly"].is_boolean() { return Err(invalid()); }
            let role = source["role"].as_str().ok_or_else(invalid)?;
            if !["transaction", "transactionEvent", "application", "ecp", "detail"].contains(&role)
                || !["|", " §§ ", ""].contains(&source["delimiter"].as_str().unwrap_or("invalid"))
                || !["newline", " §§ logEnd"].contains(&source["recordEnd"].as_str().unwrap_or(""))
                || !["full", "month-day"].contains(&source["timestampStyle"].as_str().unwrap_or(""))
                || source["ordered"].as_bool().is_none() { return Err(invalid()); }
            let paths = source["paths"].as_array().ok_or_else(invalid)?;
            if paths.is_empty() || paths.len() > 8 { return Err(invalid()); }
            for path in paths {
                let path = path.as_str().ok_or_else(invalid)?;
                if source["pathMode"].as_str() == Some("regex") {
                    let relative = path.strip_prefix('^').unwrap_or(path);
                    if path.is_empty() || path.len()>240 || relative.starts_with('/') || relative.split('/').any(|part|part=="..") || path.chars().any(|c|c.is_control()) || path.contains("(?{") || path.contains("(??{") { return Err(invalid()); }
                    continue;
                }
                if !source["pathMode"].is_null() && source["pathMode"].as_str() != Some("glob") { return Err(invalid()); }
                if path.is_empty() || path.len() > 240 || path.starts_with('/') || path.split('/').any(|part|part=="..")
                    || path.replace("{day}", "").contains(['{', '}'])
                    || !path.chars().all(|c| c.is_ascii_alphanumeric() || "_.*?{}/-".contains(c)) { return Err(invalid()); }
            }
            let fields = source["fields"].as_object().ok_or_else(invalid)?;
            if !fields.contains_key("timestamp") || (["transaction", "transactionEvent", "detail"].contains(&role) && !fields.contains_key("logId")) { return Err(invalid()); }
            for (key, mapping) in fields {
                if !["timestamp", "logId", "txnNo", "business", "service", "node", "sourceNode", "messageCode", "messageInfo", "duration", "tenant", "level", "thread", "message", "traceId"].contains(&key.as_str()) { return Err(invalid()); }
                let index = mapping["index"].as_u64(); let regex = mapping["regex"].as_str();
                if index.is_none() && regex.is_none() || index.is_some_and(|v|v>100) || regex.is_some_and(|v|v.len()>500 || v.contains("(?{") || v.contains("(??{")) { return Err(invalid()); }
            }
            let pattern = source["successPattern"].as_str().unwrap_or("00000$");
            if pattern.len()>200 || pattern.contains("(?{") || pattern.contains("(??{") { return Err(invalid()); }
        }
        Ok(())
    }
}

#[cfg(test)]
mod configurable_path_tests {
    use super::SshApplicationConfig;
    use serde_json::json;

    #[test]
    fn accepts_custom_relative_directories_and_rejects_traversal() {
        let mut application = SshApplicationConfig {
            name: "cte".into(), directory: "/apps/cte".into(), analysis_notes: vec![],
            log_sources: vec![json!({
                "role": "application", "delimiter": "", "recordEnd": "newline",
                "timestampStyle": "full", "ordered": true, "pathMode": "regex",
                "paths": ["^filebeat/trc/txn_.*\\.lst$", "^archive/\\d{4}/[^/]+/.*$", "^app\\.log$"],
                "fields": {"timestamp": {"regex": "^(.*)$"}}
            })],
        };
        assert!(application.validate_log_sources().is_ok());
        for selection in ["all", "latest"] {
            application.log_sources[0]["fileSelection"] = json!(selection);
            assert!(application.validate_log_sources().is_ok());
        }
        application.log_sources[0]["fileSelection"] = json!("invalid");
        assert!(application.validate_log_sources().is_err());
        application.log_sources[0]["fileSelection"] = json!("latest");
        for path in ["^../.*$", "^/etc/.*$"] {
            application.log_sources[0]["paths"] = json!([path]);
            assert!(application.validate_log_sources().is_err());
        }
        application.log_sources[0]["pathMode"] = json!("glob");
        application.log_sources[0]["paths"] = json!(["filebeat/trc/*.lst"]);
        assert!(application.validate_log_sources().is_ok());
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentConfig {
    pub name: String,
    #[serde(default)]
    pub source_type: EnvironmentSource,
    #[serde(default)]
    pub kibana_url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub txnlst_index: String,
    #[serde(default)]
    pub txntrc_index: String,
    #[serde(default)]
    pub applog_index: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apm_index: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_insecure_tls: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_base_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ssh_applications: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_connect_timeout_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_log_time_offset: Option<String>,
    #[serde(default = "default_true", skip_serializing_if = "Option::is_none")]
    pub ssh_auto_detect_time_zone: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ssh_servers: Vec<SshServerConfig>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ssh_monitored_applications: Vec<SshApplicationConfig>,
}

fn default_true() -> Option<bool> {
    Some(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEnvironment {
    pub name: String,
    pub source_type: EnvironmentSource,
    pub kibana_url: String,
    pub txnlst_index: String,
    pub txntrc_index: String,
    pub applog_index: String,
    pub apm_index: String,
    pub insecure_tls: bool,
    pub ssh_applications: Vec<String>,
    pub time_zone: String,
    pub time_zone_offset: String,
    pub time_zone_source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
    pub session_id: Option<String>,
    pub environment: String,
    pub kind: LogKind,
    pub start_time: String,
    pub end_time: String,
    pub page: usize,
    pub page_size: usize,
    pub index: Option<String>,
    pub txn_id: Option<String>,
    pub trace_id: Option<String>,
    pub txn_no: Option<String>,
    pub business: Option<String>,
    pub service: Option<String>,
    pub message_code: Option<String>,
    pub message_info: Option<String>,
    pub status: Option<SearchStatus>,
    pub min_duration_ms: Option<u64>,
    pub node: Option<String>,
    pub keyword: Option<String>,
    pub level: Option<String>,
    pub file: Option<String>,
    pub application: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInput {
    pub environment: String,
    pub id: String,
    pub start_time: String,
    pub end_time: String,
    pub application: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTransactionLogInput {
    pub id: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCustomMarkersInput {
    pub name: String,
    pub contents: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePortableLogInput {
    pub name: String,
    pub contents: String,
}

#[derive(Debug)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Map<String, Value>>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub columns: Vec<String>,
    pub rows: Vec<Map<String, Value>>,
    pub warnings: Vec<String>,
    pub page: usize,
    pub page_size: usize,
    pub has_more: bool,
    pub truncated: bool,
    pub query_time: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
}

pub fn display_fields(kind: LogKind) -> &'static [&'static str] {
    match kind {
        LogKind::Transaction => &[
            "ecp.txn.timestamp",
            "ecp.txn.id",
            "ecp.txn.no",
            "ecp.txn.business",
            "ecp.txn.node",
            "ecp.txn.service",
            "ecp.txn.server",
            "ecp.txn.duration",
            "ecp.txn.message.code",
            "ecp.txn.message.info",
            "ecp.txn.trace",
            "ecp.txn.tenant",
            "ecp.txn.src.node.id",
        ],
        LogKind::Application => &[
            "ecp.log.timestamp",
            "ecp.log.application",
            "ecp.log.level",
            "ecp.log.thread",
            "message",
            "trace.id",
            "host.name",
        ],
        LogKind::Ecp => &[
            "ecp.log.timestamp",
            "ecp.log.application",
            "ecp.log.level",
            "ecp.log.file",
            "ecp.log.thread",
            "message",
            "trace.id",
            "host.name",
        ],
        LogKind::Generic => &[
            "@timestamp",
            "ecp.log.application",
            "ecp.log.level",
            "ecp.log.thread",
            "message",
            "trace.id",
            "host.name",
        ],
    }
}

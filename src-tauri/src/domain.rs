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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshApplicationConfig {
    pub name: String,
    pub directory: String,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub columns: Vec<String>,
    pub rows: Vec<Map<String, Value>>,
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

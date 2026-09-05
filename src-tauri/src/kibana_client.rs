use std::{error::Error as StdError, time::Duration};

use futures_util::StreamExt;
use reqwest::Client;
use reqwest::header::CONTENT_TYPE;
use serde_json::{Map, Value, json};
use tokio::sync::OnceCell;

use crate::domain::{EnvironmentConfig, QueryResult};

const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
static SECURE_CLIENT: OnceCell<Client> = OnceCell::const_new();
static INSECURE_CLIENT: OnceCell<Client> = OnceCell::const_new();

fn build_client(allow_insecure_tls: bool) -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(300))
        .pool_idle_timeout(Duration::from_secs(120))
        .pool_max_idle_per_host(8)
        .tcp_keepalive(Duration::from_secs(30))
        .danger_accept_invalid_certs(allow_insecure_tls)
        .build()
        .map_err(|error| format!("无法初始化 Kibana 客户端：{error}"))
}

async fn shared_client(allow_insecure_tls: bool) -> Result<&'static Client, String> {
    let cell = if allow_insecure_tls {
        &INSECURE_CLIENT
    } else {
        &SECURE_CLIENT
    };
    cell.get_or_try_init(|| async { build_client(allow_insecure_tls) })
        .await
}

fn request_error(error: &reqwest::Error) -> String {
    let mut messages = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        let message = cause.to_string();
        if !messages.contains(&message) {
            messages.push(message);
        }
        source = cause.source();
    }
    messages.join("；")
}

fn normalize_result(payload: Value) -> QueryResult {
    let raw = payload.get("rawResponse").unwrap_or(&payload);
    let columns = raw
        .get("columns")
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .map(|column| {
                    column
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let rows = raw
        .get("values")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| row_from_value(&columns, value))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    QueryResult { columns, rows }
}

fn row_from_value(columns: &[String], value: &Value) -> Map<String, Value> {
    let cells = value.as_array();
    columns
        .iter()
        .enumerate()
        .map(|(position, column)| {
            let value = cells
                .and_then(|items| items.get(position))
                .cloned()
                .unwrap_or(Value::Null);
            (column.clone(), value)
        })
        .collect()
}

async fn response_bytes(response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取 Kibana 响应失败：{error}"))?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Kibana 响应超过 64 MB 安全上限".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub async fn run_esql(
    environment: &EnvironmentConfig,
    query: &str,
    timeout_seconds: u64,
) -> Result<QueryResult, String> {
    let client = shared_client(environment.allow_insecure_tls.unwrap_or(false)).await?;
    let url = format!(
        "{}/internal/search/esql",
        environment.kibana_url.trim_end_matches('/')
    );
    let response = client
        .post(url)
        .timeout(Duration::from_secs(timeout_seconds))
        .basic_auth(&environment.username, Some(&environment.password))
        .header(CONTENT_TYPE, "application/json")
        .header("kbn-xsrf", "reporting")
        .json(&json!({ "params": { "query": query } }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                format!("Kibana 查询超过 {timeout_seconds} 秒")
            } else {
                format!("无法连接 Kibana：{}", request_error(&error))
            }
        })?;
    let status = response.status();
    let bytes = response_bytes(response).await?;
    if !status.is_success() {
        let message = String::from_utf8_lossy(&bytes)
            .chars()
            .take(500)
            .collect::<String>();
        return Err(format!("Kibana 返回 HTTP {}: {message}", status.as_u16()));
    }
    let payload = serde_json::from_slice(&bytes)
        .map_err(|error| format!("无法解析 Kibana ES|QL 响应：{error}"))?;
    Ok(normalize_result(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_raw_response() {
        let result = normalize_result(json!({
            "rawResponse": {
                "columns": [{"name": "code"}, {"name": "duration"}],
                "values": [["OK", 12], ["FAIL", null]]
            }
        }));
        assert_eq!(result.columns, vec!["code", "duration"]);
        assert_eq!(result.rows[0]["duration"], 12);
        assert_eq!(result.rows[1]["code"], "FAIL");
    }
}

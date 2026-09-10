use std::{
    net::{IpAddr, Ipv4Addr},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Request, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use local_ip_address::list_afinet_netifas;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State as TauriState};
use tokio::{
    net::TcpListener,
    sync::{Mutex, Semaphore},
    task::JoinHandle,
};

use crate::{
    commands,
    domain::{DownloadInput, SearchInput, display_fields},
    environment_store, export_files,
    kibana_client::run_esql,
    query_builders::build_search_query,
};

const MAX_CONCURRENT_QUERIES: usize = 4;
const REQUEST_BODY_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanShareStatus {
    enabled: bool,
    url: Option<String>,
    port: Option<u16>,
}

struct LanRuntime {
    url: String,
    port: u16,
    task: JoinHandle<()>,
}

#[derive(Default)]
pub struct LanShareManager {
    runtime: Mutex<Option<LanRuntime>>,
}

impl Drop for LanShareManager {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.get_mut().take() {
            runtime.task.abort();
        }
    }
}

#[derive(Clone)]
struct LanApiState {
    app: AppHandle,
    query_slots: Arc<Semaphore>,
}

fn disabled_status() -> LanShareStatus {
    LanShareStatus {
        enabled: false,
        url: None,
        port: None,
    }
}

fn interface_score(name: &str, address: Ipv4Addr) -> i32 {
    let name = name.to_ascii_lowercase();
    let mut score = if address.octets()[0..2] == [192, 168] {
        30
    } else if address.octets()[0] == 172 && (16..=31).contains(&address.octets()[1]) {
        20
    } else {
        10
    };
    if ["wi-fi", "wifi", "wlan", "ethernet", "eth", "en0", "en1"]
        .iter()
        .any(|marker| name.contains(marker))
    {
        score += 100;
    }
    if ["utun", "tun", "tap", "vpn", "loopback"]
        .iter()
        .any(|marker| name.contains(marker))
    {
        score -= 100;
    }
    score
}

fn preferred_lan_address() -> Result<Ipv4Addr, String> {
    let mut candidates = list_afinet_netifas()
        .map_err(|error| format!("无法读取本机网络地址：{error}"))?
        .into_iter()
        .filter_map(|(name, address)| match address {
            IpAddr::V4(address) if address.is_private() && !address.is_loopback() => {
                Some((interface_score(&name, address), name, address))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    candidates
        .first()
        .map(|(_, _, address)| *address)
        .ok_or_else(|| "未找到可用于局域网分享的 IPv4 地址".to_string())
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"),
    );
    response
}

fn api_error(message: String) -> Response {
    let client_error = message.starts_with("未知环境")
        || message.starts_with("环境配置")
        || message.contains("索引")
        || message.contains("不合法")
        || message.contains("不完整");
    (
        if client_error {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::BAD_GATEWAY
        },
        Json(json!({ "error": message })),
    )
        .into_response()
}

async fn query_permit(state: &LanApiState) -> Result<tokio::sync::OwnedSemaphorePermit, Response> {
    state
        .query_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| api_error("局域网查询服务已停止".to_string()))
}

async fn runtime_info() -> Json<serde_json::Value> {
    Json(json!({ "mode": "lan", "canImportConfig": false }))
}

async fn environments(State(state): State<LanApiState>) -> Response {
    match commands::load_environments(state.app).await {
        Ok(environments) => Json(environments).into_response(),
        Err(error) => api_error(error),
    }
}

async fn search(State(state): State<LanApiState>, Json(input): Json<SearchInput>) -> Response {
    let Ok(_permit) = query_permit(&state).await else {
        return api_error("局域网查询服务已停止".to_string());
    };
    match commands::search_logs(state.app, input).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => api_error(error),
    }
}

async fn export(State(state): State<LanApiState>, Json(input): Json<SearchInput>) -> Response {
    if let Err(error) = commands::validate_search(&input) {
        return api_error(error);
    }
    let Ok(_permit) = query_permit(&state).await else {
        return api_error("局域网查询服务已停止".to_string());
    };
    let environment = match environment_store::find(&state.app, &input.environment).await {
        Ok(environment) => environment,
        Err(error) => return api_error(error),
    };
    let query = match build_search_query(&input, &environment, true) {
        Ok(query) => query,
        Err(error) => return api_error(error),
    };
    let result = match run_esql(&environment, &query, 300).await {
        Ok(result) => result,
        Err(error) => return api_error(error),
    };
    let columns = display_fields(input.kind)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let filename = format!(
        "{}-{}.csv",
        input.kind.as_str(),
        Utc::now().format("%Y%m%dT%H%M%S%3fZ")
    );
    download_response(
        "text/csv; charset=utf-8",
        &filename,
        export_files::csv(&columns, &result.rows).into_bytes(),
    )
}

async fn transaction_log(
    State(state): State<LanApiState>,
    Json(input): Json<DownloadInput>,
) -> Response {
    let Ok(_permit) = query_permit(&state).await else {
        return api_error("局域网查询服务已停止".to_string());
    };
    match commands::read_transaction_log(state.app, input.clone()).await {
        Ok(content) => download_response(
            "text/plain; charset=utf-8",
            &format!("{}.trc", safe_filename(&input.id)),
            content.into_bytes(),
        ),
        Err(error) => api_error(error),
    }
}

async fn transaction_log_content(
    State(state): State<LanApiState>,
    Json(input): Json<DownloadInput>,
) -> Response {
    let Ok(_permit) = query_permit(&state).await else {
        return api_error("局域网查询服务已停止".to_string());
    };
    match commands::read_transaction_log(state.app, input.clone()).await {
        Ok(content) => Json(json!({ "id": input.id, "content": content })).into_response(),
        Err(error) => api_error(error),
    }
}

async fn trace(State(state): State<LanApiState>, Json(input): Json<DownloadInput>) -> Response {
    let Ok(_permit) = query_permit(&state).await else {
        return api_error("局域网查询服务已停止".to_string());
    };
    let trace_id = input.id.clone();
    match commands::load_trace(state.app, input).await {
        Ok(rows) => Json(json!({ "traceId": trace_id, "rows": rows })).into_response(),
        Err(error) => api_error(error),
    }
}

fn safe_filename(value: &str) -> String {
    let value = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\u{1f}' => '_',
            _ => character,
        })
        .take(180)
        .collect::<String>();
    let value = value.trim().trim_matches('.');
    if value.is_empty() {
        "transaction-log".to_string()
    } else {
        value.to_string()
    }
}

fn download_response(content_type: &'static str, filename: &str, bytes: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    response
}

async fn asset(State(state): State<LanApiState>, uri: Uri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let path = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let asset = state
        .app
        .asset_resolver()
        .get(path.to_string())
        .or_else(|| {
            (!path.contains('.'))
                .then(|| state.app.asset_resolver().get("index.html".to_string()))
                .flatten()
        });
    let Some(asset) = asset else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from(asset.bytes));
    if let Ok(content_type) = HeaderValue::from_str(&asset.mime_type) {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    response
}

fn router(state: LanApiState) -> Router {
    Router::new()
        .route("/api/runtime", get(runtime_info))
        .route("/api/environments", get(environments))
        .route("/api/search", post(search))
        .route("/api/export", post(export))
        .route("/api/transaction-log", post(transaction_log))
        .route(
            "/api/transaction-log/content",
            post(transaction_log_content),
        )
        .route("/api/trace", post(trace))
        .fallback(asset)
        .layer(DefaultBodyLimit::max(REQUEST_BODY_LIMIT))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn current_status(manager: &LanShareManager) -> LanShareStatus {
    let mut runtime = manager.runtime.lock().await;
    if runtime
        .as_ref()
        .is_some_and(|runtime| runtime.task.is_finished())
    {
        runtime.take();
    }
    runtime
        .as_ref()
        .map(|runtime| LanShareStatus {
            enabled: true,
            url: Some(runtime.url.clone()),
            port: Some(runtime.port),
        })
        .unwrap_or_else(disabled_status)
}

#[tauri::command]
pub async fn get_lan_share_status(
    manager: TauriState<'_, LanShareManager>,
) -> Result<LanShareStatus, String> {
    Ok(current_status(&manager).await)
}

#[tauri::command]
pub async fn set_lan_share_enabled(
    app: AppHandle,
    manager: TauriState<'_, LanShareManager>,
    enabled: bool,
) -> Result<LanShareStatus, String> {
    if !enabled {
        if let Some(runtime) = manager.runtime.lock().await.take() {
            runtime.task.abort();
        }
        return Ok(disabled_status());
    }

    // Keep the state lock until the listener is registered so repeated clicks
    // cannot start two background servers and orphan the first task.
    let mut runtime = manager.runtime.lock().await;
    if runtime
        .as_ref()
        .is_some_and(|runtime| runtime.task.is_finished())
    {
        runtime.take();
    }
    if let Some(existing) = runtime.as_ref() {
        return Ok(LanShareStatus {
            enabled: true,
            url: Some(existing.url.clone()),
            port: Some(existing.port),
        });
    }

    let address = preferred_lan_address()?;
    // Bind only to the selected physical LAN interface. Outbound Kibana
    // requests still use the host routing table/VPN, while the share server is
    // not needlessly exposed on loopback or VPN interfaces.
    let listener = TcpListener::bind((address, 0))
        .await
        .map_err(|error| format!("无法启动局域网分享服务：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取局域网分享端口：{error}"))?
        .port();
    let url = format!("http://{address}:{port}");
    let api_state = LanApiState {
        app,
        query_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_QUERIES)),
    };
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router(api_state)).await {
            log::error!("OpsLog LAN server stopped: {error}");
        }
    });
    *runtime = Some(LanRuntime {
        url: url.clone(),
        port,
        task,
    });
    Ok(LanShareStatus {
        enabled: true,
        url: Some(url),
        port: Some(port),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prioritizes_physical_lan_interfaces_over_vpn_interfaces() {
        assert!(
            interface_score("en0", Ipv4Addr::new(192, 168, 3, 60))
                > interface_score("utun6", Ipv4Addr::new(10, 8, 0, 2))
        );
    }

    #[test]
    fn sanitizes_download_names_for_http_headers() {
        assert_eq!(safe_filename("../unsafe/log"), "_unsafe_log");
        assert_eq!(
            safe_filename("channelPosting.p_0_1"),
            "channelPosting.p_0_1"
        );
    }
}

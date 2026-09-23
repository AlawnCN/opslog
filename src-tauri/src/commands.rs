use std::collections::HashSet;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::domain::{
    DownloadInput, DownloadResult, EnvironmentConfig, EnvironmentSource, LogKind,
    PublicEnvironment, QueryResult, SaveCustomMarkersInput, SavePortableLogInput,
    SaveTransactionLogInput, SearchInput, SearchResponse, SearchStatus, display_fields,
};
use crate::environment_store;
use crate::export_files;
use crate::kibana_client::run_esql;
use crate::query_builders::{
    build_search_query, build_search_query_with_omitted_fields, build_trace_query, build_trc_query,
    log_keyword_fields,
};
use crate::ssh_log_source;

const MAX_RANGE_DAYS: i64 = 31;
const MAX_TRANSACTION_LOG_BYTES: usize = 64 * 1024 * 1024;

fn unknown_columns(error: &str) -> Vec<String> {
    let normalized = error.to_ascii_lowercase();
    let marker = "unknown column [";
    let mut cursor = 0;
    let mut fields = Vec::new();
    while let Some(relative_start) = normalized[cursor..].find(marker) {
        let start = cursor + relative_start + marker.len();
        let Some(relative_end) = normalized[start..].find(']') else {
            break;
        };
        let end = start + relative_end;
        let field = normalized[start..end].trim().to_string();
        if !field.is_empty() && !fields.contains(&field) {
            fields.push(field);
        }
        cursor = end + 1;
    }
    fields
}

fn constrained_fields(input: &SearchInput) -> HashSet<String> {
    let mut fields = HashSet::from([
        if matches!(input.kind, LogKind::Generic | LogKind::Transaction) {
            "@timestamp".to_string()
        } else {
            "ecp.log.timestamp".to_string()
        },
    ]);
    let mut add = |field: &str, value: Option<&str>| {
        if value.is_some_and(|value| !value.trim().is_empty()) {
            fields.insert(field.to_string());
        }
    };
    if input.kind == LogKind::Transaction {
        add("ecp.txn.id", input.txn_id.as_deref());
        add("ecp.txn.trace", input.trace_id.as_deref());
        add("ecp.txn.no", input.txn_no.as_deref());
        add("ecp.txn.business", input.business.as_deref());
        add("ecp.txn.service", input.service.as_deref());
        add("ecp.txn.message.code", input.message_code.as_deref());
        add("ecp.txn.message.info", input.message_info.as_deref());
        add("ecp.txn.node", input.node.as_deref());
        if matches!(
            input.status,
            Some(SearchStatus::Success | SearchStatus::Fail)
        ) {
            fields.insert("ecp.txn.message.code".to_string());
        }
        if input.min_duration_ms.is_some_and(|value| value > 0) {
            fields.insert("ecp.txn.duration".to_string());
        }
        return fields;
    }
    add("ecp.log.application", input.application.as_deref());
    add("ecp.log.level", input.level.as_deref());
    if input.kind == LogKind::Ecp {
        add("ecp.log.file", input.file.as_deref());
    }
    fields
}

fn available_columns(input: &SearchInput, omitted: &HashSet<String>) -> Vec<String> {
    display_fields(input.kind)
        .iter()
        .filter(|field| !omitted.contains(**field))
        .map(ToString::to_string)
        .collect()
}

pub(crate) async fn execute_source_search(
    environment: &EnvironmentConfig,
    input: &SearchInput,
    export_all: bool,
    timeout_seconds: u64,
) -> Result<QueryResult, String> {
    if environment.source_type == EnvironmentSource::Ssh {
        return ssh_log_source::search(environment, input, export_all).await;
    }
    let mut omitted = HashSet::new();
    let required = constrained_fields(input);
    for _ in 0..32 {
        let columns = available_columns(input, &omitted);
        let keyword_unavailable = input.kind != LogKind::Transaction
            && input
                .keyword
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            && log_keyword_fields(input.kind)
                .iter()
                .all(|field| omitted.contains(*field));
        if columns.is_empty() || keyword_unavailable {
            return Ok(QueryResult {
                columns,
                rows: Vec::new(),
                warnings: Vec::new(),
            });
        }
        let query = if omitted.is_empty() {
            build_search_query(input, environment, export_all)?
        } else {
            build_search_query_with_omitted_fields(input, environment, export_all, &omitted)?
        };
        match run_esql(environment, &query, timeout_seconds).await {
            Ok(result) => return Ok(result),
            Err(error) => {
                let missing = unknown_columns(&error);
                if missing.is_empty() {
                    return Err(error);
                }
                let learned = missing.iter().any(|field| !omitted.contains(field));
                omitted.extend(missing.iter().cloned());
                let columns = available_columns(input, &omitted);
                if !learned || missing.iter().any(|field| required.contains(field)) {
                    return Ok(QueryResult {
                        columns,
                        rows: Vec::new(),
                        warnings: Vec::new(),
                    });
                }
            }
        }
    }
    Ok(QueryResult {
        columns: available_columns(input, &omitted),
        rows: Vec::new(),
        warnings: Vec::new(),
    })
}
const MAX_CUSTOM_MARKERS_BYTES: usize = 1024 * 1024;
const MAX_PORTABLE_LOG_BYTES: usize = 192 * 1024 * 1024;
const MAX_AI_ANALYSIS_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiAnalysisInput {
    name: String,
    contents: String,
    format: String,
}

fn parse_range(start: &str, end: &str, enforce_maximum: bool) -> Result<(), String> {
    let start =
        DateTime::parse_from_rfc3339(start).map_err(|_| "开始时间格式不合法".to_string())?;
    let end = DateTime::parse_from_rfc3339(end).map_err(|_| "结束时间格式不合法".to_string())?;
    if end <= start {
        return Err("结束时间必须晚于开始时间".to_string());
    }
    if enforce_maximum && end - start > Duration::days(MAX_RANGE_DAYS) {
        return Err("单次查询时间范围不能超过 31 天".to_string());
    }
    Ok(())
}

fn validate_optional_text(value: &Option<String>) -> Result<(), String> {
    if value
        .as_ref()
        .is_some_and(|value| value.chars().count() > 500)
    {
        return Err("单个查询条件不能超过 500 个字符".to_string());
    }
    Ok(())
}

pub(crate) fn validate_search(input: &SearchInput) -> Result<(), String> {
    if input.environment.trim().is_empty() || input.environment.chars().count() > 100 {
        return Err("请选择有效环境".to_string());
    }
    if !(1..=200).contains(&input.page) || ![50, 100, 500].contains(&input.page_size) {
        return Err("分页参数不合法".to_string());
    }
    if input
        .min_duration_ms
        .is_some_and(|duration| duration > 86_400_000)
    {
        return Err("最小耗时不能超过 86400000 毫秒".to_string());
    }
    for value in [
        &input.index,
        &input.txn_id,
        &input.trace_id,
        &input.txn_no,
        &input.business,
        &input.service,
        &input.message_code,
        &input.message_info,
        &input.node,
        &input.keyword,
        &input.level,
        &input.file,
        &input.application,
    ] {
        validate_optional_text(value)?;
    }
    parse_range(&input.start_time, &input.end_time, true)
}

fn validate_download(input: &DownloadInput) -> Result<(), String> {
    if input.environment.trim().is_empty() || input.id.trim().is_empty() {
        return Err("下载参数不完整".to_string());
    }
    if input.environment.chars().count() > 100 || input.id.chars().count() > 500 {
        return Err("下载参数过长".to_string());
    }
    parse_range(&input.start_time, &input.end_time, false)
}

#[tauri::command]
pub async fn load_environments(app: AppHandle) -> Result<Vec<PublicEnvironment>, String> {
    let environments = environment_store::load(&app).await?;
    let public_environments = stream::iter(environments.into_iter().map(|environment| async move {
        let time_profile = if environment.source_type == EnvironmentSource::Ssh {
            Some(ssh_log_source::resolve_time_profile(&environment).await)
        } else {
            None
        };
        environment_store::to_public(environment, time_profile)
    })).buffered(4).collect::<Vec<_>>().await;
    Ok(public_environments)
}

#[tauri::command]
pub async fn load_environment_configuration(
    app: AppHandle,
) -> Result<Vec<EnvironmentConfig>, String> {
    environment_store::load(&app).await
}

#[tauri::command]
pub async fn save_environment_config(
    app: AppHandle,
    contents: String,
) -> Result<DownloadResult, String> {
    let path = environment_store::save(&app, &contents).await?;
    Ok(DownloadResult {
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn search_logs(app: AppHandle, input: SearchInput) -> Result<SearchResponse, String> {
    validate_search(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    let result = execute_source_search(&environment, &input, false, 120).await?;
    let row_count = result.rows.len();
    let warnings = result.warnings;
    let has_columns = !result.columns.is_empty();
    let columns = result.columns;
    let start = input.page.saturating_sub(1) * input.page_size;
    let requested_rows = input.page * input.page_size;
    let has_more_by_source = if environment.source_type == EnvironmentSource::Ssh {
        row_count > requested_rows
    } else {
        row_count >= requested_rows
    };
    let has_more = has_columns && requested_rows < 10_000 && has_more_by_source;
    let rows = result
        .rows
        .into_iter()
        .skip(start)
        .take(input.page_size)
        .collect();
    Ok(SearchResponse {
        columns,
        rows,
        warnings,
        page: input.page,
        page_size: input.page_size,
        has_more,
        truncated: input.page * input.page_size >= 10_000,
        query_time: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

#[tauri::command]
pub async fn export_logs(app: AppHandle, input: SearchInput) -> Result<DownloadResult, String> {
    validate_search(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    let result = execute_source_search(&environment, &input, true, 300).await?;
    if !result.warnings.is_empty() {
        return Err(format!("部分服务器查询失败，已取消导出以避免生成不完整文件：{}", result.warnings.join("；")));
    }
    let columns = &result.columns;
    let contents = export_files::csv(columns, &result.rows);
    export_files::save(input.kind.as_str(), "csv", contents.as_bytes()).await
}

#[tauri::command]
pub async fn download_transaction_log(
    app: AppHandle,
    input: DownloadInput,
) -> Result<DownloadResult, String> {
    validate_download(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    if environment.source_type == EnvironmentSource::Ssh {
        let contents = ssh_log_source::read_transaction(
            &environment,
            &input.id,
            &input.start_time,
            &input.end_time,
            input.application.as_deref(),
        )
        .await?;
        return export_files::save_named(&input.id, "trc", contents.as_bytes()).await;
    }
    let query = build_trc_query(&environment, &input.id, &input.start_time, &input.end_time)?;
    let result = run_esql(&environment, &query, 300).await?;
    let contents = export_files::trc(&result.rows);
    export_files::save_named(&input.id, "trc", contents.as_bytes()).await
}

#[tauri::command]
pub async fn read_transaction_log(app: AppHandle, input: DownloadInput) -> Result<String, String> {
    validate_download(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    if environment.source_type == EnvironmentSource::Ssh {
        return ssh_log_source::read_transaction(
            &environment,
            &input.id,
            &input.start_time,
            &input.end_time,
            input.application.as_deref(),
        )
        .await;
    }
    let query = build_trc_query(&environment, &input.id, &input.start_time, &input.end_time)?;
    let result = run_esql(&environment, &query, 300).await?;
    Ok(export_files::trc(&result.rows))
}

#[tauri::command]
pub async fn save_transaction_log(
    input: SaveTransactionLogInput,
) -> Result<DownloadResult, String> {
    if input.id.trim().is_empty() || input.id.chars().count() > 500 {
        return Err("日志 ID 不合法".to_string());
    }
    if input.content.len() > MAX_TRANSACTION_LOG_BYTES {
        return Err("日志内容超过 64 MB 安全上限".to_string());
    }
    export_files::save_named(&input.id, "trc", input.content.as_bytes()).await
}

#[tauri::command]
pub async fn save_custom_log_markers(
    input: SaveCustomMarkersInput,
) -> Result<DownloadResult, String> {
    if input.name.trim().is_empty() || input.name.chars().count() > 200 {
        return Err("标记导出文件名不合法".to_string());
    }
    if input.contents.len() > MAX_CUSTOM_MARKERS_BYTES {
        return Err("标记导出内容超过 1 MB 安全上限".to_string());
    }
    serde_json::from_str::<Value>(&input.contents)
        .map_err(|_| "标记导出内容不是有效的 JSON".to_string())?;
    export_files::save_named(&input.name, "json", input.contents.as_bytes()).await
}

#[tauri::command]
pub async fn save_portable_log(input: SavePortableLogInput) -> Result<DownloadResult, String> {
    if input.name.trim().is_empty() || input.name.chars().count() > 220 {
        return Err("离线阅读文件名不合法".to_string());
    }
    if input.contents.len() > MAX_PORTABLE_LOG_BYTES {
        return Err("离线阅读文件超过 192 MB 安全上限".to_string());
    }
    if !input.contents.starts_with("<!doctype html>")
        || !input.contents.contains("opslog-portable-reader")
    {
        return Err("离线阅读文件格式不合法".to_string());
    }
    export_files::save_named(&input.name, "html", input.contents.as_bytes()).await
}

#[tauri::command]
pub async fn save_ai_analysis(input: SaveAiAnalysisInput) -> Result<DownloadResult, String> {
    if input.name.trim().is_empty() || input.name.chars().count() > 220 {
        return Err("分析结果文件名不合法".to_string());
    }
    if input.contents.len() > MAX_AI_ANALYSIS_BYTES {
        return Err("分析结果超过 16 MB 安全上限".to_string());
    }
    if !matches!(input.format.as_str(), "md" | "html") {
        return Err("分析结果导出格式不受支持".to_string());
    }
    export_files::save_named(&input.name, &input.format, input.contents.as_bytes()).await
}

#[tauri::command]
pub async fn load_trace(
    app: AppHandle,
    input: DownloadInput,
) -> Result<Vec<Map<String, Value>>, String> {
    validate_download(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    if environment.source_type == EnvironmentSource::Ssh {
        return Err("SSH 直连环境不提供 APM Trace 调用链".to_string());
    }
    let query = build_trace_query(&environment, &input.id, &input.start_time, &input.end_time)?;
    Ok(run_esql(&environment, &query, 300).await?.rows)
}

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{Map, Value};
use tauri::AppHandle;

use crate::domain::{
    DownloadInput, DownloadResult, PublicEnvironment, SearchInput, SearchResponse, display_fields,
};
use crate::environment_store;
use crate::export_files;
use crate::kibana_client::run_esql;
use crate::query_builders::{build_search_query, build_trace_query, build_trc_query};

const MAX_RANGE_DAYS: i64 = 31;

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

fn validate_search(input: &SearchInput) -> Result<(), String> {
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
    Ok(environment_store::load(&app)
        .await?
        .into_iter()
        .map(environment_store::to_public)
        .collect())
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
    let query = build_search_query(&input, &environment, false)?;
    let result = run_esql(&environment, &query, 120).await?;
    let row_count = result.rows.len();
    let has_columns = !result.columns.is_empty();
    let start = input.page.saturating_sub(1) * input.page_size;
    let rows = result
        .rows
        .into_iter()
        .skip(start)
        .take(input.page_size)
        .collect();
    Ok(SearchResponse {
        columns: display_fields(input.kind)
            .iter()
            .map(ToString::to_string)
            .collect(),
        rows,
        page: input.page,
        page_size: input.page_size,
        has_more: has_columns && row_count >= input.page * input.page_size,
        truncated: input.page * input.page_size >= 10_000,
        query_time: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

#[tauri::command]
pub async fn export_logs(app: AppHandle, input: SearchInput) -> Result<DownloadResult, String> {
    validate_search(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    let query = build_search_query(&input, &environment, true)?;
    let result = run_esql(&environment, &query, 300).await?;
    let columns = display_fields(input.kind)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let contents = export_files::csv(&columns, &result.rows);
    export_files::save(input.kind.as_str(), "csv", contents.as_bytes()).await
}

#[tauri::command]
pub async fn download_transaction_log(
    app: AppHandle,
    input: DownloadInput,
) -> Result<DownloadResult, String> {
    validate_download(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    let query = build_trc_query(&environment, &input.id, &input.start_time, &input.end_time)?;
    let result = run_esql(&environment, &query, 300).await?;
    let contents = export_files::trc(&result.rows);
    export_files::save("transaction-log", "trc", contents.as_bytes()).await
}

#[tauri::command]
pub async fn load_trace(
    app: AppHandle,
    input: DownloadInput,
) -> Result<Vec<Map<String, Value>>, String> {
    validate_download(&input)?;
    let environment = environment_store::find(&app, &input.environment).await?;
    let query = build_trace_query(&environment, &input.id, &input.start_time, &input.end_time)?;
    Ok(run_esql(&environment, &query, 300).await?.rows)
}

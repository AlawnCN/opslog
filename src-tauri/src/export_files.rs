use std::path::PathBuf;

use chrono::Utc;
use serde_json::{Map, Value};

use crate::domain::DownloadResult;

fn cell(value: Option<&Value>) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    };
    format!("\"{}\"", text.replace('"', "\"\""))
}

pub fn csv(columns: &[String], rows: &[Map<String, Value>]) -> String {
    let mut lines = Vec::with_capacity(rows.len() + 1);
    lines.push(
        columns
            .iter()
            .map(|value| cell(Some(&Value::String(value.clone()))))
            .collect::<Vec<_>>()
            .join(","),
    );
    lines.extend(rows.iter().map(|row| {
        columns
            .iter()
            .map(|column| cell(row.get(column)))
            .collect::<Vec<_>>()
            .join(",")
    }));
    format!("\u{feff}{}", lines.join("\r\n"))
}

pub fn trc(rows: &[Map<String, Value>]) -> String {
    rows.iter()
        .map(|row| {
            format!(
                "{} [{}] [{}] -> {}",
                text(row.get("ecp.log.timestamp")),
                text(row.get("ecp.log.application")),
                text(row.get("ecp.log.level")),
                text(row.get("message"))
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
    }
}

pub async fn save(
    prefix: &str,
    extension: &str,
    contents: &[u8],
) -> Result<DownloadResult, String> {
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    save_named(&format!("{prefix}-{timestamp}"), extension, contents).await
}

pub async fn save_named(
    name: &str,
    extension: &str,
    contents: &[u8],
) -> Result<DownloadResult, String> {
    let directory = dirs::download_dir()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "无法定位系统下载目录".to_string())?;
    let stem = safe_file_stem(name);
    let path = available_path(&directory, &stem, extension).await?;
    tokio::fs::write(&path, contents)
        .await
        .map_err(|error| format!("无法保存文件 {}：{error}", path.display()))?;
    Ok(DownloadResult {
        path: path.to_string_lossy().into_owned(),
    })
}

fn safe_file_stem(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'..='\u{1f}' => '_',
            _ => character,
        })
        .collect();
    let stem = sanitized
        .trim()
        .trim_matches('.')
        .chars()
        .take(180)
        .collect::<String>();
    if stem.is_empty()
        || matches!(
            stem.to_ascii_uppercase().as_str(),
            "CON" | "PRN" | "AUX" | "NUL"
        )
    {
        "opslog-download".to_string()
    } else {
        stem
    }
}

async fn available_path(
    directory: &std::path::Path,
    stem: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    for suffix in 0..10_000 {
        let name = if suffix == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({suffix}).{extension}")
        };
        let path = directory.join(name);
        if !tokio::fs::try_exists(&path)
            .await
            .map_err(|error| format!("无法检查下载目录 {}：{error}", directory.display()))?
        {
            return Ok(path);
        }
    }
    Err("下载目录中存在过多同名文件，请清理后重试".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_csv_values() {
        let columns = vec!["message".to_string()];
        let rows = vec![Map::from_iter([(
            "message".to_string(),
            Value::String("a,\"b\"".to_string()),
        )])];
        assert_eq!(
            csv(&columns, &rows),
            "\u{feff}\"message\"\r\n\"a,\"\"b\"\"\""
        );
    }

    #[test]
    fn uses_log_id_as_safe_file_stem() {
        assert_eq!(
            safe_file_stem("channelPostingapc.p_0_123"),
            "channelPostingapc.p_0_123"
        );
        assert_eq!(safe_file_stem("../unsafe/log"), "_unsafe_log");
    }
}

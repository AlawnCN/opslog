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
    let directory = dirs::download_dir()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "无法定位系统下载目录".to_string())?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let path: PathBuf = directory.join(format!("{prefix}-{timestamp}.{extension}"));
    tokio::fs::write(&path, contents)
        .await
        .map_err(|error| format!("无法保存文件 {}：{error}", path.display()))?;
    Ok(DownloadResult {
        path: path.to_string_lossy().into_owned(),
    })
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
}

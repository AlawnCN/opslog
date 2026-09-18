use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

const MAX_TRC_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Default)]
pub struct PendingTrcFile(pub Mutex<Option<PathBuf>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrcDocument {
    pub name: String,
    pub path: String,
    pub content: String,
}

fn validate_trc_path(path: &Path) -> Result<(), String> {
    let is_trc = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("trc"));
    if !is_trc {
        return Err("只支持打开 .trc 日志文件".to_string());
    }
    Ok(())
}

pub fn startup_trc_path() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| validate_trc_path(path).is_ok() && path.is_file())
}

pub fn remember_pending_file(state: &PendingTrcFile, path: PathBuf) {
    if validate_trc_path(&path).is_ok()
        && let Ok(mut pending) = state.0.lock()
    {
        *pending = Some(path);
    }
}

async fn read_document(path: PathBuf) -> Result<TrcDocument, String> {
    validate_trc_path(&path)?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("无法读取日志文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("选择的路径不是日志文件".to_string());
    }
    if metadata.len() > MAX_TRC_BYTES {
        return Err("日志文件超过 64 MB 安全上限".to_string());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| format!("无法读取 TRC 日志：{error}"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("log.trc")
        .to_string();
    Ok(TrcDocument {
        name,
        path: path.to_string_lossy().into_owned(),
        content,
    })
}

#[tauri::command]
pub async fn load_startup_trc_file(
    state: tauri::State<'_, PendingTrcFile>,
) -> Result<Option<TrcDocument>, String> {
    let path = state
        .0
        .lock()
        .map_err(|_| "无法读取待打开的日志文件".to_string())?
        .take();
    match path {
        Some(path) => read_document(path).await.map(Some),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_trc_extension_case_insensitively() {
        assert!(validate_trc_path(Path::new("sample.trc")).is_ok());
        assert!(validate_trc_path(Path::new("sample.TRC")).is_ok());
        assert!(validate_trc_path(Path::new("sample.log")).is_err());
    }
}

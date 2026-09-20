use std::collections::HashMap;
use std::path::PathBuf;

use serde::Deserialize;

pub(crate) const SETTINGS_DIRECTORY: &str = "OpsLog/shared-reader-settings";
const ALLOWED_SETTINGS: [(&str, &str); 5] = [
    (
        "opslog.transaction-log.custom-markers.v1",
        "custom-markers.json",
    ),
    (
        "opslog.transaction-log-reader.preferences.v1",
        "reader-preferences.json",
    ),
    (
        "opslog.transaction-log.custom-marker-width-ratio.v1",
        "custom-marker-width.txt",
    ),
    (
        "opslog.transaction-log-reader.width-ratio.v1",
        "reader-width.txt",
    ),
    (
        "opslog.transaction-log-outline.geometry.v1",
        "outline-geometry.json",
    ),
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderSettingInput {
    key: String,
    value: String,
}

pub(crate) fn settings_directory() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|directory| directory.join(SETTINGS_DIRECTORY))
        .ok_or_else(|| "无法定位阅读器共享配置目录".to_string())
}

fn filename_for(key: &str) -> Result<&'static str, String> {
    ALLOWED_SETTINGS
        .iter()
        .find_map(|(candidate, filename)| (*candidate == key).then_some(*filename))
        .ok_or_else(|| "不支持的阅读器配置项".to_string())
}

#[tauri::command]
pub async fn load_reader_settings() -> Result<HashMap<String, String>, String> {
    let directory = settings_directory()?;
    let mut settings = HashMap::new();
    for (key, filename) in ALLOWED_SETTINGS {
        let path = directory.join(filename);
        match tokio::fs::read_to_string(&path).await {
            Ok(value) => {
                settings.insert(key.to_string(), value);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "无法读取共享阅读器配置 {}：{error}",
                    path.display()
                ));
            }
        }
    }
    Ok(settings)
}

#[tauri::command]
pub async fn save_reader_setting(input: ReaderSettingInput) -> Result<(), String> {
    if input.value.len() > 1024 * 1024 {
        return Err("单个阅读器配置项不能超过 1 MB".to_string());
    }
    let filename = filename_for(&input.key)?;
    let directory = settings_directory()?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("无法创建阅读器共享配置目录：{error}"))?;
    let path = directory.join(filename);
    tokio::fs::write(&path, input.value)
        .await
        .map_err(|error| format!("无法保存阅读器共享配置：{error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| format!("无法保护阅读器共享配置权限：{error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_reader_settings_are_persisted() {
        assert_eq!(
            filename_for("opslog.transaction-log.custom-markers.v1").unwrap(),
            "custom-markers.json"
        );
        assert!(filename_for("unexpected.setting").is_err());
    }
}

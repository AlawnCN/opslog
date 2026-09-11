use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

const RELEASE_API_ROOT: &str = "https://api.github.com/repos/AlawnCN/opslog/releases/tags";
const MAX_RELEASE_NOTES_BYTES: usize = 256 * 1024;
const MAX_RELEASE_RESPONSE_BYTES: usize = 512 * 1024;

#[derive(Deserialize)]
struct GitHubRelease {
    body: Option<String>,
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 80
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'))
}

#[tauri::command]
pub async fn load_update_release_notes(version: String) -> Result<Option<String>, String> {
    let version = version.trim();
    if !valid_version(version) {
        return Err("更新版本号格式不合法".to_string());
    }

    let response = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("OpsLog/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("无法初始化更新服务：{error}"))?
        .get(format!("{RELEASE_API_ROOT}/v{version}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("无法连接 GitHub Release：{error}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub Release 返回 HTTP {}", response.status()));
    }
    let payload = response
        .bytes()
        .await
        .map_err(|error| format!("GitHub Release 内容读取失败：{error}"))?;
    if payload.len() > MAX_RELEASE_RESPONSE_BYTES {
        return Err("GitHub Release 响应超过安全大小限制".to_string());
    }
    let release = serde_json::from_slice::<GitHubRelease>(&payload)
        .map_err(|error| format!("GitHub Release 内容无法解析：{error}"))?;
    let notes = release
        .body
        .map(|body| body.trim().to_string())
        .filter(|body| !body.is_empty());
    if notes
        .as_ref()
        .is_some_and(|notes| notes.len() > MAX_RELEASE_NOTES_BYTES)
    {
        return Err("更新说明超过安全大小限制".to_string());
    }
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::valid_version;

    #[test]
    fn accepts_release_versions() {
        assert!(valid_version("3.0.19"));
        assert!(valid_version("3.1.0-beta.2"));
    }

    #[test]
    fn rejects_version_values_that_can_change_the_url() {
        assert!(!valid_version(""));
        assert!(!valid_version("../latest"));
        assert!(!valid_version("3.0.19?draft=1"));
    }
}

use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

const RELEASE_API_ROOTS: [&str; 2] = [
    "https://git.alawn.cn/api/v1/repos/Alawn/opslog-release/releases/tags",
    "https://api.github.com/repos/AlawnCN/opslog-release/releases/tags",
];
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

    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("OpsLog/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("无法初始化更新服务：{error}"))?;

    let mut failures = Vec::new();
    for root in RELEASE_API_ROOTS {
        let response = match client
            .get(format!("{root}/v{version}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                failures.push(format!("{root}: {error}"));
                continue;
            }
        };
        if !response.status().is_success() {
            failures.push(format!("{root}: HTTP {}", response.status()));
            continue;
        }
        let payload = match response.bytes().await {
            Ok(payload) => payload,
            Err(error) => {
                failures.push(format!("{root}: 更新说明读取失败：{error}"));
                continue;
            }
        };
        if payload.len() > MAX_RELEASE_RESPONSE_BYTES {
            failures.push(format!("{root}: 响应超过安全大小限制"));
            continue;
        }
        let release = match serde_json::from_slice::<GitHubRelease>(&payload) {
            Ok(release) => release,
            Err(error) => {
                failures.push(format!("{root}: 更新说明无法解析：{error}"));
                continue;
            }
        };
        let notes = release
            .body
            .map(|body| body.trim().to_string())
            .filter(|body| !body.is_empty());
        if let Some(notes) = notes {
            if notes.len() > MAX_RELEASE_NOTES_BYTES {
                failures.push(format!("{root}: 更新说明超过安全大小限制"));
                continue;
            }
            return Ok(Some(notes));
        }
    }
    if failures.len() == RELEASE_API_ROOTS.len() {
        Err(failures.join("；"))
    } else {
        Ok(None)
    }
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

use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::{AppHandle, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

#[cfg(not(feature = "reader-app"))]
const MANIFEST_NAME: &str = "latest.json";
#[cfg(feature = "reader-app")]
const MANIFEST_NAME: &str = "reader-latest.json";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mirror {
    Gitea,
    Github,
}

impl Mirror {
    fn other(self) -> Self {
        match self {
            Self::Gitea => Self::Github,
            Self::Github => Self::Gitea,
        }
    }

    fn endpoint(self, version: Option<&str>) -> String {
        match (self, version) {
            (Self::Gitea, None) => {
                format!("https://git.alawn.cn/Alawn/opslog-release/raw/branch/main/{MANIFEST_NAME}")
            }
            (Self::Github, None) => format!(
                "https://github.com/AlawnCN/opslog-release/releases/latest/download/{MANIFEST_NAME}"
            ),
            (Self::Gitea, Some(version)) => format!(
                "https://git.alawn.cn/Alawn/opslog-release/releases/download/v{version}/{MANIFEST_NAME}"
            ),
            (Self::Github, Some(version)) => format!(
                "https://github.com/AlawnCN/opslog-release/releases/download/v{version}/{MANIFEST_NAME}"
            ),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Gitea => "Gitea",
            Self::Github => "GitHub",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCandidate {
    version: String,
    current_version: String,
    body: Option<String>,
    source: Mirror,
}

async fn check_source(
    app: &AppHandle,
    source: Mirror,
    version: Option<&str>,
) -> Result<Option<Update>, String> {
    let endpoint = source
        .endpoint(version)
        .parse()
        .map_err(|error| format!("更新地址无效：{error}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    updater
        .check()
        .await
        .map_err(|error| format!("{} 更新检查失败：{error}", source.label()))
}

fn newer_than(left: &str, right: &str) -> bool {
    match (Version::parse(left), Version::parse(right)) {
        (Ok(left), Ok(right)) => left > right,
        _ => false,
    }
}

#[tauri::command]
pub async fn check_update_mirrors(app: AppHandle) -> Result<Option<MirrorCandidate>, String> {
    // Check concurrently: a stale 200 response from the primary must not hide a newer mirror.
    let (primary, backup) = tokio::join!(
        check_source(&app, Mirror::Gitea, None),
        check_source(&app, Mirror::Github, None)
    );
    let chosen = match (primary, backup) {
        (Ok(Some(primary)), Ok(Some(backup))) if newer_than(&backup.version, &primary.version) => {
            Some((Mirror::Github, backup))
        }
        (Ok(Some(primary)), _) => Some((Mirror::Gitea, primary)),
        (_, Ok(Some(backup))) => Some((Mirror::Github, backup)),
        (Ok(None), _) | (_, Ok(None)) => None,
        (Err(primary), Err(backup)) => return Err(format!("{primary}；{backup}")),
    };
    Ok(chosen.map(|(source, update)| MirrorCandidate {
        version: update.version,
        current_version: update.current_version,
        body: update.body,
        source,
    }))
}

#[tauri::command]
pub async fn install_update_from_mirrors(
    app: AppHandle,
    version: String,
    source: Mirror,
    on_event: Channel<Value>,
) -> Result<(), String> {
    let expected = Version::parse(&version).map_err(|_| "更新版本号无效".to_string())?;
    let mut failures = Vec::new();

    for mirror in [source, source.other()] {
        let mut update = match check_source(&app, mirror, Some(&version)).await {
            Ok(Some(update)) if Version::parse(&update.version).ok() == Some(expected.clone()) => {
                update
            }
            Ok(_) => {
                failures.push(format!("{} 没有版本 {version} 的更新包", mirror.label()));
                continue;
            }
            Err(error) => {
                failures.push(error);
                continue;
            }
        };

        let _ = on_event.send(json!({"event": "Started", "data": {}}));
        let progress = on_event.clone();
        let mut started = false;
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        let bytes = update
            .download(
                move |chunk_length, content_length| {
                    if !started {
                        let _ = progress.send(
                            json!({"event": "Started", "data": {"contentLength": content_length}}),
                        );
                        started = true;
                    }
                    let _ = progress
                        .send(json!({"event": "Progress", "data": {"chunkLength": chunk_length}}));
                },
                || {},
            )
            .await;
        match bytes {
            Ok(bytes) => {
                let _ = on_event.send(json!({"event": "Finished"}));
                // Never retry an installation failure: installation may already have changed files.
                return update
                    .install(bytes)
                    .map_err(|error| format!("安装失败：{error}"));
            }
            Err(error) => failures.push(format!("{} 下载或签名验证失败：{error}", mirror.label())),
        }
    }
    Err(failures.join("；"))
}

#[cfg(test)]
mod tests {
    use super::{MANIFEST_NAME, Mirror, newer_than};

    #[test]
    fn newer_backup_beats_stale_primary_manifest() {
        assert!(newer_than("3.1.7", "3.1.6"));
        assert!(newer_than("3.1.7", "3.1.7-beta.1"));
        assert!(!newer_than("3.1.6", "3.1.7"));
        assert!(!newer_than("3.1.7", "3.1.7"));
    }

    #[test]
    fn mirrors_use_separate_public_hosts() {
        assert!(Mirror::Gitea.endpoint(None).contains("git.alawn.cn"));
        assert!(
            Mirror::Github
                .endpoint(None)
                .contains("AlawnCN/opslog-release")
        );
        assert!(!Mirror::Gitea.endpoint(None).contains("github.com"));
        assert!(
            Mirror::Gitea
                .endpoint(Some("3.1.7"))
                .ends_with(&format!("/v3.1.7/{MANIFEST_NAME}"))
        );
    }
}

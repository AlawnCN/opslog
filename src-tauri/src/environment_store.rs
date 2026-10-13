use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::domain::{EnvironmentConfig, EnvironmentSource, PublicEnvironment, SshApplicationConfig, SshAuthentication, SshServerConfig};

const CONFIG_FILE: &str = "opslog-envs.json";
const LEGACY_KIBANA_URLS: [(&str, &str); 2] = [
    (
        "https://10.1.6.10/kibana",
        "https://nexus.faulukenya.com/kibana",
    ),
    (
        "https://10.1.145.70/kibana",
        "https://m5uat.faulukenya.com/kibana",
    ),
];

fn normalize_kibana_url(url: &str) -> String {
    LEGACY_KIBANA_URLS
        .iter()
        .find_map(|(legacy, hostname)| url.eq_ignore_ascii_case(legacy).then_some(*hostname))
        .unwrap_or(url)
        .to_string()
}

fn configured_path() -> Option<PathBuf> {
    std::env::var_os("OPSLOG_CONFIG_PATH").map(PathBuf::from)
}

fn portable_paths() -> Vec<PathBuf> {
    let Ok(executable) = std::env::current_exe() else {
        return Vec::new();
    };
    let mut paths = executable
        .parent()
        .map(|directory| vec![directory.join(CONFIG_FILE)])
        .unwrap_or_default();

    #[cfg(target_os = "macos")]
    if let Some(app_bundle) = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
    {
        if let Some(directory) = app_bundle.parent() {
            paths.push(directory.join(CONFIG_FILE));
        }
    }
    paths
}

fn candidate_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = configured_path() {
        paths.push(path);
    }
    if let Ok(directory) = app.path().app_config_dir() {
        paths.push(directory.join(CONFIG_FILE));
    }
    if let Ok(directory) = std::env::current_dir() {
        paths.push(directory.join(CONFIG_FILE));
    }
    paths.extend(portable_paths());
    paths
}

fn validate(environments: &[EnvironmentConfig]) -> Result<(), String> {
    if environments.is_empty() {
        return Err("环境配置至少需要包含一个环境".to_string());
    }
    for environment in environments {
        let required = if environment.source_type == EnvironmentSource::Ssh {
            vec![(&environment.name, "name")]
        } else {
            vec![
                (&environment.name, "name"),
                (&environment.kibana_url, "kibanaUrl"),
                (&environment.username, "username"),
                (&environment.password, "password"),
                (&environment.txnlst_index, "txnlstIndex"),
                (&environment.txntrc_index, "txntrcIndex"),
                (&environment.applog_index, "applogIndex"),
            ]
        };
        if let Some((_, field)) = required.iter().find(|(value, _)| value.trim().is_empty()) {
            return Err(format!("环境 {} 的 {field} 不能为空", environment.name));
        }
        if environment.source_type == EnvironmentSource::Elk
            && environment.apm_index.as_ref().is_some_and(|value| value.trim().is_empty())
        {
            return Err(format!("环境 {} 的 APM 调用链索引不能为空", environment.name));
        }
        if environment.source_type == EnvironmentSource::Elk
            && !(environment.kibana_url.starts_with("https://")
                || environment.kibana_url.starts_with("http://"))
        {
            return Err(format!("环境 {} 的 kibanaUrl 不合法", environment.name));
        }
        if environment.source_type == EnvironmentSource::Ssh {
            if environment.ssh_servers.is_empty() {
                return Err(format!("环境 {} 至少需要配置一台 SSH 服务器", environment.name));
            }
            if environment.ssh_monitored_applications.is_empty() {
                return Err(format!(
                    "环境 {} 至少需要配置一个监控应用",
                    environment.name
                ));
            }
            let mut server_names = std::collections::HashSet::new();
            for server in &environment.ssh_servers {
                if server.name.trim().is_empty() || server.host.trim().is_empty() {
                    return Err(format!("环境 {} 的服务器名称和地址不能为空", environment.name));
                }
                if !matches!(server.authentication, SshAuthentication::SshConfig) && server.port == Some(0) {
                    return Err(format!("环境 {} 的 SSH 端口必须在 1～65535 之间", environment.name));
                }
                if matches!(server.authentication, SshAuthentication::Password)
                    && (server.username.as_deref().unwrap_or("").trim().is_empty() || server.password.as_deref().unwrap_or("").is_empty())
                {
                    return Err(format!("环境 {} 的密码认证需要用户名和密码", environment.name));
                }
                if let Some(fingerprint) = server.host_key_fingerprint.as_deref().filter(|value| !value.is_empty()) {
                    if !fingerprint.starts_with("SHA256:") || fingerprint.len() != 50 || !fingerprint[7..].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/') {
                        return Err(format!("环境 {} 的 SSH 主机指纹格式不正确", environment.name));
                    }
                }
                if matches!(server.authentication, SshAuthentication::PrivateKey)
                    && (server.username.as_deref().unwrap_or("").trim().is_empty() || server.private_key_path.as_deref().unwrap_or("").trim().is_empty())
                {
                    return Err(format!("环境 {} 的密钥认证需要用户名和私钥路径", environment.name));
                }
                if !server_names.insert(server.name.to_lowercase()) {
                    return Err(format!("环境 {} 的服务器名称不能重复", environment.name));
                }
            }
            let mut application_names = std::collections::HashSet::new();
            for application in &environment.ssh_monitored_applications {
                application.validate_log_sources()?;
                if !application.directory.starts_with('/') || application.directory.contains("..") {
                    return Err(format!("环境 {} 的应用目录必须是安全的绝对路径", environment.name));
                }
                if !application_names.insert(application.name.to_lowercase()) {
                    return Err(format!("环境 {} 的监控应用简称不能重复", environment.name));
                }
            }
        }
    }
    Ok(())
}

fn parse(contents: &str) -> Result<Vec<EnvironmentConfig>, String> {
    let mut environments: Vec<EnvironmentConfig> =
        serde_json::from_str(contents).map_err(|error| format!("环境配置 JSON 不合法：{error}"))?;
    for environment in &mut environments {
        environment.kibana_url = normalize_kibana_url(&environment.kibana_url);
        for server in &mut environment.ssh_servers {
            if matches!(server.authentication, SshAuthentication::SshConfig) {
                server.port = None;
            }
        }
        if environment.ssh_servers.is_empty() {
            if let Some(host) = environment.ssh_host.clone().filter(|host| !host.trim().is_empty()) {
                environment.ssh_servers.push(SshServerConfig { name: host.clone(), host, port: None, username: None, authentication: SshAuthentication::SshConfig, password: None, private_key_path: None, host_key_fingerprint: None });
            }
        }
        if environment.ssh_monitored_applications.is_empty() {
            let base = environment.ssh_base_directory.as_deref().unwrap_or("/home/coradm").trim_end_matches('/');
            environment.ssh_monitored_applications = environment.ssh_applications.iter().map(|name| SshApplicationConfig { name: name.clone(), directory: format!("{base}/{name}"), log_sources: Vec::new(), analysis_notes: Vec::new() }).collect();
        }
    }
    validate(&environments)?;
    Ok(environments)
}

pub async fn load(app: &AppHandle) -> Result<Vec<EnvironmentConfig>, String> {
    let path = candidate_paths(app)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "未找到 opslog-envs.json，请打开“配置”创建或导入运行环境".to_string())?;
    let contents = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| format!("无法读取环境配置 {}：{error}", path.display()))?;
    parse(&contents)
}

pub async fn save(app: &AppHandle, contents: &str) -> Result<PathBuf, String> {
    parse(contents)?;
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("无法创建应用配置目录：{error}"))?;
    let path = directory.join(CONFIG_FILE);
    tokio::fs::write(&path, contents)
        .await
        .map_err(|error| format!("无法保存环境配置：{error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| format!("无法保护环境配置权限：{error}"))?;
    }

    Ok(path)
}

pub async fn find(app: &AppHandle, name: &str) -> Result<EnvironmentConfig, String> {
    load(app)
        .await?
        .into_iter()
        .find(|environment| environment.name == name)
        .ok_or_else(|| format!("未知环境：{name}"))
}

pub fn to_public(
    environment: EnvironmentConfig,
    time_profile: Option<crate::ssh_log_source::SshTimeProfile>,
) -> PublicEnvironment {
    let configured_time_zone = environment.time_zone.clone();
    let (time_zone, time_zone_offset, time_zone_source) = time_profile
        .map(|profile| (profile.time_zone, profile.offset, profile.source))
        .unwrap_or_else(|| {
            (
                configured_time_zone.clone().unwrap_or_else(|| "Africa/Nairobi".to_string()),
                environment.ssh_log_time_offset.clone().unwrap_or_else(|| "+03:00".to_string()),
                if configured_time_zone.is_some() { "configured" } else { "default" }.to_string(),
            )
        });
    PublicEnvironment {
        name: environment.name,
        source_type: environment.source_type,
        kibana_url: environment.kibana_url,
        txnlst_index: environment.txnlst_index,
        txntrc_index: environment.txntrc_index,
        applog_index: environment.applog_index,
        apm_index: environment
            .apm_index
            .unwrap_or_else(|| "traces-apm*".to_string()),
        insecure_tls: environment.allow_insecure_tls.unwrap_or(false),
        ssh_applications: if environment.ssh_monitored_applications.is_empty() { environment.ssh_applications } else { environment.ssh_monitored_applications.into_iter().map(|application| application.name).collect() },
        time_zone,
        time_zone_offset,
        time_zone_source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_legacy_apm_default_and_validates_explicit_empty_index() {
        let mut environment: EnvironmentConfig = serde_json::from_str(r#"{
            "name":"test","kibanaUrl":"https://example.test","username":"reader","password":"fixture",
            "txnlstIndex":"txn-*","txntrcIndex":"trc-*","applogIndex":"app-*"
        }"#).unwrap();
        assert!(validate(&[environment.clone()]).is_ok());
        assert_eq!(to_public(environment.clone(), None).apm_index, "traces-apm*");
        environment.apm_index = Some("custom-apm-*".into());
        assert_eq!(to_public(environment.clone(), None).apm_index, "custom-apm-*");
        environment.apm_index = Some(" ".into());
        assert!(validate(&[environment]).unwrap_err().contains("APM 调用链索引不能为空"));
    }

    #[test]
    fn normalizes_known_legacy_ip_urls_to_certificate_hostnames() {
        assert_eq!(
            normalize_kibana_url("https://10.1.6.10/kibana"),
            "https://nexus.faulukenya.com/kibana"
        );
        assert_eq!(
            normalize_kibana_url("https://10.1.145.70/kibana"),
            "https://m5uat.faulukenya.com/kibana"
        );
        assert_eq!(
            normalize_kibana_url("https://other.example.test/kibana"),
            "https://other.example.test/kibana"
        );
    }
}

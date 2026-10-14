use crate::{
    domain::{EnvironmentConfig, EnvironmentSource, SshApplicationConfig},
    local_files, local_log_rules as parser,
};
use serde_json::{Value, json};
use std::io::Read;

pub(super) fn application<'a>(
    env: &'a EnvironmentConfig,
    name: Option<&str>,
) -> Result<&'a SshApplicationConfig, String> {
    if env.source_type != EnvironmentSource::Local {
        return Err("仅支持 Local 环境".into());
    }
    env.ssh_monitored_applications
        .iter()
        .find(|app| {
            Some(app.name.as_str()) == name
                || name.is_none() && env.ssh_monitored_applications.len() == 1
        })
        .ok_or_else(|| "请选择已配置的本地应用".into())
}
pub async fn read_transaction(
    env: &EnvironmentConfig,
    id: &str,
    start: &str,
    end: &str,
    app: Option<&str>,
) -> Result<String, String> {
    let env = env.clone();
    let id = id.to_string();
    let start = start.to_string();
    let end = end.to_string();
    let app = app.map(str::to_string);
    local_files::blocking(move |cancel| {
        if id.is_empty()
            || id == "."
            || id == ".."
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err("日志 ID 不合法".into());
        }
        let app = application(&env, app.as_deref())?;
        let root = local_files::root(&app.directory)?;
        let (_, _, days) = parser::range(
            &start,
            &end,
            parser::offset(env.ssh_log_time_offset.as_deref().unwrap_or("+03:00"))?,
        )?;
        let mut days = days.into_iter().collect::<Vec<_>>();
        days.sort();
        let mut contents = Vec::new();
        for day in days {
            local_files::check(cancel)?;
            let absolute = root.join("trc").join(day).join(format!("{id}.trc"));
            if let Err(error) = std::fs::metadata(&absolute) {
                if error.kind() == std::io::ErrorKind::NotFound {
                    continue;
                }
                return Err(error.to_string());
            }
            let file = local_files::metadata(&root, &absolute)?;
            if file.size > 32 * 1024 * 1024 {
                return Err("明细日志超过 32 MB，请缩小文件后重试".into());
            }
            let mut text = String::new();
            local_files::open(&root, &file)?
                .take(file.size)
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?;
            contents.push(format!(
                "===== OPSLOG SOURCE: {} =====\n{text}",
                file.relative
            ));
        }
        if contents.is_empty() {
            return Err(format!("未找到明细日志：{id}（文件可能已清理）"));
        }
        Ok(contents.join("\n"))
    })
    .await
}
pub async fn sample_logs(env: &EnvironmentConfig) -> Result<Value, String> {
    let env = env.clone();
    local_files::blocking(move|cancel|{
        if env.source_type!=EnvironmentSource::Local{return Err("仅支持 Local 环境".into());}
        let redact=regex::Regex::new(r#"(?i)((?:password|passwd|authorization|secret|token)["']?\s*[=:]\s*["']?)[^"'\s,|}]+"#).unwrap();let mut apps=Vec::new();
        for app in &env.ssh_monitored_applications{
            let root=local_files::root(&app.directory)?;let files=local_files::discover(&root,cancel)?;let summary=files.iter().find(|f|f.relative.ends_with(".lst"));
            let candidates=summary.into_iter().chain(files.iter().filter(|f|f.relative.ends_with(".log")||f.relative.ends_with(".trc"))).take(6);let mut samples=Vec::new();
            for file in candidates{
                let records=local_files::sample_records(&root,file,cancel)?;
                let content=redact.replace_all(&records.join("\n"),"${1}[REDACTED]").into_owned();if content.len()>120_000{return Err(format!("采样记录超过输入预算：{} / {}",app.name,file.relative));}
                samples.push(json!({"path":file.relative,"size":file.size,"modifiedAt":file.modified as f64/1_000_000_000.0,"summarySelected":summary.is_some_and(|s|s.relative==file.relative),"content":content}));
            }
            apps.push(json!({"name":app.name,"samples":[{"server":"Local","files":samples}],"warnings":if summary.is_some(){vec![]}else{vec!["未找到 .lst 汇总文件"]}}));
        }Ok(json!(apps))
    }).await
}

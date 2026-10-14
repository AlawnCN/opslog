use chrono::DateTime;
use fancy_regex::Regex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Deserialize)]
pub struct Field {
    pub index: Option<usize>,
    pub regex: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub name: String,
    pub role: String,
    pub paths: Vec<String>,
    pub path_mode: Option<String>,
    pub file_selection: Option<String>,
    #[serde(default)]
    pub fallback_only: bool,
    pub delimiter: String,
    pub record_end: String,
    pub timestamp_style: String,
    pub ordered: bool,
    pub fields: HashMap<String, Field>,
    #[serde(default = "default_success_pattern")]
    pub success_pattern: String,
    #[serde(default = "default_strip_async_suffix")]
    pub strip_async_suffix: bool,
}
fn default_success_pattern() -> String {
    "00000$".into()
}
fn default_strip_async_suffix() -> bool {
    true
}
pub fn compile(pattern: &str) -> Result<Regex, String> {
    fancy_regex::RegexBuilder::new(pattern)
        .backtrack_limit(1_000_000)
        .build()
        .map_err(|e| format!("日志正则无效：{e}"))
}
pub fn test(regex: &Regex, value: &str) -> Result<bool, String> {
    regex
        .is_match(value)
        .map_err(|e| format!("日志正则执行失败：{e}"))
}
pub fn offset(value: &str) -> Result<i64, String> {
    let bytes = value.as_bytes();
    if bytes.len() != 6 || !matches!(bytes[0], b'+' | b'-') || bytes[3] != b':' {
        return Err("日志 UTC 偏移无效".into());
    }
    let hours: i64 = value[1..3].parse().map_err(|_| "日志 UTC 偏移无效")?;
    let minutes: i64 = value[4..6].parse().map_err(|_| "日志 UTC 偏移无效")?;
    if hours > 23 || minutes > 59 {
        return Err("日志 UTC 偏移无效".into());
    }
    Ok((hours * 60 + minutes) * 60_000 * if bytes[0] == b'-' { -1 } else { 1 })
}
pub fn range(start: &str, end: &str, shift: i64) -> Result<(i64, i64, HashSet<String>), String> {
    let start = DateTime::parse_from_rfc3339(start)
        .map_err(|e| e.to_string())?
        .timestamp_millis();
    let end = DateTime::parse_from_rfc3339(end)
        .map_err(|e| e.to_string())?
        .timestamp_millis();
    if end <= start || end - start > 31 * 86_400_000 {
        return Err("查询时间范围须在 31 天内".into());
    }
    let days = ((start + shift).div_euclid(86_400_000)..=(end + shift).div_euclid(86_400_000))
        .map(|day| {
            DateTime::from_timestamp_millis(day * 86_400_000)
                .unwrap()
                .format("%d")
                .to_string()
        })
        .collect();
    Ok((start, end, days))
}
fn glob(pattern: &str) -> String {
    pattern
        .split("{day}")
        .map(|part| {
            part.chars()
                .map(|c| match c {
                    '*' => ".*".into(),
                    '?' => ".".into(),
                    _ => regex::escape(&c.to_string()),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("{day}")
}
pub fn paths(source: &Source, days: &HashSet<String>) -> Result<Vec<Regex>, String> {
    let mut days = days.iter().cloned().collect::<Vec<_>>();
    days.sort();
    source
        .paths
        .iter()
        .map(|pattern| {
            let pattern = if source.path_mode.as_deref() == Some("regex") {
                pattern.clone()
            } else {
                glob(pattern)
            };
            compile(&format!(
                "^(?:{})$",
                pattern.replace("{day}", &format!("(?:{})", days.join("|")))
            ))
        })
        .collect()
}
pub fn split_fields(raw: &str, delimiter: &str) -> Vec<String> {
    static PREFIX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let body = if delimiter == "|" {
        PREFIX
            .get_or_init(|| {
                regex::Regex::new(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}\s*->\s*\|?")
                    .unwrap()
            })
            .replace(raw, "")
            .into_owned()
    } else {
        raw.into()
    };
    if delimiter.is_empty() {
        return vec![body];
    }
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    let mut position = 0;
    while position < body.len() {
        let rest = &body[position..];
        if !quoted && depth == 0 && rest.starts_with(delimiter) {
            fields.push(std::mem::take(&mut field));
            position += delimiter.len();
            continue;
        }
        let c = rest.chars().next().unwrap();
        position += c.len_utf8();
        field.push(c);
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && c == '\\' {
            escaped = true;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
            continue;
        }
        if !quoted {
            if c == '{' || c == '[' {
                depth += 1;
            } else if c == '}' || c == ']' {
                depth = depth.saturating_sub(1);
            }
        }
    }
    fields.push(field);
    fields
}

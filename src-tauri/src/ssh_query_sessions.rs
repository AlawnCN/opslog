use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use std::hash::{Hash, Hasher};
use crate::domain::{EnvironmentConfig, SearchInput, SshApplicationConfig, SshServerConfig, LogKind};

#[derive(Clone)]
pub struct SnapshotSession {
    fingerprint: String,
    touched: Instant,
    pub page: usize,
    pub cursors: Value,
    pub outputs: Vec<(SshServerConfig, String)>,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, SnapshotSession>>> = OnceLock::new();
fn number(value: &Value) -> usize {
    value.as_u64().map(|v|v as usize).or_else(||value.as_str().and_then(|v|v.parse().ok())).unwrap_or(0)
}
fn has_page(session: &SnapshotSession, input: &SearchInput) -> bool {
    session.page > 0 && session.cursors.as_object().is_some_and(|cursors|cursors.values().all(|cursor|
        cursor["files"].as_object().is_some_and(|files|files.values().all(|file|
            number(&file["position"]) == 0 || number(&file["matched"]) >= input.page*input.page_size+1))))
}
pub fn server_key(server: &SshServerConfig) -> String {
    json!([server.host, server.port, server.name]).to_string()
}
pub fn load(environment: &EnvironmentConfig, app: &SshApplicationConfig, input: &SearchInput) -> Result<Option<SnapshotSession>, String> {
    let Some(id) = &input.session_id else { return Ok(None) };
    if input.kind != LogKind::Transaction { return Ok(None) }
    let sources: Vec<_> = app.log_sources.iter().filter(|source| source["role"].as_str().unwrap_or_default().starts_with("transaction") && source["fallbackOnly"] != true).collect();
    if sources.is_empty() || sources.iter().any(|source| source["role"] != "transaction" || source["recordEnd"] != "newline") { return Ok(None) }
    let mut query = serde_json::to_value(input).map_err(|e|e.to_string())?;
    query["page"] = json!(0); query["sessionId"] = Value::Null;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    json!([environment, query]).to_string().hash(&mut hash);
    let fingerprint = hash.finish().to_string();
    let mut sessions = SESSIONS.get_or_init(||Mutex::new(HashMap::new())).lock().map_err(|_|"查询会话锁不可用")?;
    sessions.retain(|_, session|session.touched.elapsed() < Duration::from_secs(900));
    if let Some(session) = sessions.get_mut(id) {
        if session.fingerprint != fingerprint { return Err("查询条件或配置已变化，请重新查询首页".into()) }
        if input.page > session.page + 1 { return Err("请按顺序翻页，或重新查询首页".into()) }
        if has_page(session, input) {session.page = session.page.max(input.page);}
        session.touched = Instant::now(); return Ok(Some(session.clone()));
    }
    if input.page != 1 { return Err("SSH 查询会话已过期，请重新查询首页".into()) }
    while sessions.len() >= 8 {
        let oldest = sessions.iter().min_by_key(|(_, session)|session.touched).map(|(key,_)|key.clone()).unwrap();
        sessions.remove(&oldest);
    }
    let session = SnapshotSession { fingerprint, touched: Instant::now(), page: 0, cursors: json!({}), outputs: vec![] };
    sessions.insert(id.clone(), session.clone()); Ok(Some(session))
}
pub fn append(mut session: SnapshotSession, outputs: Vec<(SshServerConfig, String)>, input: &SearchInput) -> Result<SnapshotSession, String> {
    for (server, raw) in outputs {
        let cursor = raw.lines().find_map(|line|line.strip_prefix("@OPSLOG_CURSOR\t")).ok_or("SSH 查询未返回续读位置，请重新查询首页")?;
        let key = server_key(&server);
        session.cursors[&key] = serde_json::from_str(cursor).map_err(|_|"SSH 查询续读位置无效")?;
        let records = raw.lines().filter(|line|line.starts_with("@OPSLOG_ROW\t")).collect::<Vec<_>>().join("\n") + "\n";
        if let Some((_, previous)) = session.outputs.iter_mut().find(|(existing,_)|server_key(existing)==key) { previous.push_str(&records); }
        else { session.outputs.push((server, records)); }
    }
    if session.outputs.iter().map(|(_,raw)|raw.len()).sum::<usize>() > 16*1024*1024 { return Err("查询会话达到内存安全上限，请增加筛选条件后重新查询首页".into()) }
    let mut sessions = SESSIONS.get().unwrap().lock().map_err(|_|"查询会话锁不可用")?;
    let id = input.session_id.clone().unwrap();
    if sessions.get(&id).map(|entry|entry.page) != Some(session.page) { return Err("同一查询会话已有翻页请求完成，请重试当前页".into()) }
    session.page = input.page; session.touched = Instant::now();
    sessions.insert(id, session.clone());
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sessions_bind_filters_and_reuse_buffer_without_advancing_file_cursor() {
        let environment: EnvironmentConfig = serde_json::from_value(json!({"name":"cursor-fixture","sourceType":"ssh"})).unwrap();
        let application: SshApplicationConfig = serde_json::from_value(json!({"name":"cte","directory":"/fixture","logSources":[{"role":"transaction","recordEnd":"newline"}]})).unwrap();
        let mut input: SearchInput = serde_json::from_value(json!({"sessionId":"00000000-0000-4000-8000-000000000001","environment":"cursor-fixture","application":"cte","kind":"transaction","startTime":"2026-10-12T00:00:00Z","endTime":"2026-10-13T00:00:00Z","page":1,"pageSize":50})).unwrap();
        let session = load(&environment, &application, &input).unwrap().unwrap();
        let server: SshServerConfig = serde_json::from_value(json!({"name":"first","host":"fixture"})).unwrap();
        let output = "@OPSLOG_ROW\t{\"values\":{\"logId\":\"one\"}}\n@OPSLOG_CURSOR\t{\"files\":{\"a\":{\"position\":\"100\",\"matched\":\"115\"}}}\n".to_string();
        let committed = append(session.clone(), vec![(server.clone(),output.clone())], &input).unwrap();
        assert_eq!(committed.page, 1);
        assert!(append(session,vec![(server,output)],&input).is_err());
        input.page = 2;
        let cached = load(&environment,&application,&input).unwrap().unwrap();
        assert_eq!(cached.page,2);
        assert_eq!(number(&cached.cursors[&server_key(&cached.outputs[0].0)]["files"]["a"]["position"]),100);
        input.keyword = Some("changed".into());
        assert!(load(&environment,&application,&input).is_err());
        input.session_id = Some("00000000-0000-4000-8000-000000000002".into());
        assert!(load(&environment,&application,&input).is_err());
    }
    #[test]
    fn exhausted_streams_do_not_require_more_matching_rows() {
        let session = SnapshotSession {fingerprint:String::new(),touched:Instant::now(),page:1,cursors:json!({"one":{"files":{"a":{"position":0,"matched":1}}},"two":{"files":{"b":{"position":100,"matched":115}}}}),outputs:vec![]};
        let mut input: SearchInput = serde_json::from_value(json!({"environment":"test","kind":"transaction","startTime":"","endTime":"","page":2,"pageSize":50})).unwrap();
        assert!(has_page(&session,&input));
        input.page=3; assert!(!has_page(&session,&input));
    }
}

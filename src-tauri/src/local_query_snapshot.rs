use crate::{
    domain::{EnvironmentConfig, SearchInput},
    local_files::{self, Cancel, LocalFile},
};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Snapshot {
    created: Instant,
    key: String,
    files: Vec<LocalFile>,
}
static SESSIONS: OnceLock<Mutex<HashMap<String, Snapshot>>> = OnceLock::new();
pub(super) fn snapshot(
    env: &EnvironmentConfig,
    input: &SearchInput,
    root: &std::path::Path,
    cancel: &Cancel,
    export_all: bool,
) -> Result<Vec<LocalFile>, String> {
    let mut normalized = input.clone();
    normalized.page = 0;
    normalized.session_id = None;
    let key = serde_json::to_string(&(env, normalized)).map_err(|e| e.to_string())?;
    let store = SESSIONS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(id) = input.session_id.as_ref().filter(|_| !export_all) {
        let mut sessions = store.lock().map_err(|e| e.to_string())?;
        sessions.retain(|_, s| s.created.elapsed() < Duration::from_secs(1800));
        if let Some(snapshot) = sessions.get(id) {
            if snapshot.key != key {
                return Err("查询条件已变更，请重新查询首页".into());
            }
            return Ok(snapshot.files.clone());
        }
        if input.page > 1 {
            return Err("查询会话已失效，请重新查询首页".into());
        }
    }
    let files = local_files::discover(root, cancel)?;
    if let Some(id) = input.session_id.as_ref().filter(|_| !export_all) {
        let mut sessions = store.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= 32 {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, s)| s.created)
                .map(|(id, _)| id.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(
            id.clone(),
            Snapshot {
                created: Instant::now(),
                key,
                files: files.clone(),
            },
        );
    }
    Ok(files)
}

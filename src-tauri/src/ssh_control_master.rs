#[cfg(unix)]
mod unix {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::os::unix::fs::DirBuilderExt;
    use std::path::PathBuf;
    use crate::domain::SshServerConfig;

    struct Master { scope: String, identity: String, path: PathBuf, destination: String }
    #[derive(Default)]
    struct Masters { directory: Option<PathBuf>, sequence: u64, entries: HashMap<String, Master> }
    static MASTERS: OnceLock<Mutex<Masters>> = OnceLock::new();

    fn stop(master: Master) {
        // Control commands address only our private socket, never another app's master.
        if let Ok(mut child) = std::process::Command::new("ssh").args(["-S", &master.path.to_string_lossy(), "-O", "exit", &master.destination])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
            std::thread::spawn(move || { let _ = child.wait(); });
        }
    }

    pub fn close(scope: Option<&str>) {
        if let Ok(mut masters) = MASTERS.get_or_init(Mutex::default).lock() {
            let keys: Vec<_> = masters.entries.iter().filter(|(_, master)| scope.is_none_or(|name| name == master.scope)).map(|(key, _)| key.clone()).collect();
            for key in keys { if let Some(master) = masters.entries.remove(&key) { stop(master); } }
        }
    }

    pub fn options(scope: &str, server: &SshServerConfig, destination: &str, connect_timeout: u64) -> Result<Vec<String>, String> {
        let identity = serde_json::to_string(&(scope, server, connect_timeout)).map_err(|error| error.to_string())?;
        let mut masters = MASTERS.get_or_init(Mutex::default).lock().map_err(|_| "SSH 连接管理不可用")?;
        if !masters.entries.contains_key(&identity) {
            if masters.entries.len() >= 32 {
                let key = masters.entries.keys().next().cloned();
                if let Some(master) = key.and_then(|key| masters.entries.remove(&key)) { stop(master); }
            }
            if masters.directory.is_none() {
                let mut random = [0_u8; 12];
                getrandom::fill(&mut random).map_err(|error| error.to_string())?;
                let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
                let directory = PathBuf::from(format!("/tmp/opslog-ssh-{suffix}"));
                std::fs::DirBuilder::new().mode(0o700).create(&directory).map_err(|error| format!("SSH 复用目录创建失败：{error}"))?;
                masters.directory = Some(directory);
            }
            masters.sequence += 1;
            let path = masters.directory.as_ref().unwrap().join(masters.sequence.to_string());
            masters.entries.insert(identity.clone(), Master { scope: scope.to_string(), identity: identity.clone(), path, destination: destination.to_string() });
        }
        let master = masters.entries.get(&identity).unwrap();
        debug_assert_eq!(master.identity, identity);
        Ok(vec!["-o".into(), "ControlMaster=auto".into(), "-o".into(), "ControlPersist=600".into(), "-o".into(), format!("ControlPath={}", master.path.display()), "-o".into(), "ServerAliveInterval=30".into(), "-o".into(), "ServerAliveCountMax=3".into()])
    }
}

#[cfg(unix)]
pub use unix::{close, options};
#[cfg(not(unix))]
pub fn close(_scope: Option<&str>) {}
#[cfg(not(unix))]
pub fn options(_scope: &str, _server: &crate::domain::SshServerConfig, _destination: &str, _connect_timeout: u64) -> Result<Vec<String>, String> { Ok(Vec::new()) }

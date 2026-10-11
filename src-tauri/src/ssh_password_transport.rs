use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use ssh2::{HashType, KeyboardInteractivePrompt, Prompt, Session};

use crate::domain::SshServerConfig;

const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
type Connection = (Session, TcpStream, Instant);
type Slot = Arc<tokio::sync::Mutex<Option<Connection>>>;
type Pool = HashMap<(String, u64), Slot>;
static CONNECTIONS: OnceLock<Mutex<Pool>> = OnceLock::new();

fn pool() -> &'static Mutex<Pool> {
    CONNECTIONS.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            if let Some(pool) = CONNECTIONS.get() {
                if let Ok(mut pool) = pool.lock() {
                    pool.retain(|_, slot| slot.try_lock().map(|connection| connection.as_ref().is_some_and(|(_, _, used)| used.elapsed() < IDLE_TIMEOUT)).unwrap_or(true));
                }
            }
        });
        Mutex::default()
    })
}

pub fn close_connections(scope: Option<&str>) {
    if let Ok(mut pool) = pool().lock() {
        pool.retain(|(environment, _), _| scope.is_some_and(|name| name != environment));
    }
}

fn connection_slot(scope: &str, server: &SshServerConfig, connect_timeout: u64) -> Result<Slot, String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(server).map_err(|error| error.to_string())?.hash(&mut hasher);
    connect_timeout.hash(&mut hasher);
    let key = (scope.to_string(), hasher.finish());
    let mut pool = pool().lock().map_err(|_| "SSH 连接池不可用")?;
    // Idle sessions are dropped on access; busy slots are never evicted/reused.
    pool.retain(|_, slot| slot.try_lock().map(|connection| connection.as_ref().is_some_and(|(_, _, used)| used.elapsed() < IDLE_TIMEOUT)).unwrap_or(true));
    if let Some(slot) = pool.get(&key) { return Ok(slot.clone()); }
    if pool.len() >= 32 { return Err("SSH 连接过多，请稍后重试".into()); }
    let slot = Arc::new(tokio::sync::Mutex::new(None));
    pool.insert(key, slot.clone());
    Ok(slot)
}

struct PasswordPrompt(String);

struct CancelSocket(Option<TcpStream>);

impl Drop for CancelSocket {
    fn drop(&mut self) { if let Some(socket) = &self.0 { let _ = socket.shutdown(Shutdown::Both); } }
}

impl KeyboardInteractivePrompt for PasswordPrompt {
    fn prompt<'a>(&mut self, _username: &str, _instructions: &str, prompts: &[Prompt<'a>]) -> Vec<String> {
        prompts.iter().map(|_| self.0.clone()).collect()
    }
}

fn authenticate(server: &SshServerConfig, socket: TcpStream, timeout_seconds: u64, connect_timeout: u64) -> Result<Session, String> {
    let timeout_ms = timeout_seconds.saturating_add(connect_timeout).saturating_add(10).saturating_mul(1000).min(u32::MAX as u64) as u32;
    let mut session = Session::new().map_err(|error| format!("SSH 会话初始化失败：{error}"))?;
    session.set_tcp_stream(socket);
    session.set_timeout(timeout_ms);
    session.handshake().map_err(|error| format!("SSH 握手失败：{error}"))?;
    let hash = session.host_key_hash(HashType::Sha256).ok_or("SSH 服务器没有提供可验证的主机密钥")?;
    let fingerprint = format!("SHA256:{}", base64::engine::general_purpose::STANDARD_NO_PAD.encode(hash));
    let port = server.port.unwrap_or(22);
    match server.host_key_fingerprint.as_deref().filter(|value| !value.is_empty()) {
        None => return Err(format!("首次连接需核对 SSH 服务器指纹；请使用最新版客户端确认。SSH_HOST_KEY_REQUIRED|{}|{port}|{fingerprint}", server.host)),
        Some(known) if known != fingerprint => return Err(format!("服务器 {}:{port} 的 SSH 主机指纹已改变，已拒绝连接；请联系管理员核对。当前指纹 {fingerprint}", server.host)),
        _ => {}
    }
    let username = server.username.as_deref().unwrap_or_default();
    let password = server.password.as_deref().unwrap_or_default();
    if session.userauth_password(username, password).is_err() {
        session.userauth_keyboard_interactive(username, &mut PasswordPrompt(password.to_string()))
            .map_err(|_| "SSH 用户名或密码认证失败".to_string())?;
    }
    if !session.authenticated() { return Err("SSH 用户名或密码认证失败".into()); }
    session.set_keepalive(true, 30);
    Ok(session)
}

fn execute(session: &Session, script: String, args: Vec<String>, timeout_seconds: u64, connect_timeout: u64) -> Result<String, String> {
    session.set_timeout(timeout_seconds.saturating_add(connect_timeout).saturating_add(10).saturating_mul(1000).min(u32::MAX as u64) as u32);
    let mut channel = session.channel_session().map_err(|error| format!("SSH 通道建立失败：{error}"))?;
    channel.exec(&format!("timeout {timeout_seconds} sh -s -- {}", args.join(" ")))
        .map_err(|error| format!("SSH 命令启动失败：{error}"))?;
    channel.write_all(script.as_bytes()).map_err(|error| format!("SSH 脚本发送失败：{error}"))?;
    channel.send_eof().map_err(|error| format!("SSH 脚本发送失败：{error}"))?;
    let mut output = Vec::new();
    Read::by_ref(&mut channel).take(MAX_OUTPUT_BYTES + 1).read_to_end(&mut output).map_err(|error| format!("SSH 输出读取失败：{error}"))?;
    if output.len() as u64 > MAX_OUTPUT_BYTES { return Err("SSH 返回内容超过 64 MB 安全上限，请缩小查询范围".into()); }
    let mut stderr = Vec::new();
    channel.stderr().take(64 * 1024 + 1).read_to_end(&mut stderr).map_err(|error| format!("SSH 错误输出读取失败：{error}"))?;
    channel.close().map_err(|error| format!("SSH 通道关闭失败：{error}"))?;
    channel.wait_close().map_err(|error| format!("SSH 查询失败：{error}"))?;
    let status = channel.exit_status().map_err(|error| format!("SSH 查询失败：{error}"))?;
    if status != 0 {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if detail.is_empty() { format!("SSH 命令执行失败：{status}") } else { detail });
    }
    String::from_utf8(output).map_err(|_| "SSH 返回的日志不是有效 UTF-8 文本".to_string())
}

fn socket_alive(socket: &TcpStream) -> bool {
    if socket.set_nonblocking(true).is_err() { return false; }
    let alive = match socket.peek(&mut [0_u8; 1]) {
        Ok(0) => false,
        Ok(_) => true,
        Err(error) => error.kind() == std::io::ErrorKind::WouldBlock,
    };
    socket.set_nonblocking(false).is_ok() && alive
}

pub async fn run(scope: String, server: SshServerConfig, script: String, args: Vec<String>, timeout_seconds: u64, connect_timeout: u64) -> Result<String, String> {
    let slot = connection_slot(&scope, &server, connect_timeout)?;
    let mut cached = slot.lock().await;
    let connection = cached.take().filter(|(_, socket, used)| used.elapsed() < IDLE_TIMEOUT && socket_alive(socket));
    if let Some((session, socket, _)) = connection {
        let mut cancel = CancelSocket(Some(socket.try_clone().map_err(|error| error.to_string())?));
        let (session, socket, result) = tokio::task::spawn_blocking(move || {
            let result = execute(&session, script, args, timeout_seconds, connect_timeout);
            (session, socket, result)
        }).await.map_err(|error| format!("SSH 查询任务失败：{error}"))?;
        if result.is_ok() {
            cancel.0 = None;
            *cached = Some((session, socket, Instant::now()));
        }
        return result;
    }
    let address = format!("{}:{}", server.host, server.port.unwrap_or(22));
    let socket = tokio::time::timeout(
        std::time::Duration::from_secs(connect_timeout), tokio::net::TcpStream::connect(&address)
    ).await.map_err(|_| "SSH 连接超时".to_string())?
        .map_err(|error| format!("SSH 连接失败：{error}"))?;
    let socket = socket.into_std().map_err(|error| format!("SSH 连接失败：{error}"))?;
    socket.set_nonblocking(false).map_err(|error| format!("SSH 连接失败：{error}"))?;
    let mut cancel = CancelSocket(Some(socket.try_clone().map_err(|error| format!("SSH 连接失败：{error}"))?));
    let (session, socket, result) = tokio::task::spawn_blocking(move || {
        let session = authenticate(&server, socket.try_clone().map_err(|error| error.to_string())?, timeout_seconds, connect_timeout)?;
        let result = execute(&session, script, args, timeout_seconds, connect_timeout);
        Ok::<_, String>((session, socket, result))
    }).await.map_err(|error| format!("SSH 查询任务失败：{error}"))??;
    if result.is_ok() {
        cancel.0 = None;
        *cached = Some((session, socket, Instant::now()));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SshAuthentication;

    // Executed by tests/ssh-native-pool.test.ts against a local SSH server which
    // counts TCP connections and authentication attempts, not just mocked calls.
    #[test]
    #[ignore = "requires the local SSH fixture"]
    fn native_pool_reuses_and_releases_authenticated_sessions() {
        let server = SshServerConfig {
            name: "fixture".into(), host: "127.0.0.1".into(),
            port: Some(std::env::var("OPSLOG_SSH_POOL_TEST_PORT").unwrap().parse().unwrap()),
            username: Some("reader".into()), password: Some("secret".into()),
            authentication: SshAuthentication::Password, private_key_path: None,
            host_key_fingerprint: Some(std::env::var("OPSLOG_SSH_POOL_TEST_PIN").unwrap()),
        };
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            for script in ["first", "second", "third"] {
                let result = run("native-fixture".into(), server.clone(), script.into(), vec![], 5, 5).await.unwrap();
                assert_eq!(result, format!("received:{script}"));
            }
            close_connections(Some("unrelated"));
            assert_eq!(run("native-fixture".into(), server.clone(), "fourth".into(), vec![], 5, 5).await.unwrap(), "received:fourth");
            let (left, right) = tokio::join!(
                run("native-fixture".into(), server.clone(), "parallel-left".into(), vec![], 5, 5),
                run("native-fixture".into(), server.clone(), "parallel-right".into(), vec![], 5, 5)
            );
            assert_eq!(left.unwrap(), "received:parallel-left");
            assert_eq!(right.unwrap(), "received:parallel-right");
            close_connections(Some("native-fixture"));
            assert_eq!(run("native-fixture".into(), server.clone(), "after-release".into(), vec![], 5, 5).await.unwrap(), "received:after-release");
            let mut wrong = server.clone();
            wrong.host_key_fingerprint = Some("SHA256:wrong".into());
            assert!(run("native-fixture".into(), wrong, "must-not-run".into(), vec![], 5, 5).await.unwrap_err().contains("主机指纹已改变"));
            assert!(tokio::time::timeout(Duration::from_millis(100), run("native-fixture".into(), server.clone(), "slow".into(), vec![], 5, 5)).await.is_err());
            assert_eq!(run("native-fixture".into(), server, "after-cancel".into(), vec![], 5, 5).await.unwrap(), "received:after-cancel");
            close_connections(None);
        });
    }
}

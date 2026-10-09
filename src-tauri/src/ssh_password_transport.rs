use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};

use base64::Engine;
use ssh2::{HashType, KeyboardInteractivePrompt, Prompt, Session};

use crate::domain::SshServerConfig;

const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;

struct PasswordPrompt(String);

struct CancelSocket(TcpStream);

impl Drop for CancelSocket {
    fn drop(&mut self) { let _ = self.0.shutdown(Shutdown::Both); }
}

impl KeyboardInteractivePrompt for PasswordPrompt {
    fn prompt<'a>(&mut self, _username: &str, _instructions: &str, prompts: &[Prompt<'a>]) -> Vec<String> {
        prompts.iter().map(|_| self.0.clone()).collect()
    }
}

fn execute(server: SshServerConfig, socket: TcpStream, script: String, args: Vec<String>, timeout_seconds: u64, connect_timeout: u64) -> Result<String, String> {
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
    channel.wait_close().map_err(|error| format!("SSH 查询失败：{error}"))?;
    let status = channel.exit_status().map_err(|error| format!("SSH 查询失败：{error}"))?;
    if status != 0 {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if detail.is_empty() { format!("SSH 命令执行失败：{status}") } else { detail });
    }
    String::from_utf8(output).map_err(|_| "SSH 返回的日志不是有效 UTF-8 文本".to_string())
}

pub async fn run(server: SshServerConfig, script: String, args: Vec<String>, timeout_seconds: u64, connect_timeout: u64) -> Result<String, String> {
    let address = format!("{}:{}", server.host, server.port.unwrap_or(22));
    let socket = tokio::time::timeout(
        std::time::Duration::from_secs(connect_timeout), tokio::net::TcpStream::connect(&address)
    ).await.map_err(|_| "SSH 连接超时".to_string())?
        .map_err(|error| format!("SSH 连接失败：{error}"))?;
    let socket = socket.into_std().map_err(|error| format!("SSH 连接失败：{error}"))?;
    socket.set_nonblocking(false).map_err(|error| format!("SSH 连接失败：{error}"))?;
    let _cancel_socket = CancelSocket(socket.try_clone().map_err(|error| format!("SSH 连接失败：{error}"))?);
    tokio::task::spawn_blocking(move || execute(server, socket, script, args, timeout_seconds, connect_timeout))
        .await.map_err(|error| format!("SSH 查询任务失败：{error}"))?
}

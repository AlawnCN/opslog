use super::*;
use crate::domain::SshAuthentication;

#[test]
fn liveness_probe_preserves_nonblocking_socket_mode() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (_peer, _) = listener.accept().unwrap();
    socket.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    socket.set_nonblocking(true).unwrap();
    assert!(socket_alive(&socket));
    let started = Instant::now();
    assert_eq!(socket.peek(&mut [0_u8; 1]).unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
    assert!(started.elapsed() < Duration::from_millis(100), "probe restored blocking mode on libssh2's socket");
}

// Opt-in, read-only verification using a caller-selected configuration.
// Never print credentials or business log contents.
#[test]
#[ignore = "requires an explicitly selected live SSH environment"]
fn native_live_query_and_detail_reuse() {
    use crate::domain::{EnvironmentConfig, SearchInput};
    let path = std::env::var("OPSLOG_SSH_REGRESSION_CONFIG").unwrap();
    let name = std::env::var("OPSLOG_SSH_REGRESSION_ENVIRONMENT").unwrap();
    let application = std::env::var("OPSLOG_SSH_REGRESSION_APPLICATION").unwrap();
    let configs: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let environment: EnvironmentConfig = serde_json::from_value(configs.into_iter().find(|value| value["name"] == name).expect("environment not found")).unwrap();
    let now = chrono::Utc::now();
    let mut input: SearchInput = serde_json::from_value(serde_json::json!({
        "sessionId": "a1ea1078-6783-4427-9a10-81eca5a5fe56",
        "environment": name, "kind": "transaction", "application": application,
        "startTime": (now - chrono::Duration::hours(24)).to_rfc3339(),
        "endTime": now.to_rfc3339(), "page": 1, "pageSize": 500
    })).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        crate::ssh_log_source::resolve_time_profile(&environment).await;
        for attempt in 1..=3 {
            input.session_id = Some(format!("a1ea1078-6783-4427-9a10-{attempt:012}"));
            let started = Instant::now();
            let result = crate::ssh_log_source::search(&environment, &input, false).await.unwrap();
            assert!(result.warnings.is_empty(), "query returned warnings");
            assert!(!result.rows.is_empty(), "no current summary records to verify");
            eprintln!("query {attempt}: {} rows, {} ms", result.rows.len(), started.elapsed().as_millis());
            assert!(started.elapsed() < Duration::from_secs(15));
            let id = result.rows[0]["ecp.txn.id"].as_str().unwrap();
            let started = Instant::now();
            let detail = crate::ssh_log_source::read_transaction(&environment, id, &input.start_time, &input.end_time, Some(&application)).await;
            match detail {
                Ok(content) => { assert!(!content.contains("OPSLOG WARNING")); eprintln!("detail {attempt}: {} bytes, {} ms", content.len(), started.elapsed().as_millis()); }
                Err(error) => { assert!(error.contains("未找到"), "detail lookup failed"); eprintln!("detail {attempt}: not found, {} ms", started.elapsed().as_millis()); }
            }
            assert!(started.elapsed() < Duration::from_secs(15));
        }
        close_connections(Some(&environment.name));
    });
}

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
        // Query/detail scripts are much larger than the tiny pool probes.
        let script = "detail-script\n".repeat(4096);
        assert_eq!(run("native-fixture".into(), server.clone(), script.clone(), vec![], 5, 5).await.unwrap(), format!("received:{script}"));
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
        assert_eq!(run("native-fixture".into(), server.clone(), "after-cancel".into(), vec![], 5, 5).await.unwrap(), "received:after-cancel");
        let started = Instant::now();
        assert!(run("native-fixture".into(), server.clone(), "slow".into(), vec![], 0, 1).await.unwrap_err().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(14));
        assert_eq!(run("native-fixture".into(), server, "after-timeout".into(), vec![], 5, 5).await.unwrap(), "received:after-timeout");
        close_connections(None);
    });
}

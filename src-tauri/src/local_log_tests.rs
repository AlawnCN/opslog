use crate::{
    domain::{EnvironmentConfig, SearchInput},
    local_files, local_log_source,
};
use serde_json::{Value, json};
use std::{
    fs,
    sync::{Arc, atomic::AtomicBool},
};

struct Fixture {
    root: std::path::PathBuf,
    env: EnvironmentConfig,
    input: SearchInput,
    records: Vec<String>,
    summary: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "opslog-local-rust-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("应用 cte/filebeat/trc")).unwrap();
        fs::create_dir_all(root.join("应用 cte/trc/14")).unwrap();
        fs::create_dir_all(root.join("应用 cte/log")).unwrap();
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/local-log-records.json"))
                .unwrap();
        let records = fixture["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let summary = root.join("应用 cte/filebeat/trc/txn_cte.lst");
        fs::write(&summary, records.join("\n") + "\n").unwrap();
        let env=serde_json::from_value(json!({"name":"Local Test","sourceType":"local","timeZone":"Asia/Shanghai","sshLogTimeOffset":"+08:00","sshMonitoredApplications":[{"name":"cte","directory":root.join("应用 cte")}]})).unwrap();
        let input=serde_json::from_value(json!({"environment":"Local Test","kind":"transaction","application":"cte","startTime":fixture["start"],"endTime":fixture["end"],"page":1,"pageSize":50})).unwrap();
        Self {
            root,
            env,
            input,
            records,
            summary,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn native_local_parses_filters_and_exact_details_without_external_runtime() {
    let mut fixture = Fixture::new();
    let result = local_log_source::search(&fixture.env, &fixture.input, false)
        .await
        .unwrap();
    assert_eq!(result.rows.len(), 3);
    assert_eq!(result.rows[0]["ecp.txn.id"], "T.local-3");
    assert_eq!(
        result.rows[0]["ecp.txn.message.info"],
        "Failure [BSP|batch|default|service]"
    );
    assert_eq!(
        result.rows[0]["ecp.txn.timestamp"],
        "2026-10-14T02:00:02.133Z"
    );
    assert_eq!(result.rows[2]["ecp.txn.src.node.id"], "tlr.u_0_152");
    fixture.input.status = Some(crate::domain::SearchStatus::Success);
    fixture.input.service = Some("receive".into());
    fixture.input.min_duration_ms = Some(20);
    assert_eq!(
        local_log_source::search(&fixture.env, &fixture.input, false)
            .await
            .unwrap()
            .rows[0]["ecp.txn.id"],
        "T.local-2"
    );
    let missing = local_log_source::read_transaction(
        &fixture.env,
        "T.local-1",
        &fixture.input.start_time,
        &fixture.input.end_time,
        Some("cte"),
    )
    .await
    .unwrap_err();
    assert!(missing.contains("未找到明细日志"));
    fs::write(
        fixture.root.join("应用 cte/trc/14/T.local-1.trc"),
        "CORRECT 中文 DETAIL",
    )
    .unwrap();
    assert!(
        local_log_source::read_transaction(
            &fixture.env,
            "T.local-1",
            &fixture.input.start_time,
            &fixture.input.end_time,
            Some("cte")
        )
        .await
        .unwrap()
        .contains("CORRECT 中文 DETAIL")
    );
    assert!(
        local_log_source::read_transaction(
            &fixture.env,
            "../secret",
            &fixture.input.start_time,
            &fixture.input.end_time,
            Some("cte")
        )
        .await
        .is_err()
    );
    let samples = local_log_source::sample_logs(&fixture.env).await.unwrap();
    assert_eq!(samples[0]["samples"][0]["server"], "Local");
    assert_eq!(
        samples[0]["samples"][0]["files"][0]["summarySelected"],
        true
    );
}

#[tokio::test]
async fn native_local_snapshot_freezes_appends_and_isolates_apps() {
    let mut fixture = Fixture::new();
    fs::write(
        &fixture.summary,
        (0..120)
            .map(|i| {
                fixture.records[0]
                    .replace("T.local-1", &format!("ID-{i:03}"))
                    .replace("10:00:00,123", &format!("10:00:{:02},123", i / 2))
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    fixture.input.session_id = Some("00000000-0000-0000-0000-000000000001".into());
    assert_eq!(
        local_log_source::search(&fixture.env, &fixture.input, false)
            .await
            .unwrap()
            .rows
            .len(),
        51
    );
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(&fixture.summary)
        .unwrap()
        .write_all(
            (fixture.records[2]
                .replace("T.local-3", "APPENDED")
                .replace("10:00:02.133", "10:01:00.000")
                + "\n")
                .as_bytes(),
        )
        .unwrap();
    fixture.input.page = 2;
    let next = local_log_source::search(&fixture.env, &fixture.input, false)
        .await
        .unwrap();
    assert_eq!(next.rows.len(), 101);
    assert!(next.rows.iter().all(|row| row["ecp.txn.id"] != "APPENDED"));
    fixture.input.page = 1;
    fixture.input.session_id = Some("00000000-0000-0000-0000-000000000002".into());
    assert_eq!(
        local_log_source::search(&fixture.env, &fixture.input, false)
            .await
            .unwrap()
            .rows[0]["ecp.txn.id"],
        "APPENDED"
    );
    fixture.input.application = Some("missing".into());
    assert!(
        local_log_source::search(&fixture.env, &fixture.input, false)
            .await
            .unwrap_err()
            .contains("请选择")
    );
}

#[tokio::test]
async fn native_local_handles_multiline_rules_unicode_chunks_and_lookarounds() {
    let mut fixture = Fixture::new();
    let record = fixture.records[0].replace(
        "The teller information does not exist",
        &"中文".repeat(20_000),
    );
    fs::write(&fixture.summary, format!("{record}\n{record}")).unwrap();
    let result = local_log_source::search(&fixture.env, &fixture.input, false)
        .await
        .unwrap();
    assert_eq!(result.rows.len(), 2);
    assert_eq!(
        result.rows[0]["ecp.txn.message.info"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        40_000
    );
    fs::create_dir_all(fixture.root.join("应用 cte/custom/2026")).unwrap();
    fs::write(fixture.root.join("应用 cte/custom/2026/app.log"),"2026-10-14 10:00:00.000 §§ INFO §§ first\nsecond §§ logEnd\n2026-10-14 10:00:01.000 §§ ERROR §§ final §§ logEnd").unwrap();
    fixture.env.ssh_monitored_applications[0].log_sources = vec![
        json!({"name":"structured","role":"application","pathMode":"regex","paths":["^custom/\\d{4}/(?=app)app\\.log$"],"delimiter":" §§ ","recordEnd":" §§ logEnd","timestampStyle":"full","ordered":true,"fields":{"timestamp":{"index":0},"level":{"index":1},"message":{"index":2}},"successPattern":"00000$","stripAsyncSuffix":false}),
    ];
    fixture.input.kind = crate::domain::LogKind::Application;
    fixture.input.keyword = Some("first".into());
    let rows = local_log_source::search(&fixture.env, &fixture.input, false)
        .await
        .unwrap()
        .rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["message"], "first\nsecond");
}

#[test]
fn native_local_cancellation_and_path_boundaries() {
    let fixture = Fixture::new();
    let cancel = Arc::new(AtomicBool::new(true));
    assert!(local_files::discover(&fixture.root, &cancel).is_err());
    #[cfg(unix)]
    {
        let outside = fixture.root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.trc"), "SECRET").unwrap();
        let app = local_files::root(&fixture.env.ssh_monitored_applications[0].directory).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.trc"), app.join("trc/14/SECRET.trc"))
            .unwrap();
        assert!(
            local_files::metadata(&app, &app.join("trc/14/SECRET.trc"))
                .unwrap_err()
                .contains("超出应用目录")
        );
    }
}

#[tokio::test]
async fn native_local_finishes_timestamp_groups_and_samples_head_tail() {
    let mut fixture = Fixture::new();
    let mut sources: Vec<Value> =
        serde_json::from_str(include_str!("../../shared/file-log-defaults.json")).unwrap();
    sources[0]["ordered"] = json!(true);
    fixture.env.ssh_monitored_applications[0].log_sources = vec![sources[0].clone()];
    let rows = (0..80)
        .map(|index| fixture.records[0].replace("T.local-1", &format!("TIE-{:03}", 79 - index)))
        .collect::<Vec<_>>();
    fs::write(&fixture.summary, rows.join("\n") + "\n").unwrap();
    let result = local_log_source::search(&fixture.env, &fixture.input, false)
        .await
        .unwrap();
    assert_eq!(result.rows.len(), 51);
    assert_eq!(result.rows[0]["ecp.txn.id"], "TIE-079");
    assert_eq!(result.rows[50]["ecp.txn.id"], "TIE-029");
    let sample = local_log_source::sample_logs(&fixture.env).await.unwrap();
    let content = sample[0]["samples"][0]["files"][0]["content"]
        .as_str()
        .unwrap();
    assert!(content.contains("TIE-079|"));
    assert!(content.contains("TIE-000|"));
    assert_eq!(content.lines().count(), 6);
}

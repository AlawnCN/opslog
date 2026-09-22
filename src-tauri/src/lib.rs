#![cfg_attr(feature = "reader-app", allow(dead_code))]

mod ai_analysis;
mod ai_configuration;
mod commands;
mod domain;
mod environment_store;
mod export_files;
mod kibana_client;
mod lan_server;
mod query_builders;
#[cfg(feature = "reader-app")]
mod reader_association;
#[cfg(feature = "reader-app")]
mod reader_files;
mod reader_settings;
mod ssh_log_source;
mod update_release;

#[cfg(feature = "reader-app")]
use tauri::{Emitter, Manager};

#[cfg(not(feature = "reader-app"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lan_server::LanShareManager::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_analysis::load_ai_configuration,
            ai_analysis::save_ai_configuration,
            ai_analysis::activate_ai_configuration,
            ai_analysis::delete_ai_configuration,
            ai_analysis::discover_ai_models,
            ai_analysis::analyze_log_with_ai,
            commands::load_environments,
            commands::load_environment_configuration,
            commands::save_environment_config,
            commands::search_logs,
            commands::export_logs,
            commands::download_transaction_log,
            commands::read_transaction_log,
            commands::save_transaction_log,
            commands::save_custom_log_markers,
            commands::save_portable_log,
            commands::save_ai_analysis,
            commands::load_trace,
            reader_settings::load_reader_settings,
            reader_settings::save_reader_setting,
            update_release::load_update_release_notes,
            lan_server::get_lan_share_status,
            lan_server::set_lan_share_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("OpsLog application failed");
}

#[cfg(feature = "reader-app")]
pub fn run_reader() {
    let pending_file =
        reader_files::PendingTrcFile(std::sync::Mutex::new(reader_files::startup_trc_path()));
    let app = tauri::Builder::default()
        .manage(pending_file)
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai_analysis::load_ai_configuration,
            ai_analysis::save_ai_configuration,
            ai_analysis::activate_ai_configuration,
            ai_analysis::delete_ai_configuration,
            ai_analysis::discover_ai_models,
            ai_analysis::analyze_log_with_ai,
            reader_association::get_trc_association_status,
            reader_association::associate_trc_files,
            reader_files::load_startup_trc_file,
            reader_settings::load_reader_settings,
            reader_settings::save_reader_setting,
            commands::save_custom_log_markers,
            commands::save_portable_log,
            commands::save_ai_analysis,
            update_release::load_update_release_notes,
        ])
        .build(tauri::generate_context!())
        .expect("OpsLog Reader application failed to build");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            for path in urls.into_iter().filter_map(|url| url.to_file_path().ok()) {
                if let Some(state) = app_handle.try_state::<reader_files::PendingTrcFile>() {
                    reader_files::remember_pending_file(&state, path.clone());
                }
                let _ = app_handle.emit("reader://open-file", path.to_string_lossy().into_owned());
            }
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}

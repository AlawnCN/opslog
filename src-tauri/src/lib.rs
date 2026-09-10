mod commands;
mod domain;
mod environment_store;
mod export_files;
mod kibana_client;
mod lan_server;
mod query_builders;

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
            commands::load_environments,
            commands::save_environment_config,
            commands::search_logs,
            commands::export_logs,
            commands::download_transaction_log,
            commands::read_transaction_log,
            commands::save_transaction_log,
            commands::save_custom_log_markers,
            commands::save_portable_log,
            commands::load_trace,
            lan_server::get_lan_share_status,
            lan_server::set_lan_share_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("OpsLog application failed");
}

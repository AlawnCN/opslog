mod commands;
mod domain;
mod environment_store;
mod export_files;
mod kibana_client;
mod query_builders;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            commands::load_trace,
        ])
        .run(tauri::generate_context!())
        .expect("OpsLog application failed");
}

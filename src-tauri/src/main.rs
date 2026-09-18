// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(feature = "reader-app")]
    opslog_lib::run_reader();

    #[cfg(not(feature = "reader-app"))]
    opslog_lib::run();
}

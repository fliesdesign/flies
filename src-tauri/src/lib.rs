mod files;

use std::sync::{Arc, Mutex};
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("files");
            let store = files::FileStore::new(root).map_err(std::io::Error::other)?;
            app.manage(files::LocalFiles(Arc::new(Mutex::new(store))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            files::list_files,
            files::create_file,
            files::open_file,
            files::save_file,
            files::choose_project_json
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

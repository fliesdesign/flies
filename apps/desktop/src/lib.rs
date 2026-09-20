mod clipboard;
mod files;
mod fonts;
mod mcp;
mod snapshot;

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
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            let data_dir = app.path().app_data_dir()?;
            files::migrate_legacy_app_data(&data_dir);
            let store =
                files::FileStore::new(data_dir.join("files")).map_err(std::io::Error::other)?;
            app.manage(files::LocalFiles(Arc::new(Mutex::new(store))));
            if let Err(error) = mcp::start(app.handle()) {
                eprintln!("Flies MCP could not start: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            fonts::list_system_fonts,
            clipboard::read_canvas_clipboard,
            mcp::mcp_next_request,
            mcp::mcp_reply,
            files::list_files,
            files::create_file,
            files::open_file,
            files::save_file,
            files::archive_file,
            files::restore_file,
            files::choose_project_json,
            snapshot::read_snapshot_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod clipboard;
mod credentials;
mod fonts;
mod mcp;
#[cfg(desktop)]
mod menu;
mod snapshot;
#[cfg(windows)]
mod windows_titlebar;

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
            #[cfg(windows)]
            windows_titlebar::setup(app)?;
            #[cfg(desktop)]
            {
                menu::setup(app)?;
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            if let Err(error) = mcp::start(app.handle()) {
                eprintln!("Flies MCP could not start: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            #[cfg(desktop)]
            menu::show_app_menu,
            credentials::read_desktop_session,
            credentials::write_desktop_session,
            fonts::list_system_fonts,
            clipboard::read_canvas_clipboard,
            mcp::mcp_next_request,
            mcp::mcp_reply,
            snapshot::read_snapshot_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use tauri::WebviewWindowBuilder;
use tauri_plugin_window_controls::WindowControlsBuilderExt;

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    app.handle().plugin(tauri_plugin_window_controls::init())?;
    // Windows config disables automatic creation so native controls can be installed
    // by the builder. macOS keeps its existing overlay and native traffic lights.
    if let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
    {
        WebviewWindowBuilder::from_config(app, config)?
            .window_controls_height(36)
            .build()?;
    }
    Ok(())
}

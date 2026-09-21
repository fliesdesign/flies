use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    Manager,
};

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let toggle = MenuItem::with_id(
        app,
        "toggle-developer-tools",
        "Toggle Developer Tools",
        true,
        None::<&str>,
    )?;
    let mut view_menu = None;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "View" {
                view_menu = Some(submenu);
                break;
            }
        }
    }
    if let Some(view) = view_menu {
        view.append(&PredefinedMenuItem::separator(app)?)?;
        view.append(&toggle)?;
    } else {
        menu.append(&Submenu::with_items(app, "View", true, &[&toggle])?)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() != "toggle-developer-tools" {
            return;
        }
        let window = app
            .webview_windows()
            .into_values()
            .find(|window| window.is_focused().unwrap_or(false))
            .or_else(|| app.get_webview_window("main"));
        if let Some(window) = window {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
    });
    Ok(())
}

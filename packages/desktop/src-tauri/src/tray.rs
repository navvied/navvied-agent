//! The menu bar icon (macOS) and tray icon (Windows, Linux): Show, Stop the current task, Choose another folder, Quit.

use crate::shell::{self, Shell};
use std::sync::Arc;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

pub struct Tray {
    status: MenuItem<tauri::Wry>,
    model: MenuItem<tauri::Wry>,
    folder: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    login: CheckMenuItem<tauri::Wry>,
    _icon: TrayIcon,
}

#[derive(Default)]
pub struct View {
    pub status: String,
    pub model: Option<String>,
    pub folder: Option<String>,
    pub working: bool,
}

pub fn build(app: &AppHandle, shell: &Arc<Shell>) -> tauri::Result<Tray> {
    let (open_at_login, keep) = {
        let s = shell.settings.lock().unwrap_or_else(|e| e.into_inner());
        (s.open_at_login, s.keep_running)
    };
    let status = MenuItem::with_id(app, "status", "navvied is starting…", false, None::<&str>)?;
    let model = MenuItem::with_id(app, "model", "Model: none yet", false, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder_line", "Folder: none yet", false, None::<&str>)?;
    let note = MenuItem::with_id(
        app,
        "note",
        if keep { "Closing the window keeps navvied running here." } else { "Closing the window quits navvied." },
        false,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, "show", "Show navvied", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop the current task", false, None::<&str>)?;
    let choose = MenuItem::with_id(app, "choose", "Choose another folder…", true, None::<&str>)?;
    let login = CheckMenuItem::with_id(app, "login", "Open when I sign in", true, open_at_login, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit navvied", true, None::<&str>)?;
    let line = |app: &AppHandle| PredefinedMenuItem::separator(app);
    let menu =
        Menu::with_items(app, &[&status, &model, &folder, &note, &line(app)?, &show, &stop, &choose, &line(app)?, &login, &settings, &line(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("navvied").menu(&menu).tooltip("navvied").show_menu_on_left_click(cfg!(target_os = "macos"));
    // A plain outline, so macOS can tint it for light and dark menu bars; the accent colour reads on any other panel.
    let bytes: &[u8] = if cfg!(target_os = "macos") { include_bytes!("../icons/tray-template.png") } else { include_bytes!("../icons/tray.png") };
    if let Ok(icon) = tauri::image::Image::from_bytes(bytes) {
        builder = builder.icon(icon).icon_as_template(cfg!(target_os = "macos"));
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let icon = builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => shell::show_window(app),
            "stop" => shell::stop_task(app),
            "choose" => shell::choose_folder(app),
            "login" => shell::toggle_login(app),
            "settings" => shell::open_settings(app),
            "quit" => shell::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if !cfg!(target_os = "macos") {
                    shell::show_window(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(Tray { status, model, folder, stop, login, _icon: icon })
}

impl Tray {
    pub fn set(&self, v: &View) {
        let _ = self.status.set_text(&v.status);
        let _ = self.model.set_text(format!("Model: {}", v.model.as_deref().unwrap_or("none yet")));
        let _ = self.folder.set_text(format!("Folder: {}", v.folder.as_deref().unwrap_or("none yet")));
        let _ = self.stop.set_enabled(v.working);
    }

    pub fn set_login(&self, on: bool) {
        let _ = self.login.set_checked(on);
    }
}

pub fn place_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "in the menu bar"
    } else if cfg!(windows) {
        "next to the clock"
    } else {
        "in the top bar"
    }
}

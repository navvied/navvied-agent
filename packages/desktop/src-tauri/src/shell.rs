//! The app's life: the program inside it, the window, the tray, notices, links and updates.

use base64::Engine as _;
use crate::{cards, tray};
use navvied_desktop_core::events::{Settings as NoticeSettings, Tracker, Update};
use navvied_desktop_core::http::{self, Info};
use navvied_desktop_core::intent::{self, Intent};
use navvied_desktop_core::logs::Logger;
use navvied_desktop_core::redact::Redactor;
use navvied_desktop_core::settings::Settings;
use navvied_desktop_core::spawn::OsSpawner;
use navvied_desktop_core::supervisor::{Config, Event, StartFailure, Supervisor, SystemClock};
use navvied_desktop_core::token::Token;
use navvied_desktop_core::ws;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const DOWNLOAD_PAGE: &str = "https://navvied.com/download";
const OVERLAY: &str = include_str!("../../shell-pages/overlay.js");

enum Pending {
    Welcome,
    PickFolder,
    Close,
    Folder(PathBuf),
    Chat(String),
    GaveUp,
    Settings,
    #[cfg(feature = "updater")]
    Info,
    #[cfg(feature = "updater")]
    UpdateReady,
}

pub struct Shell {
    pub settings: Mutex<Settings>,
    settings_path: PathBuf,
    log_dir: PathBuf,
    token: Token,
    logger: Arc<Logger>,
    supervisor: Mutex<Option<Supervisor>>,
    pub port: AtomicU16,
    /// The port of the page last opened, kept while the program is down so the page can still be answered and reloaded.
    pub page_port: AtomicU16,
    quitting: AtomicBool,
    tracker: Mutex<Tracker>,
    writer: Mutex<Option<ws::Writer>>,
    pending: Mutex<HashMap<String, Pending>>,
    next_id: AtomicU64,
    tray: Mutex<Option<tray::Tray>>,
    view: Mutex<tray::View>,
    started: Instant,
    reset_cursor: AtomicBool,
    reload_on_running: AtomicBool,
    welcomed_this_run: AtomicBool,
    queued: Mutex<Vec<Intent>>,
    #[cfg(feature = "updater")]
    update: Mutex<Option<tauri_plugin_updater::Update>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn shell_of(app: &AppHandle) -> Arc<Shell> {
    app.state::<Arc<Shell>>().inner().clone()
}

pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_window(app);
            let intents = intent::from_args(&args);
            if intents.is_empty() {
                // A second copy cannot show anything of its own: it ends at once. The first one says what happened.
                overlay(
                    app,
                    "banner",
                    &serde_json::json!({ "kind": "ok", "text": "navvied was already open.", "more": "This is the window you already have.", "dismiss": true }),
                );
            }
            queue_or_ask(app, intents);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])));
    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    // Only on macOS: there, without a menu item carrying the Cmd+V accelerator, the system never delivers that
    // keystroke to the app at all (clipboard access being enabled on the webview, below, is not enough there on
    // its own). On Linux and Windows the webview's own paste works without any menu, and a File/Edit/Window menu
    // bar drawn inside the window would be a visible change on its own, with no preview approved for it.
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(|handle| tauri::menu::Menu::default(handle));
    }
    let app = builder
        .invoke_handler(tauri::generate_handler![
            crate::commands::shell_answer,
            crate::commands::shell_settings_get,
            crate::commands::shell_settings_set,
            crate::commands::page_action,
            crate::commands::clipboard_image,
            crate::commands::relay_pair,
            crate::commands::relay_status,
            crate::commands::relay_forget,
            crate::commands::relay_answer
        ])
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the navvied app could not be built");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => {
            api.prevent_exit();
            quit(app);
        }
        RunEvent::Exit => finish(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_window(app),
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let intents =
                urls.iter().filter(|u| u.scheme() == "file").filter_map(|u| u.to_file_path().ok()).filter(|p| p.is_dir()).map(Intent::OpenFolder).collect();
            show_window(app);
            queue_or_ask(app, intents);
        }
        _ => {}
    });
}

fn sidecar_path() -> PathBuf {
    #[cfg(any(debug_assertions, feature = "test-hooks"))]
    if let Ok(p) = std::env::var("NAVVIED_BIN") {
        return p.into();
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|d| d.join(if cfg!(windows) { "navvied.exe" } else { "navvied" })).unwrap_or_default()
}

/// The window tests start the app with a known key so they can look for it everywhere it must not be. Never in a release build.
#[cfg(feature = "test-hooks")]
fn test_key() -> Option<Token> {
    std::env::var("NAVVIED_DESKTOP_TEST_KEY").ok().and_then(Token::from_string)
}

#[cfg(not(feature = "test-hooks"))]
fn test_key() -> Option<Token> {
    None
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    let log_dir = app.path().app_log_dir()?;
    let settings_path = data.join("settings.json");
    let settings = Settings::load(&settings_path);
    let token = test_key().map_or_else(Token::generate, Ok)?;
    let redactor = Arc::new(Redactor::new());
    redactor.add(token.expose());
    let logger = Arc::new(Logger::new(redactor, Some(log_dir.join("navvied.log"))));
    let notice = NoticeSettings { notices: settings.notices, details: settings.details, ..NoticeSettings::default() };
    let shell = Arc::new(Shell {
        settings: Mutex::new(settings),
        settings_path,
        log_dir,
        token,
        logger,
        supervisor: Mutex::new(None),
        port: AtomicU16::new(0),
        page_port: AtomicU16::new(0),
        quitting: AtomicBool::new(false),
        tracker: Mutex::new(Tracker::new(notice)),
        writer: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        tray: Mutex::new(None),
        view: Mutex::new(tray::View { status: "navvied is starting…".into(), ..tray::View::default() }),
        started: Instant::now(),
        reset_cursor: AtomicBool::new(false),
        reload_on_running: AtomicBool::new(false),
        welcomed_this_run: AtomicBool::new(false),
        queued: Mutex::new(Vec::new()),
        #[cfg(feature = "updater")]
        update: Mutex::new(None),
    });
    app.manage(shell.clone());
    let background = std::env::args().any(|a| a == "--background");
    // Started before the window: spawning the sidecar and building the native window both cost real time
    // (disk I/O for the sidecar's own code, process-fork and library loading for the window's WebKitGTK
    // view), and neither depends on the other, so starting the sidecar first lets that cost run alongside
    // window creation instead of after it.
    start_supervisor(app, &shell);
    create_window(app, &shell, !background)?;
    *lock(&shell.tray) = Some(tray::build(app, &shell)?);
    start_listener(app.clone(), shell.clone());
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        let intents: Vec<Intent> = event.urls().iter().filter_map(|u| intent::parse_link(u.as_str())).collect();
        show_window(&handle);
        queue_or_ask(&handle, intents);
    });
    let _ = app.notification().request_permission();
    queue_or_ask(app, intent::from_args(&std::env::args().collect::<Vec<_>>()));
    #[cfg(feature = "updater")]
    schedule_updates(app.clone());
    Ok(())
}

fn init_script(token: &Token) -> String {
    let key = serde_json::to_string(token.expose()).unwrap_or_default();
    format!(
        "(function(){{ if(location.protocol!=='http:'||location.hostname!=='127.0.0.1')return; try{{ sessionStorage.setItem('navvied.target',JSON.stringify({{origin:location.origin,token:{key}}})); }}catch(e){{}} }})();\n(function(){{ if(location.protocol!=='http:'||location.hostname!=='127.0.0.1')return; {OVERLAY} }})();\n{NATIVE_DROP}"
    )
}

/// Turns the native drop Rust reads for us (see `native_drag_drop`, above `create_window`'s builder) back into
/// the ordinary HTML5 drag sequence a page already knows how to handle: WebKitGTK gives a dropped local file to
/// the page only as a `text/uri-list` string, never as a `File` (verified with the real WebKit remote
/// inspector), so this is the one place that gap is closed — the page itself (`packages/web/src/composer.ts`)
/// needs no change at all, since what it receives here is indistinguishable from a real browser drop.
const NATIVE_DROP: &str = r#"(function(){
  if (window.__navviedDrop) return;
  var overEl = null;
  function fakeFilesTransfer() {
    var dt = new DataTransfer();
    dt.items.add(new File([], "", { type: "application/octet-stream" }));
    return dt;
  }
  function realFilesTransfer(files) {
    var dt = new DataTransfer();
    (files || []).forEach(function (f) {
      var bin = atob(f.data), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mime }));
    });
    return dt;
  }
  function fire(type, el, dataTransfer) {
    if (!el) return;
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dataTransfer }));
  }
  window.__navviedDrop = {
    enter: function (p) { overEl = document.elementFromPoint(p.x, p.y); fire("dragenter", overEl, fakeFilesTransfer()); },
    over: function (p) { overEl = document.elementFromPoint(p.x, p.y) || overEl; fire("dragover", overEl, fakeFilesTransfer()); },
    leave: function () { fire("dragleave", overEl, fakeFilesTransfer()); overEl = null; },
    drop: function (p) {
      var el = document.elementFromPoint(p.x, p.y) || overEl;
      overEl = null;
      fire("drop", el, realFilesTransfer(p.files));
    },
  };
})();"#;

enum Nav {
    Allow,
    External,
    Deny,
}

fn nav_policy(url: &Url, port: u16) -> Nav {
    match (url.scheme(), url.host_str()) {
        ("tauri", _) | ("http", Some("tauri.localhost")) => Nav::Allow,
        ("http", Some("127.0.0.1")) if port > 0 && url.port() == Some(port) => Nav::Allow,
        ("http" | "https" | "mailto", _) => Nav::External,
        _ => Nav::Deny,
    }
}

fn create_window(app: &AppHandle, shell: &Arc<Shell>, visible: bool) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("starting.html".into()))
        .title("navvied")
        .inner_size(1100.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .visible(visible)
        // Off by default on Linux and Windows only (already on for macOS); needed for the page's own
        // paste (text) to reach it at all.
        .enable_clipboard_access()
        .initialization_script(init_script(&shell.token))
        .on_navigation(move |url| {
            let port = shell_of(&nav_app).page_port.load(Ordering::SeqCst);
            match nav_policy(url, port) {
                Nav::Allow => true,
                Nav::External => {
                    let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
                    false
                }
                Nav::Deny => false,
            }
        })
        .build()?;
    let close_app = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            let sh = shell_of(&close_app);
            if sh.quitting.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            let (keep, asked) = {
                let s = lock(&sh.settings);
                (s.keep_running, s.close_asked)
            };
            if !keep {
                quit(&close_app);
            } else if !asked {
                ask(&close_app, Pending::Close, cards::close_question(tray::place_name()));
            } else {
                hide_window(&close_app);
            }
        } else if let WindowEvent::DragDrop(e) = event {
            native_drag_drop(&close_app, e);
        }
    });
    Ok(win)
}

const MAX_DROPPED_FILES: usize = 8;
const MAX_DROPPED_FILE_BYTES: u64 = 15 * 1024 * 1024;

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "markdown" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// WebKitGTK's own drag-and-drop exposes a dropped file's path to the page only as a `text/uri-list` string,
/// never as a `File` (confirmed with the real WebKit remote inspector: `dataTransfer.files.length` is always 0
/// for a local file drag, whatever targets the source offers). Tauri's own drag-drop handler, the one
/// `disable_drag_drop_handler()` would otherwise turn off, is the only place a real file path is available at
/// all on this platform — so it stays on, and this reads the dropped files here instead and hands them to the
/// page as real `File` objects over a Tauri event the init script below turns back into a synthetic, ordinary
/// HTML5 drag sequence. The page's own code (`packages/web/src/composer.ts`) needs no change: a `drop` it
/// receives this way looks exactly like one a browser would have given it.
fn native_drag_drop(app: &AppHandle, event: &DragDropEvent) {
    let Some(win) = app.get_webview_window("main") else { return };
    // `DragDropEvent`'s position is typed `PhysicalPosition` everywhere, but is only genuinely physical on one
    // of the three platforms: wry's own source (`wry::webview2::drag_drop`) converts a Win32 `POINTL` with
    // `ScreenToClient`, a pure coordinate-system shift with no DPI conversion — real physical pixels, needing
    // `to_logical` on a scaled display. On Linux it is GTK's own `drag-motion` signal's `x, y`, already in
    // GDK's device-independent units; on macOS, AppKit's `draggingLocation`, already in points. Both of those
    // already match the CSS pixels `document.elementFromPoint` wants, so converting them *again* on those two
    // platforms is what this fix got wrong on its first pass — proven by reproducing it: under `GDK_SCALE=2`,
    // a drop aimed at logical (685, 600) landed, converted, at (342.5, 300) — exactly half of half, the typical
    // signature of dividing by the scale factor one time too many.
    #[cfg(windows)]
    let scale = win.scale_factor().unwrap_or(1.0);
    #[cfg(windows)]
    let logical = |p: &tauri::PhysicalPosition<f64>| p.to_logical::<f64>(scale);
    #[cfg(not(windows))]
    let logical = |p: &tauri::PhysicalPosition<f64>| tauri::LogicalPosition::new(p.x, p.y);
    let at = |method: &str, arg: Value| {
        let _ = win.eval(format!("window.__navviedDrop&&window.__navviedDrop.{method}({arg})"));
    };
    match event {
        DragDropEvent::Enter { position, .. } => {
            let p = logical(position);
            at("enter", serde_json::json!({ "x": p.x, "y": p.y }));
        }
        DragDropEvent::Over { position } => {
            let p = logical(position);
            at("over", serde_json::json!({ "x": p.x, "y": p.y }));
        }
        DragDropEvent::Leave => at("leave", Value::Null),
        DragDropEvent::Drop { paths, position } => {
            let files: Vec<Value> = paths
                .iter()
                .filter(|p| p.is_file())
                .filter(|p| std::fs::metadata(p).map(|m| m.len() <= MAX_DROPPED_FILE_BYTES).unwrap_or(false))
                .take(MAX_DROPPED_FILES)
                .filter_map(|p| {
                    let bytes = std::fs::read(p).ok()?;
                    let name = p.file_name()?.to_string_lossy().into_owned();
                    Some(serde_json::json!({ "name": name, "mime": mime_for(p), "data": base64::engine::general_purpose::STANDARD.encode(bytes) }))
                })
                .collect();
            if !files.is_empty() {
                let p = logical(position);
                at("drop", serde_json::json!({ "x": p.x, "y": p.y, "files": files }));
            }
        }
        _ => {}
    }
}

// `show_window`, `hide_window`, `overlay`, `overlay_fill`, `go`, `refresh_tray`, `set_tray_login` and
// `confirm_navigated` are the only places in this file allowed to touch the `WebviewWindow` or the tray
// directly (see `desktop.test.ts`, "every touch of the window or the tray runs on the GTK main thread"):
// each one dispatches through `run_on_main_thread`, which runs its closure inline when already on that
// thread and marshals it there otherwise — correct and free to call from anywhere, including the main
// thread itself (verified in `tauri-runtime-wry`'s `send_user_message`). Nowhere else calls these methods,
// so a caller never has to know, or get wrong, which thread it happens to be running on.
pub fn show_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    });
}

fn hide_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.hide();
        }
    });
}

/// Only ever called from a closure already dispatched onto the main thread (`dispatch`'s `Update::Notice`
/// branch): a `bool` has no way back out of `run_on_main_thread` itself, so this reads the window directly
/// and relies on its caller for the thread it runs on, instead of dispatching a second time.
fn window_in_front(app: &AppHandle) -> bool {
    // The window tests run on a screen with no window manager, where "in front" cannot be told apart from "not".
    #[cfg(feature = "test-hooks")]
    if std::env::var("NAVVIED_DESKTOP_TEST_NOTICE_ALWAYS").is_ok() {
        return false;
    }
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

fn overlay(app: &AppHandle, method: &str, arg: &Value) {
    let handle = app.clone();
    let method = method.to_owned();
    let arg = arg.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.eval(format!("window.__navviedShell&&window.__navviedShell.{method}({arg})"));
        }
    });
}

fn ask(app: &AppHandle, what: Pending, mut card: Value) {
    let sh = shell_of(app);
    let id = format!("q{}", sh.next_id.fetch_add(1, Ordering::SeqCst));
    card["id"] = Value::String(id.clone());
    lock(&sh.pending).insert(id, what);
    show_window(app);
    overlay(app, "show", &card);
}

fn local_url(page: &str) -> Option<Url> {
    Url::parse(&format!("{}/{page}", if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" })).ok()
}

fn go(app: &AppHandle, url: Url) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            if w.url().is_ok_and(|u| u == url) {
                return;
            }
            let _ = w.navigate(url);
        }
    });
}

fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let sh = shell_of(&handle);
        let tray = lock(&sh.tray);
        if let Some(t) = tray.as_ref() {
            t.set(&lock(&sh.view));
        }
    });
}

fn set_view(app: &AppHandle, f: impl FnOnce(&mut tray::View)) {
    f(&mut lock(&shell_of(app).view));
    refresh_tray(app);
}

fn set_tray_login(app: &AppHandle, value: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(t) = lock(&shell_of(&handle).tray).as_ref() {
            t.set_login(value);
        }
    });
}

fn folder_for_start(app: &AppHandle, sh: &Shell) -> PathBuf {
    lock(&sh.settings).folder.clone().filter(|f| f.is_dir()).or_else(|| app.path().home_dir().ok()).unwrap_or_else(std::env::temp_dir)
}

fn start_supervisor(app: &AppHandle, sh: &Arc<Shell>) {
    let mut cfg = Config::new(sidecar_path(), folder_for_start(app, sh), sh.token.clone());
    cfg.port_hint = lock(&sh.settings).port;
    set_view(app, |v| v.folder = Some(cards::folder_name(&cfg.cwd)));
    let handle = app.clone();
    let sup = Supervisor::start(
        cfg,
        Arc::new(OsSpawner { logger: sh.logger.clone() }),
        Arc::new(SystemClock::new()),
        sh.logger.clone(),
        Box::new(move |e| on_event(&handle, e)),
    );
    *lock(&sh.supervisor) = Some(sup);
}

fn on_event(app: &AppHandle, event: Event) {
    let sh = shell_of(app);
    match event {
        Event::Starting => set_view(app, |v| v.status = "navvied is starting…".into()),
        Event::Running { port, info, recovered } => running(app, &sh, port, info, recovered),
        Event::Crashed { .. } => {
            sh.port.store(0, Ordering::SeqCst);
            set_view(app, |v| v.status = "navvied stopped unexpectedly".into());
            overlay(
                app,
                "banner",
                &serde_json::json!({ "kind": "warn", "spin": true, "text": "navvied stopped unexpectedly.", "more": "Starting it again. Your conversation is safe." }),
            );
        }
        Event::GaveUp { .. } => {
            sh.port.store(0, Ordering::SeqCst);
            set_view(app, |v| v.status = "navvied stopped".into());
            overlay(app, "clearBanner", &Value::Null);
            ask(app, Pending::GaveUp, cards::gave_up(&sh.logger.recent().join("\n")));
        }
        Event::CannotStart(why) => {
            sh.port.store(0, Ordering::SeqCst);
            set_view(app, |v| v.status = "navvied cannot start".into());
            let kind = match why {
                StartFailure::EngineMissing => "missing",
                StartFailure::Blocked { .. } => "blocked",
                StartFailure::NoAnswer => "noanswer",
            };
            if let Some(url) = local_url(&format!("error.html#{kind}")) {
                go(app, url);
            }
            show_window(app);
        }
        Event::Stopped => {}
    }
}

fn running(app: &AppHandle, sh: &Arc<Shell>, port: u16, info: Info, recovered: bool) {
    sh.port.store(port, Ordering::SeqCst);
    sh.page_port.store(port, Ordering::SeqCst);
    sh.reset_cursor.store(true, Ordering::SeqCst);
    {
        let mut s = lock(&sh.settings);
        s.port = Some(port);
        let _ = s.save(&sh.settings_path);
    }
    *lock(&sh.view) = tray::View {
        status: "navvied is running".into(),
        model: info.model,
        folder: Some(cards::folder_name(std::path::Path::new(&info.cwd))),
        working: false,
    };
    refresh_tray(app);
    if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) {
        let reload = sh.reload_on_running.swap(false, Ordering::SeqCst);
        let main_app = app.clone();
        // Dispatched explicitly onto the GTK main thread: this call runs from the supervisor's worker thread,
        // and calling `navigate`/`url` on `WebviewWindow` straight from there is what was hanging on a HiDPI
        // Linux desktop with a model already connected (reproduced with GDK_SCALE=2) — `navigate` returned `Ok`
        // but the page never changed, forever. `run_on_main_thread` fixed it (13/13 trials, against 0/8 for
        // retrying alone); `confirm_navigated` below stays as a second line of defence.
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = main_app.get_webview_window("main") {
                let on_page = w.url().is_ok_and(|u| u.host_str() == Some("127.0.0.1") && u.port() == Some(port));
                if !on_page {
                    let _ = w.navigate(url);
                    confirm_navigated(&main_app, port);
                } else if reload {
                    let _ = w.eval("location.reload()");
                }
            }
        });
    }
    if recovered {
        overlay(
            app,
            "banner",
            &serde_json::json!({ "kind": "ok", "text": "navvied is back.", "more": "The last answer was cut off. Send your message again to continue.", "dismiss": true }),
        );
    }
    let queued: Vec<Intent> = std::mem::take(&mut *lock(&sh.queued));
    let first = !recovered && !lock(&sh.settings).welcomed && !sh.welcomed_this_run.swap(true, Ordering::SeqCst);
    if !first && queued.is_empty() {
        return;
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        if first {
            ask(&app2, Pending::Welcome, cards::welcome());
        }
        ask_intents(&app2, queued);
    });
}

/// A second check behind `run_on_main_thread` above, kept in case some other path to the same hang turns up:
/// `navigate` returns `Ok` as soon as the load request is handed to the webview, not once the page has actually
/// changed, so this watches for the load really landing and asks again if it has not — first through `navigate`
/// once more, then through the page's own `location.href`, a different path into the webview. The sleep between
/// attempts stays on this worker thread (it must not block the main loop for up to 5 seconds); only the one
/// check-and-retry step that actually touches the window runs on the main thread, and a channel carries its
/// yes/no back here so the loop can still stop as soon as the page has really moved, exactly as it did when
/// this all ran directly on this thread — a single `run_on_main_thread` call that outlived its own result
/// could not do that, since dispatching it never waits for the closure to run.
fn confirm_navigated(app: &AppHandle, port: u16) {
    let app = app.clone();
    std::thread::spawn(move || {
        for attempt in 0..10 {
            std::thread::sleep(Duration::from_millis(500));
            let (tx, rx) = std::sync::mpsc::channel();
            let main_app = app.clone();
            let dispatched = app.run_on_main_thread(move || {
                let landed = main_app.get_webview_window("main").is_some_and(|w| {
                    if w.url().is_ok_and(|u| u.host_str() == Some("127.0.0.1") && u.port() == Some(port)) {
                        return true;
                    }
                    if attempt < 5 {
                        if let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) {
                            let _ = w.navigate(url);
                        }
                    } else {
                        let _ = w.eval(format!("location.href='http://127.0.0.1:{port}/'"));
                    }
                    false
                });
                let _ = tx.send(landed);
            });
            if dispatched.is_err() {
                return;
            }
            if rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false) {
                return;
            }
        }
    });
}

fn queue_or_ask(app: &AppHandle, intents: Vec<Intent>) {
    if intents.is_empty() {
        return;
    }
    let sh = shell_of(app);
    if sh.port.load(Ordering::SeqCst) == 0 {
        lock(&sh.queued).extend(intents);
    } else {
        ask_intents(app, intents);
    }
}

fn ask_intents(app: &AppHandle, intents: Vec<Intent>) {
    for i in intents {
        match i {
            Intent::OpenFolder(p) if p.is_dir() => ask(app, Pending::Folder(p.clone()), cards::folder_question(&p)),
            Intent::OpenFolder(_) => {}
            Intent::Settings => open_settings(app),
            Intent::Chat { text } => ask(app, Pending::Chat(text.clone()), cards::chat_question(&text)),
        }
    }
}

fn start_listener(app: AppHandle, sh: Arc<Shell>) {
    std::thread::spawn(move || {
        let mut last_seq = 0u64;
        while !sh.quitting.load(Ordering::SeqCst) {
            let port = sh.port.load(Ordering::SeqCst);
            if port == 0 {
                std::thread::sleep(Duration::from_millis(300));
                continue;
            }
            if sh.reset_cursor.swap(false, Ordering::SeqCst) {
                last_seq = 0;
            }
            match ws::connect(port, sh.token.expose(), last_seq, Duration::from_secs(3)) {
                Ok((mut reader, writer)) => {
                    *lock(&sh.writer) = Some(writer);
                    while !sh.quitting.load(Ordering::SeqCst) && sh.port.load(Ordering::SeqCst) == port {
                        match reader.next(Duration::from_millis(500)) {
                            Ok(Some(line)) => {
                                let parsed = serde_json::from_str::<Value>(&line).ok();
                                if let Some(seq) = parsed.as_ref().and_then(|j| j.get("seq").and_then(Value::as_u64)) {
                                    last_seq = seq;
                                }
                                // The relay side-channel (`{"relay": "ask"|"replaced", ...}`, sent by the sidecar's
                                // own `createRelayBridge`): no `ev` field, so `Tracker::feed` below already ignores
                                // it safely; forward the whole line to the webview as-is, so a page can listen for
                                // `relay` events without the shell needing to understand what any one of them means.
                                if parsed.as_ref().is_some_and(|j| j.get("relay").is_some()) {
                                    let _ = app.emit("relay", &parsed);
                                }
                                let updates = lock(&sh.tracker).feed(&line, sh.started.elapsed());
                                for u in updates {
                                    dispatch(&app, u);
                                }
                            }
                            Ok(None) => {}
                            Err(_) => break,
                        }
                    }
                    *lock(&sh.writer) = None;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(500)),
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

fn dispatch(app: &AppHandle, update: Update) {
    match update {
        Update::Activity(a) => set_view(app, |v| {
            v.working = a.working;
            v.status = if a.working {
                a.title.map_or("navvied is working".to_owned(), |t| format!("navvied is working: {t}"))
            } else {
                "navvied is running".to_owned()
            };
        }),
        // `window_in_front` reads the window directly, so the whole decision (and the notification that
        // follows it) is one dispatch onto the main thread, not read there and acted on here.
        Update::Notice(n) => {
            let (title, body) = n.text();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if window_in_front(&handle) {
                    return;
                }
                let sent = handle.notification().builder().title(title).body(body).show();
                // Only the title is written down: a notice may name a file.
                shell_of(&handle)
                    .logger
                    .log("app", &format!("notice \"{title}\": {}", if sent.is_ok() { "sent".to_owned() } else { "the system refused it".to_owned() }));
            });
        }
    }
}

pub fn stop_task(app: &AppHandle) {
    if let Some(w) = lock(&shell_of(app).writer).as_ref() {
        let _ = w.send_text(r#"{"cmd":"cancel"}"#);
    }
}

const RELAY_TIMEOUT: Duration = Duration::from_secs(5);

fn relay_call(app: &AppHandle, method_post_body: Option<&str>, path: &str) -> Result<Value, String> {
    let sh = shell_of(app);
    let port = sh.port.load(Ordering::SeqCst);
    if port == 0 {
        return Err("navvied is not running yet".into());
    }
    let reply = match method_post_body {
        Some(body) => http::post(port, path, Some(sh.token.expose()), body, RELAY_TIMEOUT),
        None => http::get(port, path, Some(sh.token.expose()), RELAY_TIMEOUT),
    }
    .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&reply.body).map_err(|e| e.to_string())?;
    if reply.status >= 400 {
        return Err(value.get("error").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("the program answered {}", reply.status)));
    }
    Ok(value)
}

const MAX_CLIPBOARD_IMAGE_BYTES: usize = 15 * 1024 * 1024;

/// The system clipboard's image, PNG-encoded and base64-wrapped the same way a dropped file is (see
/// `native_drag_drop`), or `null` when there is none. `arboard`'s raw RGBA8 pixels need re-encoding (`image`)
/// before they are anything a page can use as a `File`.
pub fn clipboard_image() -> Result<Value, String> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(_) => return Ok(Value::Null),
    };
    let img = match clipboard.get_image() {
        Ok(i) => i,
        Err(_) => return Ok(Value::Null),
    };
    let (width, height) = (img.width as u32, img.height as u32);
    let Some(buf) = image::RgbaImage::from_raw(width, height, img.bytes.into_owned()) else {
        return Ok(Value::Null);
    };
    let mut png = Vec::new();
    if image::DynamicImage::ImageRgba8(buf).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).is_err() {
        return Ok(Value::Null);
    }
    if png.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Ok(Value::Null);
    }
    Ok(serde_json::json!({ "mime": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(png) }))
}

/// Makes a link and a code for navvied.com to pair with, the same way `/remote` does in the terminal.
pub fn relay_pair(app: &AppHandle, label: Option<String>) -> Result<Value, String> {
    relay_call(app, Some(&serde_json::json!({ "label": label }).to_string()), "/api/relay/pair")
}

/// What is connected over the relay right now, and the one question waiting for a decision, if there is one.
pub fn relay_status(app: &AppHandle) -> Result<Value, String> {
    relay_call(app, None, "/api/relay/status")
}

/// Stops sharing with one device, named by the id `relay_status` or `relay_pair` gave.
pub fn relay_forget(app: &AppHandle, id: String) -> Result<Value, String> {
    relay_call(app, Some(&serde_json::json!({ "id": id }).to_string()), "/api/relay/forget")
}

/// Answers the question a `relay` event asked (`"once"`, `"always"` or `"no"`), by its `id`.
pub fn relay_answer(app: &AppHandle, id: String, choice: String) -> Result<Value, String> {
    relay_call(app, Some(&serde_json::json!({ "id": id, "choice": choice }).to_string()), "/api/relay/answer")
}

pub fn quit(app: &AppHandle) {
    let sh = shell_of(app);
    if sh.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        finish(&app);
        app.exit(0);
    });
}

/// Cancel the task, close the input, wait, end the whole tree. Safe to call twice.
fn finish(app: &AppHandle) {
    let sh = shell_of(app);
    if let Some(w) = lock(&sh.writer).take() {
        let _ = w.send_text(r#"{"cmd":"cancel"}"#);
        std::thread::sleep(Duration::from_millis(150));
        w.close();
    }
    let supervisor = lock(&sh.supervisor).take();
    if let Some(s) = supervisor {
        s.stop();
    }
}

fn pick_folder(app: &AppHandle, then: fn(&AppHandle, PathBuf)) {
    let handle = app.clone();
    app.dialog().file().set_title("Choose a project folder for navvied").pick_folder(move |picked| {
        if let Some(path) = picked.and_then(|p| p.into_path().ok()) {
            then(&handle, path);
        }
    });
}

pub fn choose_folder(app: &AppHandle) {
    show_window(app);
    pick_folder(app, apply_folder);
}

fn apply_folder(app: &AppHandle, folder: PathBuf) {
    let sh = shell_of(app);
    if !folder.is_dir() {
        return;
    }
    {
        let mut s = lock(&sh.settings);
        s.work_in(folder.clone());
        let _ = s.save(&sh.settings_path);
    }
    set_view(app, |v| v.folder = Some(cards::folder_name(&folder)));
    sh.reload_on_running.store(true, Ordering::SeqCst);
    let supervisor = lock(&sh.supervisor);
    if let Some(s) = supervisor.as_ref() {
        s.restart_in(folder);
    }
}

pub fn open_settings(app: &AppHandle) {
    ask(app, Pending::Settings, cards::settings(tray::place_name()));
}

pub fn toggle_login(app: &AppHandle) {
    let on = !lock(&shell_of(app).settings).open_at_login;
    let _ = set_setting(app, &shell_of(app), "open_at_login", on);
}

pub fn set_setting(app: &AppHandle, sh: &Arc<Shell>, key: &str, value: bool) -> Result<(), String> {
    let mut s = lock(&sh.settings);
    match key {
        "keep_running" => s.keep_running = value,
        "notices" => {
            s.notices = value;
            lock(&sh.tracker).settings.notices = value;
        }
        "details" => {
            s.details = value;
            lock(&sh.tracker).settings.details = value;
        }
        "open_at_login" => {
            let launch = app.autolaunch();
            if value { launch.enable() } else { launch.disable() }.map_err(|e| e.to_string())?;
            s.open_at_login = value;
            set_tray_login(app, value);
        }
        _ => return Err("unknown setting".into()),
    }
    s.save(&sh.settings_path).map_err(|e| e.to_string())
}

pub fn page_action(app: &AppHandle, sh: &Arc<Shell>, action: &str) -> Result<String, String> {
    match action {
        "try_again" => {
            if let Some(url) = local_url("starting.html") {
                go(app, url);
            }
            if let Some(s) = lock(&sh.supervisor).as_ref() {
                s.try_again();
            }
            Ok(String::new())
        }
        "details" => Ok(sh.logger.recent().iter().rev().take(12).rev().cloned().collect::<Vec<_>>().join("\n")),
        "download" => app.opener().open_url(DOWNLOAD_PAGE, None::<&str>).map(|()| String::new()).map_err(|e| e.to_string()),
        "show_logs" => app.opener().open_path(sh.log_dir.to_string_lossy(), None::<&str>).map(|()| String::new()).map_err(|e| e.to_string()),
        _ => Err("unknown action".into()),
    }
}

pub fn answer(app: &AppHandle, sh: &Arc<Shell>, id: &str, choice: &str, checked: bool) {
    let Some(what) = lock(&sh.pending).remove(id) else { return };
    match (what, choice) {
        (Pending::Welcome, "start") => {
            let mut s = lock(&sh.settings);
            s.welcomed = true;
            let _ = s.save(&sh.settings_path);
            let recent = s.recent_folders.clone();
            drop(s);
            ask(app, Pending::PickFolder, cards::pick_folder(&recent));
        }
        (Pending::PickFolder, "choose") => pick_folder(app, apply_folder),
        (Pending::PickFolder, c) if c.starts_with("recent:") => {
            let picked = c["recent:".len()..].parse::<usize>().ok().and_then(|i| lock(&sh.settings).recent_folders.get(i).cloned());
            if let Some(p) = picked {
                apply_folder(app, p);
            }
        }
        (Pending::Close, "keep" | "quit") => {
            {
                let mut s = lock(&sh.settings);
                if checked {
                    s.close_asked = true;
                    s.keep_running = choice == "keep";
                    let _ = s.save(&sh.settings_path);
                }
            }
            if choice == "quit" {
                quit(app);
            } else {
                hide_window(app);
            }
        }
        (Pending::Folder(p), "work") => apply_folder(app, p),
        (Pending::Chat(text), "fill") => {
            if let Ok(js) = serde_json::to_string(&text) {
                overlay_fill(app, &js);
            }
        }
        (Pending::GaveUp, "logs") => {
            let _ = app.opener().open_path(sh.log_dir.to_string_lossy(), None::<&str>);
            ask(app, Pending::GaveUp, cards::gave_up(&sh.logger.recent().join("\n")));
        }
        (Pending::GaveUp, "again") => {
            if let Some(s) = lock(&sh.supervisor).as_ref() {
                s.try_again();
            }
        }
        (Pending::Settings, "choose_folder") => {
            pick_folder(app, apply_folder);
        }
        #[cfg(feature = "updater")]
        (Pending::Info, _) => {}
        #[cfg(feature = "updater")]
        (Pending::UpdateReady, "update") => install_update(app.clone()),
        _ => {}
    }
}

fn overlay_fill(app: &AppHandle, js_text: &str) {
    let handle = app.clone();
    let js_text = js_text.to_owned();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("main") {
            let _ = w.eval(format!("window.__navviedShell&&window.__navviedShell.fill({js_text})"));
        }
    });
}

#[cfg(feature = "updater")]
fn schedule_updates(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        loop {
            check_update(app.clone());
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

#[cfg(feature = "updater")]
fn check_update(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let sh = shell_of(&app);
        let Ok(updater) = app.updater() else { return };
        match updater.check().await {
            Ok(Some(update)) => {
                let (current, new) = (update.current_version.clone(), update.version.clone());
                *lock(&sh.update) = Some(update);
                // The native card below is today's only UI for this; a web card can listen for this event
                // instead (same information, same moment, so trading one for the other needs no change here).
                let _ = app.emit("update-available", serde_json::json!({ "current": current, "version": new }));
                ask(&app, Pending::UpdateReady, cards::update_ready(&current, &new));
            }
            Ok(None) => {}
            Err(e) => sh.logger.log("app", &format!("update check failed: {e}")),
        }
    });
}

#[cfg(feature = "updater")]
fn install_update(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let sh = shell_of(&app);
        let Some(update) = lock(&sh.update).take() else { return };
        let version = update.version.clone();
        ask(&app, Pending::Info, cards::update_progress(&version, 0));
        let (mut got, mut last) = (0u64, 0u32);
        let progress_app = app.clone();
        let result = update
            .download_and_install(
                |chunk, total| {
                    got += chunk as u64;
                    let pct = total.map_or(0, |t| (got * 100 / t.max(1)) as u32);
                    if pct != last {
                        last = pct;
                        overlay(&progress_app, "progress", &serde_json::json!(pct));
                    }
                },
                || {},
            )
            .await;
        match result {
            Ok(()) => {
                finish(&app);
                app.restart();
            }
            Err(e) => {
                let text = e.to_string();
                sh.logger.log("app", &format!("update failed: {text}"));
                ask(&app, Pending::Info, cards::update_refused(&version, text.to_lowercase().contains("signature")));
            }
        }
    });
}

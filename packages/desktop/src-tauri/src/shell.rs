//! The app's life: the program inside it, the window, the tray, notices, links and updates.

use crate::{cards, tray};
use navvied_desktop_core::events::{Settings as NoticeSettings, Tracker, Update};
use navvied_desktop_core::http::Info;
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
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
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
    let app = builder
        .invoke_handler(tauri::generate_handler![
            crate::commands::shell_answer,
            crate::commands::shell_settings_get,
            crate::commands::shell_settings_set,
            crate::commands::page_action
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
    create_window(app, &shell, !background)?;
    *lock(&shell.tray) = Some(tray::build(app, &shell)?);
    start_supervisor(app, &shell);
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
        "(function(){{ if(location.protocol!=='http:'||location.hostname!=='127.0.0.1')return; try{{ sessionStorage.setItem('navvied.target',JSON.stringify({{origin:location.origin,token:{key}}})); }}catch(e){{}} }})();\n(function(){{ if(location.protocol!=='http:'||location.hostname!=='127.0.0.1')return; {OVERLAY} }})();"
    )
}

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
            } else if let Some(w) = close_app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
    });
    Ok(win)
}

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn window_in_front(app: &AppHandle) -> bool {
    // The window tests run on a screen with no window manager, where "in front" cannot be told apart from "not".
    #[cfg(feature = "test-hooks")]
    if std::env::var("NAVVIED_DESKTOP_TEST_NOTICE_ALWAYS").is_ok() {
        return false;
    }
    app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

fn overlay(app: &AppHandle, method: &str, arg: &Value) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.__navviedShell&&window.__navviedShell.{method}({arg})"));
    }
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
    if let Some(w) = app.get_webview_window("main") {
        if w.url().is_ok_and(|u| u == url) {
            return;
        }
        let _ = w.navigate(url);
    }
}

fn refresh_tray(app: &AppHandle) {
    let sh = shell_of(app);
    let tray = lock(&sh.tray);
    if let Some(t) = tray.as_ref() {
        t.set(&lock(&sh.view));
    }
}

fn set_view(app: &AppHandle, f: impl FnOnce(&mut tray::View)) {
    f(&mut lock(&shell_of(app).view));
    refresh_tray(app);
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
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.navigate(url);
                }
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
        if let Some(w) = app.get_webview_window("main") {
            let on_page = w.url().is_ok_and(|u| u.host_str() == Some("127.0.0.1") && u.port() == Some(port));
            if !on_page {
                let _ = w.navigate(url);
            } else if reload {
                let _ = w.eval("location.reload()");
            }
        }
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
                                if let Some(seq) = serde_json::from_str::<Value>(&line).ok().and_then(|j| j.get("seq").and_then(Value::as_u64)) {
                                    last_seq = seq;
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
        Update::Notice(n) => {
            let (title, body) = n.text();
            if window_in_front(app) {
                return;
            }
            let sent = app.notification().builder().title(title).body(body).show();
            // Only the title is written down: a notice may name a file.
            shell_of(app)
                .logger
                .log("app", &format!("notice \"{title}\": {}", if sent.is_ok() { "sent".to_owned() } else { "the system refused it".to_owned() }));
        }
    }
}

pub fn stop_task(app: &AppHandle) {
    if let Some(w) = lock(&shell_of(app).writer).as_ref() {
        let _ = w.send_text(r#"{"cmd":"cancel"}"#);
    }
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
            if let Some(t) = lock(&sh.tray).as_ref() {
                t.set_login(value);
            }
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
            } else if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
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
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.__navviedShell&&window.__navviedShell.fill({js_text})"));
    }
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

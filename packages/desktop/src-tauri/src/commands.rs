//! The only commands a page can call. Pages are limited by `capabilities/`; each command also checks who is calling.

use crate::shell::{self, Shell};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State, Webview};

/// A page on the loopback address that the app itself opened.
fn from_loopback(webview: &Webview, shell: &Shell) -> bool {
    let url = webview.url();
    let port = shell.page_port.load(std::sync::atomic::Ordering::SeqCst);
    url.as_ref().is_ok_and(|u| u.scheme() == "http" && u.host_str() == Some("127.0.0.1") && port > 0 && u.port() == Some(port))
}

fn from_app(webview: &Webview) -> bool {
    webview.url().as_ref().is_ok_and(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
}

#[tauri::command]
pub fn shell_answer(app: AppHandle, webview: Webview, shell: State<Arc<Shell>>, id: String, choice: String, checked: bool) {
    if from_loopback(&webview, &shell) {
        shell::answer(&app, &shell, &id, &choice, checked);
    }
}

#[tauri::command]
pub fn shell_settings_get(webview: Webview, shell: State<Arc<Shell>>) -> Value {
    if !from_loopback(&webview, &shell) {
        return json!({});
    }
    serde_json::to_value(&*shell.settings.lock().unwrap_or_else(|e| e.into_inner())).unwrap_or_else(|_| json!({}))
}

#[tauri::command]
pub fn shell_settings_set(app: AppHandle, webview: Webview, shell: State<Arc<Shell>>, key: String, value: bool) -> Result<(), String> {
    if !from_loopback(&webview, &shell) {
        return Err("not allowed".into());
    }
    shell::set_setting(&app, &shell, &key, value)
}

#[tauri::command]
pub fn page_action(app: AppHandle, webview: Webview, shell: State<Arc<Shell>>, action: String) -> Result<String, String> {
    if !from_app(&webview) {
        return Err("not allowed".into());
    }
    shell::page_action(&app, &shell, &action)
}

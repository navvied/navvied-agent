fn main() {
    // Only these commands exist for pages. `capabilities/` says which page may call which.
    let app = tauri_build::AppManifest::new().commands(&["shell_answer", "shell_settings_get", "shell_settings_set", "page_action", "relay_pair", "relay_status", "relay_forget", "relay_answer"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app)).expect("tauri build");
}

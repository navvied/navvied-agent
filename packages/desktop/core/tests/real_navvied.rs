//! The real program, not the fake one. Set NAVVIED_BIN to a compiled `navvied` (CI does, and sets NAVVIED_REQUIRE_REAL=1
//! so that forgetting it fails instead of skipping).
mod common;
use common::*;
use navvied_desktop_core::http::{get, post};
use navvied_desktop_core::supervisor::Event;
use navvied_desktop_core::ws;
use std::time::Duration;

fn real(env: &[(&str, &str)]) -> Option<navvied_desktop_core::supervisor::Config> {
    let Ok(bin) = std::env::var("NAVVIED_BIN") else {
        assert!(std::env::var("NAVVIED_REQUIRE_REAL").is_err(), "NAVVIED_BIN is required here");
        eprintln!("skipped: NAVVIED_BIN is not set");
        return None;
    };
    let home = temp_dir("home");
    let mut cfg = config(env);
    cfg.program = bin.into();
    cfg.extra_env.extend([
        ("HOME".into(), home.to_string_lossy().into_owned()),
        ("USERPROFILE".into(), home.to_string_lossy().into_owned()),
        ("XDG_CONFIG_HOME".into(), home.join("c").to_string_lossy().into_owned()),
        ("XDG_STATE_HOME".into(), home.join("s").to_string_lossy().into_owned()),
    ]);
    cfg.extra_env.extend([("NAVVIED_BASE_URL".into(), String::new()), ("NAVVIED_MODEL".into(), String::new())]);
    // The program offers the free hosted models by default. These tests are about the app and the program, never about a network model.
    for folder in [home.join(".config").join("navvied"), home.join("c").join("navvied")] {
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("config.json"), r#"{"guestModels":false,"models":{}}"#).unwrap();
    }
    cfg.ready_timeout = Duration::from_secs(20);
    Some(cfg)
}

#[test]
fn the_real_program_starts_answers_with_the_key_and_refuses_without_it() {
    let Some(cfg) = real(&[]) else { return };
    let mut rig = start(cfg);
    let (port, _) = rig.wait(|e| {
        if let Event::Running { port, info, .. } = e {
            assert!(!info.version.is_empty());
            Some(*port)
        } else {
            None
        }
    });
    let none = get(port, "/api/info", None, Duration::from_secs(3)).unwrap();
    assert_eq!(none.status, 401);
    let wrong = get(port, "/api/info", Some("not-the-right-key-at-all"), Duration::from_secs(3)).unwrap();
    assert_eq!(wrong.status, 401);
    let page = get(port, "/", None, Duration::from_secs(3)).unwrap();
    assert_eq!(page.status, 200);
    assert!(page.header("content-security-policy").is_some_and(|c| c.contains("default-src 'self'")));
    assert!(!page.body.contains(rig.token.expose()), "the page must not carry the key");
    rig.stop();
}

#[test]
fn the_real_program_takes_a_command_over_the_socket_and_stops_with_the_app() {
    let Some(cfg) = real(&[]) else { return };
    let mut rig = start(cfg);
    let port = rig.running();
    let (mut reader, writer) = ws::connect(port, rig.token.expose(), 0, Duration::from_secs(5)).unwrap();
    writer.send_text(r#"{"cmd":"prompt","text":"hello","qid":"q1"}"#).unwrap();
    let mut seen = String::new();
    let end = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < end && !seen.contains(r#""ev":"done""#) {
        if let Some(line) = reader.next(Duration::from_millis(200)).unwrap() {
            seen.push_str(&line);
        }
    }
    assert!(seen.contains("No model is connected"), "without a model the program says so: {seen}");
    assert!(seen.contains(r#""ev":"done""#), "the turn ended: {seen}");
    assert!(!seen.contains(rig.token.expose()));
    rig.stop();
    assert!(get(port, "/api/info", Some(rig.token.expose()), Duration::from_secs(1)).is_err(), "the program is gone");
}

#[test]
fn the_real_program_leaves_nothing_in_the_log_that_holds_the_key() {
    let Some(cfg) = real(&[]) else { return };
    let dir = temp_dir("reallog");
    let file = dir.join("app.log");
    let mut rig = start_with(cfg, Some(file.clone()), |_, _| {});
    rig.running();
    rig.stop();
    assert!(!rig.logger.recent().join("\n").contains(rig.token.expose()));
    assert!(!std::fs::read_to_string(&file).unwrap_or_default().contains(rig.token.expose()));
}

/// The HTTP half of pairing with the relay (the shell's `relay_pair`/`relay_status` eventually call exactly this):
/// no relay needs to answer for the sidecar to make a link and report it, since connecting to it is attempted in
/// the background and retried, never awaited by the endpoint itself.
#[test]
fn the_real_program_can_be_asked_over_http_to_make_a_relay_pairing_link() {
    let Some(mut cfg) = real(&[]) else { return };
    // Nothing answers here; proving the HTTP contract does not need a reachable relay.
    cfg.extra_env.push(("NAVVIED_RELAY_URL".to_owned(), "ws://127.0.0.1:1/relay/ws".to_owned()));
    let dir = temp_dir("reallog2");
    let file = dir.join("app.log");
    let mut rig = start_with(cfg, Some(file.clone()), |_, _| {});
    let port = rig.running();
    let token = rig.token.expose().to_owned();

    let made = post(port, "/api/relay/pair", Some(&token), r#"{"label":"Rust test"}"#, Duration::from_secs(3)).unwrap();
    assert_eq!(made.status, 200);
    let body: serde_json::Value = serde_json::from_str(&made.body).unwrap();
    let link = body["link"].as_str().expect("a link").to_owned();
    assert!(link.starts_with("https://navvied.com/#relay="));
    let secret = link.rsplit('=').next().unwrap().to_owned();

    let status = get(port, "/api/relay/status", Some(&token), Duration::from_secs(3)).unwrap();
    assert_eq!(status.status, 200);
    let status: serde_json::Value = serde_json::from_str(&status.body).unwrap();
    assert_eq!(status["devices"][0]["label"], "Rust test");
    assert_eq!(status["devices"][0]["pending"], true);
    // The response that hands the shell its own link is the one place the secret is meant to be; the log is not.
    assert!(!status.to_string().contains(&secret));

    rig.stop();
    let logged = rig.logger.recent().join("\n") + &std::fs::read_to_string(&file).unwrap_or_default();
    assert!(!logged.contains(&token));
    assert!(!logged.contains(&secret));
}

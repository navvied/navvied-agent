mod common;
use common::*;
use navvied_desktop_core::events::{Notice, Settings, Tracker, Update};
use navvied_desktop_core::ws;
use std::io::ErrorKind;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(3);

#[test]
fn events_arrive_in_order_and_a_quiet_connection_returns_nothing() {
    let events = r#"{"ev":"session","id":"s1","seq":1}
{"ev":"text","text":"hello","seq":2}
sleep:1500
{"ev":"done","stop":"end_turn","seq":3}"#;
    let mut rig = start(config(&[("FAKE_EVENTS", events)]));
    let port = rig.running();
    let (mut reader, _w) = ws::connect(port, rig.token.expose(), 0, WAIT).unwrap();
    let began = Instant::now();
    let mut seen: Vec<(u128, String)> = Vec::new();
    while seen.len() < 3 && began.elapsed() < Duration::from_secs(8) {
        if let Some(line) = reader.next(Duration::from_millis(50)).unwrap() {
            seen.push((began.elapsed().as_millis(), line));
        }
    }
    let report = format!("arrivals (ms, text): {seen:?}\nlog: {:?}", rig.logger.recent());
    assert_eq!(seen.len(), 3, "{report}");
    assert!(seen[0].1.contains("session") && seen[1].1.contains("hello") && seen[2].1.contains("done"), "{report}");
    assert!(seen[2].0 >= seen[1].0 + 1000, "the pause between the events was not kept: {report}");
    rig.stop();
}

#[test]
fn a_wrong_key_is_refused() {
    let mut rig = start(config(&[]));
    let port = rig.running();
    let err = ws::connect(port, "not-the-right-key-at-all", 0, WAIT).err().expect("refused");
    assert_eq!(err.kind(), ErrorKind::PermissionDenied);
    rig.stop();
}

#[test]
fn a_command_can_be_sent_to_the_program() {
    let dir = temp_dir("cancel");
    let file = dir.join("cancelled");
    let mut rig = start(config(&[("FAKE_CANCEL_FILE", &file.to_string_lossy())]));
    let port = rig.running();
    let (_r, w) = ws::connect(port, rig.token.expose(), 0, WAIT).unwrap();
    w.send_text(r#"{"cmd":"cancel"}"#).unwrap();
    let end = Instant::now() + Duration::from_secs(3);
    while !file.exists() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(file.exists(), "the program never received the command");
    rig.stop();
}

#[test]
fn the_end_of_the_program_ends_the_connection() {
    let mut rig = start(config(&[]));
    let port = rig.running();
    let (mut reader, _w) = ws::connect(port, rig.token.expose(), 0, WAIT).unwrap();
    rig.stop();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        match reader.next(Duration::from_millis(100)) {
            Err(_) => break,
            Ok(_) if Instant::now() > end => panic!("the connection stayed open"),
            Ok(_) => {}
        }
    }
}

#[test]
fn a_long_task_over_the_connection_makes_exactly_the_two_notices() {
    let events = r#"{"ev":"taken","qid":"a","seq":1}
sleep:500
{"ev":"approval","id":"1","title":"Edit src/a.ts","options":[],"seq":2}
sleep:500
{"ev":"done","stop":"end_turn","seq":3}
{"ev":"taken","qid":"b","seq":4}
{"ev":"done","stop":"end_turn","seq":5}"#;
    let mut rig = start(config(&[("FAKE_EVENTS", events)]));
    let port = rig.running();
    let (mut reader, _w) = ws::connect(port, rig.token.expose(), 0, WAIT).unwrap();
    let mut tracker = Tracker::new(Settings { min_task: Duration::from_millis(800), ..Settings::default() });
    let began = Instant::now();
    let mut notices = Vec::new();
    let end = Instant::now() + Duration::from_secs(4);
    while Instant::now() < end && notices.len() < 2 {
        if let Some(line) = reader.next(Duration::from_millis(100)).unwrap() {
            for u in tracker.feed(&line, began.elapsed()) {
                if let Update::Notice(n) = u {
                    notices.push(n);
                }
            }
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    while let Ok(Some(line)) = reader.next(Duration::from_millis(50)) {
        for u in tracker.feed(&line, began.elapsed()) {
            if let Update::Notice(n) = u {
                notices.push(n);
            }
        }
    }
    assert_eq!(notices, vec![Notice::NeedsYou { detail: Some("Edit src/a.ts".into()) }, Notice::Finished], "the second, short task must not add a notice");
    rig.stop();
}

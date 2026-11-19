mod common;
use common::*;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn when_the_app_is_killed_the_program_goes_too() {
    let dir = temp_dir("death");
    let pidfile = dir.join("pid");
    let mut harness = Command::new(env!("CARGO_BIN_EXE_supervisor-harness"))
        .env("HARNESS_PROGRAM", FAKE)
        .env("FAKE_PID_FILE", &pidfile)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(harness.stdout.take().unwrap()).lines();
    let line = lines.next().expect("the harness said nothing").unwrap();
    assert!(line.starts_with("READY "), "{line}");
    let sidecar: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    assert!(alive(sidecar));
    harness.kill().unwrap();
    let _ = harness.wait();
    assert!(wait_dead(sidecar, 5), "the program kept running after the app was killed");
}

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

/// What the engine starts for itself (a local model server) is a grandchild of the app: it is in the program's process group, so
/// ending the program's tree reaches it, but nothing reaches it when the app itself is killed and only the program is signalled.
#[test]
fn when_the_app_is_killed_what_the_program_started_goes_too() {
    let dir = temp_dir("death-grand");
    let (pidfile, grandfile) = (dir.join("pid"), dir.join("grand"));
    let mut harness = Command::new(env!("CARGO_BIN_EXE_supervisor-harness"))
        .env("HARNESS_PROGRAM", FAKE)
        .env("FAKE_PID_FILE", &pidfile)
        .env("FAKE_GRANDCHILD_FILE", &grandfile)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(harness.stdout.take().unwrap()).lines();
    assert!(lines.next().expect("the harness said nothing").unwrap().starts_with("READY "));
    let sidecar: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    let grand: u32 = std::fs::read_to_string(&grandfile).unwrap().trim().parse().unwrap();
    assert!(alive(sidecar) && alive(grand));
    harness.kill().unwrap();
    let _ = harness.wait();
    assert!(wait_dead(sidecar, 5), "the program kept running after the app was killed");
    let gone = wait_dead(grand, 5);
    if !gone {
        #[cfg(unix)]
        // SAFETY: ending the test's own leftover sleeper, whose pid we just read from it.
        unsafe {
            libc::kill(grand as i32, libc::SIGKILL);
        }
    }
    assert!(gone, "what the program started was left running after the app was killed");
}

mod common;
use common::*;
use navvied_desktop_core::supervisor::{Event, StartFailure};
use std::time::Duration;

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[test]
fn it_starts_the_program_and_reports_the_port_and_what_it_says_about_itself() {
    let mut rig = start(config(&[]));
    let (port, _) = rig.wait(|e| {
        if let Event::Running { port, info, recovered } = e {
            assert!(!recovered);
            assert_eq!(info.model.as_deref(), Some("fake-model"));
            Some(*port)
        } else {
            None
        }
    });
    assert!(port > 0);
    assert_eq!(rig.sup.as_ref().unwrap().port(), Some(port));
    rig.stop();
    assert!(matches!(rig.events.recv_timeout(Duration::from_secs(5)), Ok(Event::Stopped) | Ok(_)));
}

#[test]
fn the_token_is_not_in_the_programs_command_line() {
    let mut rig = start(config(&[]));
    rig.running();
    let token = rig.token.expose().to_owned();
    #[cfg(unix)]
    {
        let out = std::process::Command::new("ps").args(["-eo", "args="]).output().unwrap();
        let all = String::from_utf8_lossy(&out.stdout);
        assert!(all.contains("fake-sidecar"), "the child should be in the list");
        assert!(!all.contains(&token), "the key must not be on any command line");
    }
    #[cfg(windows)]
    {
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&out.stdout).contains(&token));
    }
    rig.stop();
}

#[test]
fn a_program_that_prints_the_key_cannot_get_it_into_the_log() {
    let dir = temp_dir("leak");
    let file = dir.join("app.log");
    let mut rig = start_with(config(&[("FAKE_LEAK_TOKEN", "1")]), Some(file.clone()), |_, _| {});
    rig.running();
    rig.stop();
    let token = rig.token.expose();
    let recent = rig.logger.recent().join("\n");
    let on_disk = std::fs::read_to_string(&file).unwrap();
    for text in [&recent, &on_disk] {
        assert!(!text.contains(token), "the key reached a log");
        assert!(text.contains("[key]"), "the line should be there with the key blanked out");
    }
    #[cfg(unix)]
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&file).unwrap().permissions()) & 0o777, 0o600);
}

#[test]
fn a_crash_starts_it_again_on_the_same_port_after_a_pause() {
    let dir = temp_dir("crash1");
    let counter = dir.join("n").to_string_lossy().into_owned();
    let mut rig = start(config(&[("FAKE_COUNTER_FILE", &counter), ("FAKE_CRASH_FIRST_N", "1")]));
    let first = rig.running();
    let ((attempt, pause), _) = rig.wait(|e| if let Event::Crashed { attempt, restart_in } = e { Some((*attempt, *restart_in)) } else { None });
    assert_eq!((attempt, pause), (1, ms(500)));
    let ((port, recovered), _) = rig.wait(|e| if let Event::Running { port, recovered, .. } = e { Some((*port, *recovered)) } else { None });
    assert!(recovered, "the second start is a recovery");
    assert_eq!(port, first, "the address stays the same so the page keeps its settings");
    rig.stop();
}

#[test]
fn it_gives_up_on_the_third_crash_inside_a_minute() {
    let mut rig = start(config(&[("FAKE_CRASH_AFTER_MS", "150")]));
    let (crashes, seen) = rig.wait(|e| if let Event::GaveUp { crashes } = e { Some(*crashes) } else { None });
    assert_eq!(crashes, 3);
    let pauses: Vec<_> = seen.iter().filter_map(|e| if let Event::Crashed { restart_in, .. } = e { Some(*restart_in) } else { None }).collect();
    assert_eq!(pauses, vec![ms(500), ms(1000)]);
    rig.stop();
}

#[test]
fn a_crash_after_a_quiet_minute_starts_the_count_again() {
    let dir = temp_dir("quiet");
    let counter = dir.join("n").to_string_lossy().into_owned();
    let mut rig = start_with(config(&[("FAKE_COUNTER_FILE", &counter), ("FAKE_CRASH_FIRST_N", "4")]), None, |e, clock| {
        if matches!(e, Event::Running { .. }) {
            clock.advance(Duration::from_secs(61));
        }
    });
    let mut crashed = 0;
    while crashed < 4 {
        let (attempt, _) = rig.wait(|e| match e {
            Event::Crashed { attempt, .. } => Some(*attempt),
            Event::GaveUp { .. } => panic!("it gave up although each crash was a minute apart"),
            _ => None,
        });
        assert_eq!(attempt, 1, "each crash counts as the first");
        crashed += 1;
    }
    rig.stop();
}

#[test]
fn stopping_ends_the_program_and_what_it_started() {
    let dir = temp_dir("tree");
    let pidfile = dir.join("grandchild");
    let mut rig = start(config(&[("FAKE_GRANDCHILD_FILE", &pidfile.to_string_lossy())]));
    rig.running();
    let grandchild: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    assert!(alive(grandchild));
    rig.stop();
    assert!(wait_dead(grandchild, 5), "a program started by the program outlived the app");
}

/// The program dies on its own (killed by the system when memory runs out, say) while the app lives: what it had started must not
/// be left behind for the next program to find, and the next one starts clean.
#[cfg(unix)]
#[test]
fn when_the_program_dies_alone_what_it_started_goes_too() {
    let dir = temp_dir("died-alone");
    let (pidfile, grandfile) = (dir.join("pid"), dir.join("grandchild"));
    let mut rig = start(config(&[("FAKE_PID_FILE", &pidfile.to_string_lossy()), ("FAKE_GRANDCHILD_FILE", &grandfile.to_string_lossy())]));
    rig.running();
    let program: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    let grandchild: u32 = std::fs::read_to_string(&grandfile).unwrap().trim().parse().unwrap();
    assert!(alive(grandchild));
    // SAFETY: ending the fake program, whose pid it wrote itself, the way the system's out-of-memory killer would.
    unsafe {
        libc::kill(program, libc::SIGKILL);
    }
    rig.wait(|e| matches!(e, Event::Crashed { .. }).then_some(()));
    assert!(wait_dead(grandchild, 5), "what the program started outlived the program's own crash");
    rig.stop();
}

#[test]
fn a_program_that_ignores_the_closed_input_is_ended_after_the_grace_time() {
    let dir = temp_dir("ignore");
    let pidfile = dir.join("grandchild");
    let mut rig = start(config(&[("FAKE_IGNORE_STDIN", "1"), ("FAKE_GRANDCHILD_FILE", &pidfile.to_string_lossy())]));
    rig.running();
    let grandchild: u32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
    let began = std::time::Instant::now();
    rig.stop();
    assert!(began.elapsed() >= ms(500), "it waited for the grace time");
    assert!(began.elapsed() < Duration::from_secs(5));
    assert!(wait_dead(grandchild, 5));
}

#[test]
fn a_missing_program_is_reported_as_missing() {
    let mut cfg = config(&[]);
    cfg.program = "/definitely/not/here/navvied".into();
    let mut rig = start(cfg);
    let (f, _) = rig.wait(|e| if let Event::CannotStart(f) = e { Some(f.clone()) } else { None });
    assert_eq!(f, StartFailure::EngineMissing);
    rig.stop();
}

#[test]
fn a_program_that_ends_at_once_is_reported_as_blocked() {
    let mut rig = start(config(&[("FAKE_EXIT_AT_ONCE", "1")]));
    let (f, _) = rig.wait(|e| if let Event::CannotStart(f) = e { Some(f.clone()) } else { None });
    assert_eq!(f, StartFailure::Blocked { exit_code: Some(3) });
    rig.stop();
}

#[test]
fn a_program_that_never_answers_is_ended_and_reported() {
    let mut cfg = config(&[("FAKE_NO_READY", "1")]);
    cfg.ready_timeout = ms(700);
    let mut rig = start(cfg);
    let (f, _) = rig.wait(|e| if let Event::CannotStart(f) = e { Some(f.clone()) } else { None });
    assert_eq!(f, StartFailure::NoAnswer);
    rig.stop();
}

#[test]
fn try_again_after_a_failed_start_works() {
    let dir = temp_dir("again");
    let counter = dir.join("n").to_string_lossy().into_owned();
    let mut rig = start(config(&[("FAKE_COUNTER_FILE", &counter), ("FAKE_FAIL_FIRST_N", "1")]));
    rig.wait(|e| matches!(e, Event::CannotStart(_)).then_some(()));
    rig.sup.as_ref().unwrap().try_again();
    rig.running();
    rig.stop();
}

#[test]
fn a_taken_port_falls_back_to_a_free_one() {
    let squatter = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let taken = squatter.local_addr().unwrap().port();
    let mut cfg = config(&[]);
    cfg.port_hint = Some(taken);
    let mut rig = start(cfg);
    let port = rig.running();
    assert_ne!(port, taken);
    rig.stop();
}

#[test]
fn the_usual_port_is_used_when_it_is_free() {
    let free = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    let mut cfg = config(&[]);
    cfg.port_hint = Some(free);
    let mut rig = start(cfg);
    assert_eq!(rig.running(), free);
    rig.stop();
}

#[test]
fn switching_the_folder_restarts_without_counting_a_crash() {
    let dir = temp_dir("folder");
    let mut rig = start(config(&[]));
    rig.running();
    rig.sup.as_ref().unwrap().restart_in(dir.clone());
    let ((cwd, recovered), seen) = rig.wait(|e| if let Event::Running { info, recovered, .. } = e { Some((info.cwd.clone(), *recovered)) } else { None });
    assert_eq!(cwd, dir.to_string_lossy());
    assert!(!recovered);
    assert!(!seen.iter().any(|e| matches!(e, Event::Crashed { .. })));
    rig.stop();
}

#[test]
fn try_again_after_giving_up_starts_it_and_counts_afresh() {
    let dir = temp_dir("giveup-again");
    let counter = dir.join("n").to_string_lossy().into_owned();
    let mut rig = start(config(&[("FAKE_COUNTER_FILE", &counter), ("FAKE_CRASH_FIRST_N", "3")]));
    rig.wait(|e| matches!(e, Event::GaveUp { .. }).then_some(()));
    rig.sup.as_ref().unwrap().try_again();
    let (port, seen) = rig.wait(|e| if let Event::Running { port, .. } = e { Some(*port) } else { None });
    assert!(port > 0);
    assert!(seen.iter().any(|e| matches!(e, Event::Starting)), "it announces the new start: {seen:?}");
    assert_eq!(rig.sup.as_ref().unwrap().port(), Some(port));
    rig.stop();
}

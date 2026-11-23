//! Inside an AppImage the app is started with its own libraries and programs first in `LD_LIBRARY_PATH` and `PATH`. What the program
//! starts (a shell command, a local model server) must not inherit them. Its own file, so changing the environment cannot reach another
//! test's programs.
#![cfg(target_os = "linux")]
mod common;
use common::*;
use navvied_desktop_core::logs::Logger;
use navvied_desktop_core::redact::Redactor;
use navvied_desktop_core::spawn::{OsSpawner, SidecarSpec, Spawner};
use std::sync::Arc;

#[test]
fn the_program_does_not_inherit_the_bundles_libraries_or_programs() {
    let dir = temp_dir("bundle-env");
    let out = dir.join("env");
    std::env::set_var("APPDIR", "/tmp/.mount_navvtest");
    std::env::set_var("LD_LIBRARY_PATH", "/tmp/.mount_navvtest/usr/lib/:/home/me/lib");
    std::env::set_var("LD_PRELOAD", "/tmp/.mount_navvtest/usr/lib/shim.so");
    std::env::set_var("PATH", format!("/tmp/.mount_navvtest/usr/bin/:{}", std::env::var("PATH").unwrap()));
    let spawner = OsSpawner { logger: Arc::new(Logger::new(Arc::new(Redactor::new()), None)) };
    let script = format!("printf '%s\\n%s\\n%s\\n' \"${{LD_LIBRARY_PATH-unset}}\" \"${{LD_PRELOAD-unset}}\" \"$PATH\" > '{}'", out.display());
    let spec = SidecarSpec { program: "/bin/sh".into(), args: vec!["-c".into(), script], env: vec![], cwd: dir.clone() };
    let mut program = spawner.spawn(&spec).unwrap();
    while program.try_wait().unwrap().is_none() {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let seen = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = seen.lines().collect();
    assert_eq!(lines[0], "/home/me/lib", "what the person had set stays, what the bundle added goes");
    assert_eq!(lines[1], "unset", "a preload that was only the bundle's goes");
    assert!(!lines[2].contains(".mount_navvtest") && lines[2].contains("/usr/bin"), "the programs path is the person's own: {}", lines[2]);
}

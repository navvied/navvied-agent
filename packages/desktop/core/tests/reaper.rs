//! The helper that ends the program's group when the app dies (see `tree.rs`) must leave nothing behind when the app does not die.
//! Its own file, so it is the only test in its process: whether any child of the process is left, finished or not, is a question
//! about the whole process, and another test's programs would answer it.
#![cfg(unix)]
mod common;
use common::*;

#[test]
fn a_program_that_is_stopped_leaves_no_helper_and_no_zombie_behind() {
    for _ in 0..3 {
        let mut rig = start(config(&[]));
        rig.running();
        rig.stop();
    }
    let mut status = 0;
    // SAFETY: asks whether this process still has any child, finished or running, without waiting for one.
    let left = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
    let error = std::io::Error::last_os_error().raw_os_error();
    assert!(left == -1 && error == Some(libc::ECHILD), "a child of the app was left behind (waitpid said {left}, errno {error:?})");
}

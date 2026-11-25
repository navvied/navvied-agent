//! The two grants macOS asks a program for before it may drive other programs: Accessibility (to read and press their controls) and Screen
//! Recording (to see them). The driver runs as this program's child, so the grants must be this program's own: it asks for them itself.
//! Nothing else needs a grant (Windows and Linux X11 have none), so there everything reads as not needed.
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Grant {
    Accessibility,
    ScreenRecording,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Granted,
    Missing,
    NotNeeded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Status {
    pub accessibility: State,
    pub screen_recording: State,
}

impl Status {
    pub fn of(&self, g: Grant) -> State {
        match g {
            Grant::Accessibility => self.accessibility,
            Grant::ScreenRecording => self.screen_recording,
        }
    }
    pub fn ready(&self) -> bool {
        self.accessibility != State::Missing && self.screen_recording != State::Missing
    }
}

/// What the operating system can be asked. The real one is `Native`; tests make their own.
pub trait System {
    fn needed(&self) -> bool;
    fn accessibility_granted(&self) -> bool;
    fn screen_recording_granted(&self) -> bool;
    /// Shows the system's own question for the grant, once.
    fn ask(&self, g: Grant);
    /// Opens the page of System Settings where the person turns the grant on.
    fn open_settings(&self, g: Grant);
}

pub fn status(sys: &dyn System) -> Status {
    if !sys.needed() {
        return Status { accessibility: State::NotNeeded, screen_recording: State::NotNeeded };
    }
    let of = |granted: bool| if granted { State::Granted } else { State::Missing };
    Status { accessibility: of(sys.accessibility_granted()), screen_recording: of(sys.screen_recording_granted()) }
}

/// Asks for the missing grants one at a time: a second system question shown while the first is still open is dropped by macOS, so the next
/// one is only asked once the first has been answered (its state is no longer unknown) and never twice in one run of the app.
#[derive(Default)]
pub struct Asker {
    asked: Vec<Grant>,
}

impl Asker {
    /// The grant to ask for now, if any: the first missing one not asked yet, and none while the one asked last is still unanswered.
    pub fn next(&self, now: &Status, answered: &[Grant]) -> Option<Grant> {
        if let Some(last) = self.asked.last() {
            if now.of(*last) == State::Missing && !answered.contains(last) {
                return None;
            }
        }
        [Grant::Accessibility, Grant::ScreenRecording].into_iter().find(|g| now.of(*g) == State::Missing && !self.asked.contains(g))
    }

    pub fn ask(&mut self, sys: &dyn System, g: Grant) {
        self.asked.push(g);
        sys.ask(g);
    }
}

pub fn settings_url(g: Grant) -> &'static str {
    match g {
        Grant::Accessibility => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        Grant::ScreenRecording => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{settings_url, Grant, System};
    use std::ffi::c_void;
    use std::process::Command;

    type CFTypeRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFTypeRef;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFAllocatorDefault: CFTypeRef;
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDictionaryCreate(alloc: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, n: isize, key_cb: *const c_void, value_cb: *const c_void) -> CFTypeRef;
        fn CFRelease(r: CFTypeRef);
    }

    pub struct Native;

    impl System for Native {
        fn needed(&self) -> bool {
            true
        }
        fn accessibility_granted(&self) -> bool {
            unsafe { AXIsProcessTrusted() }
        }
        fn screen_recording_granted(&self) -> bool {
            unsafe { CGPreflightScreenCaptureAccess() }
        }
        fn ask(&self, g: Grant) {
            unsafe {
                match g {
                    Grant::Accessibility => {
                        let keys = [kAXTrustedCheckOptionPrompt];
                        let values = [kCFBooleanTrue];
                        let dict = CFDictionaryCreate(kCFAllocatorDefault, keys.as_ptr(), values.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
                        AXIsProcessTrustedWithOptions(dict);
                        CFRelease(dict);
                    }
                    Grant::ScreenRecording => {
                        CGRequestScreenCaptureAccess();
                    }
                }
            }
        }
        fn open_settings(&self, g: Grant) {
            let _ = Command::new("/usr/bin/open").arg(settings_url(g)).spawn();
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::{Grant, System};

    pub struct Native;

    impl System for Native {
        fn needed(&self) -> bool {
            false
        }
        fn accessibility_granted(&self) -> bool {
            true
        }
        fn screen_recording_granted(&self) -> bool {
            true
        }
        fn ask(&self, _: Grant) {}
        fn open_settings(&self, _: Grant) {}
    }
}

pub use mac::Native;

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake {
        needed: bool,
        ax: Cell<bool>,
        screen: Cell<bool>,
        asked: RefCell<Vec<Grant>>,
    }
    impl Fake {
        fn new(needed: bool, ax: bool, screen: bool) -> Self {
            Fake { needed, ax: Cell::new(ax), screen: Cell::new(screen), asked: RefCell::new(vec![]) }
        }
    }
    impl System for Fake {
        fn needed(&self) -> bool {
            self.needed
        }
        fn accessibility_granted(&self) -> bool {
            self.ax.get()
        }
        fn screen_recording_granted(&self) -> bool {
            self.screen.get()
        }
        fn ask(&self, g: Grant) {
            self.asked.borrow_mut().push(g);
        }
        fn open_settings(&self, _: Grant) {}
    }

    #[test]
    fn where_nothing_is_granted_nothing_is_missing() {
        let s = status(&Fake::new(false, false, false));
        assert_eq!(s, Status { accessibility: State::NotNeeded, screen_recording: State::NotNeeded });
        assert!(s.ready());
    }

    #[test]
    fn each_grant_reads_as_granted_or_missing() {
        let s = status(&Fake::new(true, true, false));
        assert_eq!((s.accessibility, s.screen_recording), (State::Granted, State::Missing));
        assert!(!s.ready());
        assert!(status(&Fake::new(true, true, true)).ready());
    }

    #[test]
    fn the_second_question_waits_for_the_first_to_be_answered_and_nothing_is_asked_twice() {
        let sys = Fake::new(true, false, false);
        let mut asker = Asker::default();
        let now = status(&sys);
        assert_eq!(asker.next(&now, &[]), Some(Grant::Accessibility));
        asker.ask(&sys, Grant::Accessibility);
        assert_eq!(asker.next(&status(&sys), &[]), None, "the first is still open");
        sys.ax.set(true);
        assert_eq!(asker.next(&status(&sys), &[]), Some(Grant::ScreenRecording));
        asker.ask(&sys, Grant::ScreenRecording);
        assert_eq!(*sys.asked.borrow(), vec![Grant::Accessibility, Grant::ScreenRecording]);
        sys.screen.set(true);
        assert_eq!(asker.next(&status(&sys), &[]), None);
    }

    #[test]
    fn a_question_the_person_answered_with_no_does_not_block_the_next_and_is_not_asked_again() {
        let sys = Fake::new(true, false, false);
        let mut asker = Asker::default();
        asker.ask(&sys, Grant::Accessibility);
        assert_eq!(asker.next(&status(&sys), &[Grant::Accessibility]), Some(Grant::ScreenRecording));
        asker.ask(&sys, Grant::ScreenRecording);
        assert_eq!(asker.next(&status(&sys), &[Grant::Accessibility, Grant::ScreenRecording]), None);
    }

    #[test]
    fn the_settings_pages_are_the_two_privacy_panes() {
        assert!(settings_url(Grant::Accessibility).ends_with("Privacy_Accessibility"));
        assert!(settings_url(Grant::ScreenRecording).ends_with("Privacy_ScreenCapture"));
    }
}

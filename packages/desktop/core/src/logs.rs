//! The app's own log. Every line passes through the redactor first, so a key cannot reach a file or a report.

use crate::redact::Redactor;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const KEEP_LINES: usize = 300;
const ROTATE_AT: u64 = 1024 * 1024;

pub struct Logger {
    redactor: Arc<Redactor>,
    path: Option<PathBuf>,
    file: Mutex<Option<File>>,
    recent: Mutex<VecDeque<String>>,
}

impl Logger {
    pub fn new(redactor: Arc<Redactor>, path: Option<PathBuf>) -> Logger {
        Logger { redactor, path, file: Mutex::new(None), recent: Mutex::new(VecDeque::new()) }
    }

    pub fn log(&self, source: &str, line: &str) {
        let line = format!("{source}: {}", self.redactor.clean(line.trim_end()));
        {
            let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
            if recent.len() == KEEP_LINES {
                recent.pop_front();
            }
            recent.push_back(line.clone());
        }
        let Some(path) = &self.path else { return };
        let mut slot = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|f| f.metadata().map(|m| m.len() > ROTATE_AT).unwrap_or(false)) {
            *slot = None;
            let _ = fs::rename(path, path.with_extension("log.1"));
        }
        if slot.is_none() {
            if let Some(dir) = path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let mut opts = OpenOptions::new();
            opts.create(true).append(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
            *slot = opts.open(path).ok();
        }
        if let Some(f) = slot.as_mut() {
            let _ = writeln!(f, "{line}");
        }
    }

    /// The latest lines, for "Copy details".
    pub fn recent(&self) -> Vec<String> {
        self.recent.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }
}

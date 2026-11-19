//! What the person chose in "This computer", kept in one small file. A damaged file never stops the app.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const RECENT: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Closing the window leaves the app running in the menu bar or tray.
    pub keep_running: bool,
    pub open_at_login: bool,
    pub notices: bool,
    /// Notices and the tray may name the file or the request.
    pub details: bool,
    /// The question about closing the window has been answered once.
    pub close_asked: bool,
    /// The welcome and the choice of a first folder have been shown.
    pub welcomed: bool,
    pub folder: Option<PathBuf>,
    pub recent_folders: Vec<PathBuf>,
    /// The port used last time, so the page keeps the same address and the settings it saved there.
    pub port: Option<u16>,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            keep_running: true,
            open_at_login: false,
            notices: true,
            details: true,
            close_asked: false,
            welcomed: false,
            folder: None,
            recent_folders: Vec::new(),
            port: None,
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Settings {
        fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Written beside the file and renamed over it, so a crash never leaves half a file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("tmp");
        let mut opts = fs::OpenOptions::new();
        opts.create(true).write(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp)?;
        f.write_all(serde_json::to_string_pretty(self).map_err(std::io::Error::other)?.as_bytes())?;
        f.sync_all()?;
        fs::rename(tmp, path)
    }

    pub fn work_in(&mut self, folder: PathBuf) {
        self.recent_folders.retain(|f| *f != folder);
        self.recent_folders.insert(0, folder.clone());
        self.recent_folders.truncate(RECENT);
        self.folder = Some(folder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("navvied-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d.join("settings.json")
    }

    #[test]
    fn what_is_saved_is_loaded() {
        let p = temp("roundtrip");
        let mut s = Settings { notices: false, port: Some(4242), ..Settings::default() };
        s.work_in("/a".into());
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p), s);
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(&p).unwrap().permissions()) & 0o777, 0o600);
    }

    #[test]
    fn a_missing_or_damaged_file_gives_the_defaults() {
        let p = temp("damaged");
        assert_eq!(Settings::load(&p), Settings::default());
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "{ not json").unwrap();
        assert_eq!(Settings::load(&p), Settings::default());
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let p = temp("partial");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, r#"{"notices":false,"from_the_future":1}"#).unwrap();
        let s = Settings::load(&p);
        assert!(!s.notices && s.keep_running);
    }

    #[test]
    fn recent_folders_are_newest_first_without_repeats_and_capped() {
        let mut s = Settings::default();
        for i in 0..12 {
            s.work_in(format!("/p{i}").into());
        }
        s.work_in("/p5".into());
        assert_eq!(s.recent_folders.len(), RECENT);
        assert_eq!(s.recent_folders[0], PathBuf::from("/p5"));
        assert_eq!(s.recent_folders.iter().filter(|f| f.as_path() == Path::new("/p5")).count(), 1);
        assert_eq!(s.folder, Some("/p5".into()));
    }
}

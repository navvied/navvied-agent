//! What the person asked for from outside the window: a folder dropped on the icon, or a `navvied://` link.
//! A link never runs anything. It only becomes a question the window asks, and every value is checked and limited here.

use std::path::{Path, PathBuf};

const MAX_TEXT: usize = 4000;
const MAX_PATH: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    /// Work in this folder (asked first).
    OpenFolder(PathBuf),
    /// Put this text in the message box (asked first, never sent).
    Chat { text: String },
    /// `--settings`: the way to the settings where there is no tray icon to reach them from.
    Settings,
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

fn decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                out.push(hex(*b.get(i + 1)?)? * 16 + hex(*b.get(i + 2)?)?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').filter_map(|p| p.split_once('=')).find(|(k, _)| *k == name).and_then(|(_, v)| decode(v))
}

/// `navvied://chat?text=…` and `navvied://open?folder=…`. Anything else, or anything out of bounds, gives `None`.
pub fn parse_link(link: &str) -> Option<Intent> {
    let rest = link.split('#').next()?.strip_prefix("navvied://")?;
    let (target, query) = rest.split_once('?').unwrap_or((rest, ""));
    match target.trim_end_matches('/') {
        "chat" => {
            let text = query_value(query, "text")?;
            let text: String = text.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect();
            let text = text.trim().to_owned();
            (!text.is_empty() && text.chars().count() <= MAX_TEXT).then_some(Intent::Chat { text })
        }
        "open" => {
            let folder = query_value(query, "folder")?;
            let path = Path::new(&folder);
            (path.is_absolute() && folder.len() <= MAX_PATH && !folder.chars().any(char::is_control) && !path.components().any(|c| c.as_os_str() == ".."))
                .then(|| Intent::OpenFolder(path.to_path_buf()))
        }
        _ => None,
    }
}

/// The command line a second launch carries: the first part is the program itself and is skipped. A folder that exists
/// is a drop; a `navvied://` link is a link; anything else is ignored.
pub fn from_args(args: &[String]) -> Vec<Intent> {
    args.iter()
        .skip(1)
        .filter_map(|a| {
            if a == "--settings" {
                Some(Intent::Settings)
            } else if a.starts_with("navvied://") {
                parse_link(a)
            } else {
                let p = Path::new(a);
                (p.is_absolute() && p.is_dir()).then(|| Intent::OpenFolder(p.to_path_buf()))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_link_gives_text_to_put_in_the_box() {
        assert_eq!(parse_link("navvied://chat?text=Explain%20how+the%20login%20works"), Some(Intent::Chat { text: "Explain how the login works".into() }));
    }

    #[test]
    fn control_characters_are_removed_and_empty_text_is_refused() {
        assert_eq!(parse_link("navvied://chat?text=a%00b%07c%0Ad"), Some(Intent::Chat { text: "abc\nd".into() }));
        assert_eq!(parse_link("navvied://chat?text=%20%20"), None);
        assert_eq!(parse_link("navvied://chat"), None);
    }

    #[test]
    fn too_long_text_is_refused_not_cut() {
        let long = "a".repeat(MAX_TEXT + 1);
        assert_eq!(parse_link(&format!("navvied://chat?text={long}")), None);
        assert!(parse_link(&format!("navvied://chat?text={}", "a".repeat(MAX_TEXT))).is_some());
    }

    #[test]
    fn an_open_link_needs_a_plain_absolute_path() {
        let ok = if cfg!(windows) { "C%3A%5CUsers%5Ame%5Cproj" } else { "%2Fhome%2Fme%2Fproj" };
        assert!(matches!(parse_link(&format!("navvied://open?folder={ok}")), Some(Intent::OpenFolder(_))));
        assert_eq!(parse_link("navvied://open?folder=relative%2Fpath"), None);
        assert_eq!(parse_link("navvied://open?folder=%2Fhome%2Fme%2F..%2Froot"), None);
        assert_eq!(parse_link("navvied://open?folder=%2Fhome%00x"), None);
        assert_eq!(parse_link("navvied://open"), None);
    }

    #[test]
    fn other_schemes_hosts_and_bad_escapes_are_ignored() {
        for l in
            ["http://chat?text=a", "navvied://run?cmd=rm", "navvied://chat?text=%zz", "navvied://chat?text=%C3%28", "navvied:/chat?text=a", "", "navvied://"]
        {
            assert_eq!(parse_link(l), None, "{l}");
        }
    }

    #[test]
    fn the_first_value_wins_and_the_rest_of_the_address_is_ignored() {
        assert_eq!(parse_link("navvied://chat?x=1&text=one&text=two#frag"), Some(Intent::Chat { text: "one".into() }));
    }

    #[test]
    fn a_launch_with_a_folder_or_a_link_gives_intents() {
        let dir = std::env::temp_dir();
        let args = vec![
            "navvied".to_owned(),
            dir.to_string_lossy().into_owned(),
            "navvied://chat?text=hi".to_owned(),
            "/no/such/folder".to_owned(),
            "--flag".to_owned(),
        ];
        assert_eq!(from_args(&args), vec![Intent::OpenFolder(dir), Intent::Chat { text: "hi".into() }]);
    }

    #[test]
    fn the_settings_flag_is_an_intent() {
        assert_eq!(from_args(&["navvied".into(), "--settings".into()]), vec![Intent::Settings]);
        assert!(from_args(&["--settings".into()]).is_empty(), "the first argument is the program");
    }

    #[test]
    fn a_file_is_not_a_folder() {
        let f = std::env::temp_dir().join(format!("navvied-intent-{}", std::process::id()));
        std::fs::write(&f, "x").unwrap();
        assert!(from_args(&["navvied".into(), f.to_string_lossy().into_owned()]).is_empty());
        let _ = std::fs::remove_file(f);
    }
}

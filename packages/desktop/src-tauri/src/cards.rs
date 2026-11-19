//! The questions the app asks, as data for the page's overlay (`shell-pages/overlay.js`); the page draws them in its own colours.

use serde_json::{json, Value};
use std::path::Path;

fn button(label: &str, choice: &str, primary: bool) -> Value {
    json!({ "label": label, "choice": choice, "kind": if primary { "pri" } else { "" } })
}

pub fn welcome() -> Value {
    json!({
        "title": "Welcome to navvied",
        "body": "navvied is an AI helper that works on your files and code, on this computer. Nothing leaves it unless you connect an online model.",
        "rows": [["It can", "Read and change files in one folder that you choose."], ["It asks first", "Before it changes a file or runs a command, you decide."], ["It stays here", "The conversation and the files stay on this computer."]],
        "buttons": [button("Get started", "start", true)],
        "width": 520,
    })
}

pub fn pick_folder(recent: &[std::path::PathBuf]) -> Value {
    let mut buttons: Vec<Value> = recent.iter().take(3).enumerate().map(|(i, p)| button(&folder_name(p), &format!("recent:{i}"), false)).collect();
    buttons.push(button("Choose folder…", "choose", true));
    json!({
        "title": "Which folder should navvied work in?",
        "body": "navvied can only read and change files inside the folder you choose. You can change it any time, or drop a folder on the navvied icon.",
        "buttons": buttons,
        "width": 520,
    })
}

pub fn close_question(menu_place: &str) -> Value {
    json!({
        "title": "navvied keeps working in the background",
        "body": format!("Its icon stays {menu_place}. Long tasks can finish, and you can open the window again from the icon. Choose Quit navvied there to stop it completely."),
        "checkbox": "Do not ask again",
        "buttons": [button("Quit navvied", "quit", false), button("Keep it running", "keep", true)],
    })
}

pub fn folder_question(folder: &Path) -> Value {
    json!({
        "title": format!("Work in “{}”?", folder_name(folder)),
        "body": "navvied will be able to read and change files only inside this folder. Your current conversation stays as it is.",
        "code": folder.to_string_lossy(),
        "buttons": [button("Cancel", "cancel", false), button("Work here", "work", true)],
    })
}

pub fn chat_question(text: &str) -> Value {
    json!({
        "title": "A link wants to start a chat",
        "body": "A page you opened asked navvied to prepare this message. It has not been sent. navvied only sends something when you press Send.",
        "code": text,
        "rows": [["Link", "navvied://chat?text=…"]],
        "buttons": [button("Ignore the link", "ignore", false), button("Put it in the message box", "fill", true)],
        "width": 480,
    })
}

#[cfg(feature = "updater")]
pub fn update_ready(current: &str, new: &str) -> Value {
    json!({
        "title": format!("navvied {new} is ready"),
        "body": "The download was checked against navvied's signature before this message.",
        "rows": [["You have", current], ["New version", new], ["Your chats", "Kept. A running task is stopped first."]],
        "buttons": [button("Later", "later", false), button("Restart and update", "update", true)],
    })
}

#[cfg(feature = "updater")]
pub fn update_progress(new: &str, pct: u32) -> Value {
    json!({ "title": "Updating navvied", "body": format!("Downloading version {new}. You can keep using navvied meanwhile."), "progress": pct, "buttons": [button("Hide", "hide", false)] })
}

#[cfg(feature = "updater")]
pub fn update_refused(version: &str, signature: bool) -> Value {
    if signature {
        json!({
            "title": "An update was refused",
            "body": "A new version was downloaded, but it did not pass navvied's safety check, so it was thrown away. Nothing changed: the version you have keeps working.",
            "code": format!("Version: {version}\nReason: the signature does not match"),
            "buttons": [button("OK", "ok", true)],
        })
    } else {
        json!({
            "title": "The update could not be downloaded",
            "body": "Nothing changed: the version you have keeps working. navvied will try again later.",
            "code": format!("Version: {version}"),
            "buttons": [button("OK", "ok", true)],
        })
    }
}

pub fn gave_up(details: &str) -> Value {
    json!({
        "title": "navvied keeps stopping",
        "body": "It stopped 3 times in one minute, so navvied stopped trying. Your chats and files are safe.",
        "code": "Reason: the program inside navvied kept ending",
        "copy": details,
        "buttons": [button("Show log folder", "logs", false), button("Copy details", "copy", false), button("Try again", "again", true)],
        "width": 520,
    })
}

pub fn settings(menu_place: &str) -> Value {
    json!({
        "title": "This computer",
        "body": "How the navvied app behaves on this computer.",
        "toggles": [
            { "key": "keep_running", "label": "Keep navvied running when I close the window", "hint": format!("Long tasks finish while the window is closed. The icon stays {menu_place}.") },
            { "key": "open_at_login", "label": "Open navvied when I sign in", "hint": "It starts quietly in the background, without a window." },
            { "key": "notices", "label": "Tell me when a task is done or navvied needs me", "hint": "A small notice from the system." },
            { "key": "details", "label": "Show what the task is in notices and the menu", "hint": "Turn this off if others can see your screen." },
        ],
        "buttons": [button("Done", "close", true)],
        "width": 560,
    })
}

pub fn folder_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string_lossy().into_owned())
}

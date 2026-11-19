//! The navvied desktop app. The program inside it, the window around it and the questions it asks live here;
//! everything that can be tested without a window is in `navvied-desktop-core`.

mod cards;
mod commands;
mod shell;
mod tray;

pub use shell::run;

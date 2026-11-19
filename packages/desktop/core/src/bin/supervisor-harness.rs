//! Runs the supervisor around the fake sidecar so a test can kill this whole process and watch the program inside go too.

use navvied_desktop_core::logs::Logger;
use navvied_desktop_core::redact::Redactor;
use navvied_desktop_core::spawn::OsSpawner;
use navvied_desktop_core::supervisor::{Config, Event, Supervisor, SystemClock};
use navvied_desktop_core::token::Token;
use std::sync::Arc;

fn main() {
    let program = std::env::var("HARNESS_PROGRAM").expect("HARNESS_PROGRAM");
    let cfg = Config::new(program.into(), std::env::temp_dir(), Token::generate().unwrap());
    let logger = Arc::new(Logger::new(Arc::new(Redactor::new()), None));
    let _sup = Supervisor::start(
        cfg,
        Arc::new(OsSpawner { logger: logger.clone() }),
        Arc::new(SystemClock::new()),
        logger,
        Box::new(|e| {
            if let Event::Running { port, .. } = e {
                println!("READY {port}");
            }
        }),
    );
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

#![allow(dead_code)]
use navvied_desktop_core::logs::Logger;
use navvied_desktop_core::redact::Redactor;
use navvied_desktop_core::spawn::OsSpawner;
use navvied_desktop_core::supervisor::{Clock, Config, Event, Supervisor};
use navvied_desktop_core::token::Token;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const FAKE: &str = env!("CARGO_BIN_EXE_fake-sidecar");

/// Time that only moves when asked: a pause costs nothing and the one-minute window can be crossed on purpose.
pub struct FakeClock {
    now: Mutex<Duration>,
    pub sleeps: Mutex<Vec<Duration>>,
}

impl FakeClock {
    pub fn new() -> Arc<FakeClock> {
        Arc::new(FakeClock { now: Mutex::new(Duration::ZERO), sleeps: Mutex::new(Vec::new()) })
    }
    pub fn advance(&self, d: Duration) {
        *self.now.lock().unwrap() += d;
    }
}

impl Clock for FakeClock {
    fn now(&self) -> Duration {
        *self.now.lock().unwrap()
    }
    fn sleep(&self, d: Duration) {
        self.sleeps.lock().unwrap().push(d);
        self.advance(d);
        std::thread::sleep(Duration::from_millis(1));
    }
}

pub struct Rig {
    pub sup: Option<Supervisor>,
    pub events: Receiver<Event>,
    pub logger: Arc<Logger>,
    pub token: Token,
    pub clock: Arc<FakeClock>,
}

pub fn temp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("navvied-core-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

pub fn config(env: &[(&str, &str)]) -> Config {
    let mut cfg = Config::new(PathBuf::from(FAKE), std::env::temp_dir(), Token::generate().unwrap());
    cfg.ready_timeout = Duration::from_secs(5);
    cfg.stop_grace = Duration::from_millis(600);
    cfg.extra_env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    cfg
}

pub fn start_with(cfg: Config, log_file: Option<PathBuf>, on_each: impl Fn(&Event, &FakeClock) + Send + 'static) -> Rig {
    let redactor = Arc::new(Redactor::new());
    redactor.add(cfg.token.expose());
    let logger = Arc::new(Logger::new(redactor, log_file));
    let clock = FakeClock::new();
    let (tx, events) = mpsc::channel();
    let c2 = clock.clone();
    let token = cfg.token.clone();
    let sup = Supervisor::start(
        cfg,
        Arc::new(OsSpawner { logger: logger.clone() }),
        clock.clone(),
        logger.clone(),
        Box::new(move |e| {
            on_each(&e, &c2);
            let _ = tx.send(e);
        }),
    );
    Rig { sup: Some(sup), events, logger, token, clock }
}

pub fn start(cfg: Config) -> Rig {
    start_with(cfg, None, |_, _| {})
}

impl Rig {
    /// The next event of the kind `pick` accepts; anything else on the way is returned with it.
    pub fn wait<T>(&self, pick: impl Fn(&Event) -> Option<T>) -> (T, Vec<Event>) {
        let mut seen = Vec::new();
        let end = Instant::now() + Duration::from_secs(20);
        while Instant::now() < end {
            if let Ok(e) = self.events.recv_timeout(Duration::from_millis(100)) {
                if let Some(t) = pick(&e) {
                    return (t, seen);
                }
                seen.push(e);
            }
        }
        panic!("the expected event never came; saw {seen:?}");
    }

    pub fn running(&self) -> u16 {
        self.wait(|e| if let Event::Running { port, .. } = e { Some(*port) } else { None }).0
    }

    pub fn stop(&mut self) {
        if let Some(s) = self.sup.take() {
            s.stop();
        }
    }
}

pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists.
        let r = unsafe { libc::kill(pid as i32, 0) };
        // A process that ended but is not yet collected still answers: look at its state too.
        r == 0 && !std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| s.contains(") Z")).unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

pub fn wait_dead(pid: u32, secs: u64) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    !alive(pid)
}

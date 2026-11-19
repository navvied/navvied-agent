//! Keeps the program running for the life of the app: starts it, notices when it ends, starts it again after a pause,
//! gives up when it keeps ending, and stops it (and everything it started) when the app quits.

use crate::http::{probe_info, Info};
use crate::logs::Logger;
use crate::ready::parse_ready;
use crate::spawn::{Process, SidecarSpec, Spawner};
use crate::token::Token;
use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(40);

/// Time, as the supervisor sees it. Tests replace it so pauses and the one-minute window cost nothing.
pub trait Clock: Send + Sync {
    fn now(&self) -> Duration;
    fn sleep(&self, d: Duration);
}

pub struct SystemClock(Instant);

impl SystemClock {
    pub fn new() -> SystemClock {
        SystemClock(Instant::now())
    }
}

impl Default for SystemClock {
    fn default() -> SystemClock {
        SystemClock::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, d: Duration) {
        thread::sleep(d);
    }
}

#[derive(Clone)]
pub struct Config {
    pub program: PathBuf,
    /// Placed before `serve`; empty for the compiled program.
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub token: Token,
    /// The port used last time, so the page keeps the same address (and its saved settings). Falls back to any free port.
    pub port_hint: Option<u16>,
    pub extra_env: Vec<(String, String)>,
    pub ready_timeout: Duration,
    pub stop_grace: Duration,
    pub backoff: Vec<Duration>,
    pub window: Duration,
}

impl Config {
    pub fn new(program: PathBuf, cwd: PathBuf, token: Token) -> Config {
        Config {
            program,
            args: Vec::new(),
            cwd,
            token,
            port_hint: None,
            extra_env: Vec::new(),
            ready_timeout: Duration::from_secs(10),
            stop_grace: Duration::from_secs(3),
            backoff: vec![Duration::from_millis(500), Duration::from_secs(1), Duration::from_secs(2)],
            window: Duration::from_secs(60),
        }
    }

    fn spec(&self, port: u16) -> SidecarSpec {
        let mut args = self.args.clone();
        args.extend(["serve", "--http", "--host", "127.0.0.1", "--ready-line", "--exit-when-stdin-closes", "--port"].map(String::from));
        args.push(port.to_string());
        args.push("--cwd".to_owned());
        args.push(self.cwd.to_string_lossy().into_owned());
        let mut env = vec![("NAVVIED_SERVE_TOKEN".to_owned(), self.token.expose().to_owned()), ("NAVVIED_NO_UPDATE".to_owned(), "1".to_owned())];
        env.extend(self.extra_env.clone());
        SidecarSpec { program: self.program.clone(), args, env, cwd: self.cwd.clone() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartFailure {
    /// The program file is not there.
    EngineMissing,
    /// The system or other software stopped it from starting, or it ended at once.
    Blocked { exit_code: Option<i32> },
    /// It started but did not answer in time.
    NoAnswer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Starting,
    Running { port: u16, info: Info, recovered: bool },
    Crashed { attempt: u32, restart_in: Duration },
    GaveUp { crashes: u32 },
    CannotStart(StartFailure),
    Stopped,
}

enum Cmd {
    Stop,
    Restart(PathBuf),
    TryAgain,
}

pub struct Supervisor {
    tx: Sender<Cmd>,
    join: Option<JoinHandle<()>>,
    port: Arc<AtomicU16>,
}

struct Running {
    process: Box<dyn Process>,
    lines: Receiver<String>,
}

enum Interrupt {
    Stop,
    Restart(PathBuf),
}

struct Worker {
    cfg: Config,
    spawner: Arc<dyn Spawner>,
    clock: Arc<dyn Clock>,
    logger: Arc<Logger>,
    on_event: Box<dyn Fn(Event) + Send>,
    rx: Receiver<Cmd>,
    port: Arc<AtomicU16>,
    queued: VecDeque<Cmd>,
    recovering: bool,
}

impl Supervisor {
    pub fn start(cfg: Config, spawner: Arc<dyn Spawner>, clock: Arc<dyn Clock>, logger: Arc<Logger>, on_event: Box<dyn Fn(Event) + Send>) -> Supervisor {
        let (tx, rx) = mpsc::channel();
        let port = Arc::new(AtomicU16::new(0));
        let mut worker = Worker { cfg, spawner, clock, logger, on_event, rx, port: port.clone(), queued: VecDeque::new(), recovering: false };
        let join = thread::Builder::new().name("navvied-supervisor".into()).spawn(move || worker.run()).ok();
        Supervisor { tx, join, port }
    }

    /// The port of the running program, if one runs.
    pub fn port(&self) -> Option<u16> {
        Some(self.port.load(Ordering::SeqCst)).filter(|p| *p > 0)
    }

    /// Switches the project folder: the program ends and starts again there. Not counted as a crash.
    pub fn restart_in(&self, cwd: PathBuf) {
        let _ = self.tx.send(Cmd::Restart(cwd));
    }

    /// After "cannot start" or "keeps stopping": forget what went wrong and start again.
    pub fn try_again(&self) {
        let _ = self.tx.send(Cmd::TryAgain);
    }

    /// Ends the program and everything it started, then returns.
    pub fn stop(mut self) {
        self.shut();
    }

    fn shut(&mut self) {
        let _ = self.tx.send(Cmd::Stop);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shut();
    }
}

impl Worker {
    fn emit(&self, e: Event) {
        (self.on_event)(e);
    }

    fn next_cmd(&mut self) -> Option<Cmd> {
        self.queued.pop_front().or_else(|| self.rx.try_recv().ok())
    }

    fn run(&mut self) {
        let mut crashes: VecDeque<Duration> = VecDeque::new();
        let mut recovered = false;
        let mut hint = self.cfg.port_hint;
        'outer: loop {
            self.emit(Event::Starting);
            self.recovering = recovered;
            let started = self.start_child(&mut hint);
            let mut running = match started {
                Ok(r) => r,
                Err(Err(Interrupt::Stop)) => break,
                Err(Err(Interrupt::Restart(cwd))) => {
                    self.cfg.cwd = cwd;
                    continue;
                }
                Err(Ok(failure)) => {
                    if recovered {
                        match self.after_crash(&mut crashes) {
                            Next::Again => continue,
                            Next::Stop => break,
                            Next::Restart(cwd) => {
                                self.cfg.cwd = cwd;
                                recovered = false;
                                continue;
                            }
                        }
                    }
                    self.emit(Event::CannotStart(failure));
                    match self.idle() {
                        Idle::TryAgain => continue,
                        Idle::Stop => break,
                        Idle::Restart(cwd) => {
                            self.cfg.cwd = cwd;
                            continue;
                        }
                    }
                }
            };
            let port = self.port.load(Ordering::SeqCst);
            hint = Some(port);
            loop {
                if let Some(cmd) = self.next_cmd() {
                    match cmd {
                        Cmd::Stop => {
                            self.shutdown(&mut running);
                            break 'outer;
                        }
                        Cmd::Restart(cwd) => {
                            self.shutdown(&mut running);
                            self.cfg.cwd = cwd;
                            recovered = false;
                            continue 'outer;
                        }
                        Cmd::TryAgain => {}
                    }
                }
                match running.process.try_wait() {
                    Ok(None) => thread::sleep(POLL),
                    Ok(Some(code)) => {
                        self.logger.log("app", &format!("the program ended (exit code {})", code.map_or("none".to_owned(), |c| c.to_string())));
                        running.process.kill_tree();
                        self.port.store(0, Ordering::SeqCst);
                        recovered = true;
                        match self.after_crash(&mut crashes) {
                            Next::Again => continue 'outer,
                            Next::Stop => break 'outer,
                            Next::Restart(cwd) => {
                                self.cfg.cwd = cwd;
                                recovered = false;
                                continue 'outer;
                            }
                        }
                    }
                    Err(e) => {
                        self.logger.log("app", &format!("could not check the program: {e}"));
                        thread::sleep(POLL);
                    }
                }
            }
        }
        self.port.store(0, Ordering::SeqCst);
        self.emit(Event::Stopped);
    }

    /// Counts the crash, then either waits and starts again or gives up.
    fn after_crash(&mut self, crashes: &mut VecDeque<Duration>) -> Next {
        let now = self.clock.now();
        crashes.push_back(now);
        while crashes.front().is_some_and(|t| now.saturating_sub(*t) > self.cfg.window) {
            crashes.pop_front();
        }
        let attempt = crashes.len() as u32;
        if attempt as usize >= self.cfg.backoff.len().max(1) {
            self.emit(Event::GaveUp { crashes: attempt });
            crashes.clear();
            return match self.idle() {
                Idle::TryAgain => Next::Again,
                Idle::Stop => Next::Stop,
                Idle::Restart(cwd) => Next::Restart(cwd),
            };
        }
        let pause = self.cfg.backoff[attempt as usize - 1];
        self.emit(Event::Crashed { attempt, restart_in: pause });
        let end = self.clock.now() + pause;
        while self.clock.now() < end {
            match self.next_cmd() {
                Some(Cmd::Stop) => return Next::Stop,
                Some(Cmd::Restart(cwd)) => return Next::Restart(cwd),
                Some(Cmd::TryAgain) | None => {}
            }
            self.clock.sleep(POLL.min(end.saturating_sub(self.clock.now())));
        }
        Next::Again
    }

    /// Waits for the person (or the app) to decide after the program could not be started or kept running.
    fn idle(&mut self) -> Idle {
        loop {
            match self.queued.pop_front() {
                Some(Cmd::Stop) => return Idle::Stop,
                Some(Cmd::TryAgain) => return Idle::TryAgain,
                Some(Cmd::Restart(cwd)) => return Idle::Restart(cwd),
                None => {}
            }
            match self.rx.recv_timeout(Duration::from_millis(200)) {
                Ok(c) => self.queued.push_back(c),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Idle::Stop,
            }
        }
    }

    /// The outer `Err(Ok(..))` is a start that failed; `Err(Err(..))` is a command that arrived meanwhile.
    fn start_child(&mut self, hint: &mut Option<u16>) -> Result<Running, Result<StartFailure, Interrupt>> {
        let mut attempts = hint.filter(|p| *p > 0).into_iter().map(Some).collect::<Vec<_>>();
        attempts.push(None);
        let mut last = StartFailure::NoAnswer;
        for want in attempts {
            match self.start_on(want.unwrap_or(0)) {
                Ok(r) => return Ok(r),
                Err(Err(i)) => return Err(Err(i)),
                Err(Ok(f)) => {
                    last = f;
                    if want.is_some() {
                        self.logger.log("app", "the usual port could not be used, trying another");
                        *hint = None;
                    }
                }
            }
        }
        Err(Ok(last))
    }

    fn start_on(&mut self, port: u16) -> Result<Running, Result<StartFailure, Interrupt>> {
        let spec = self.cfg.spec(port);
        let mut process = match self.spawner.spawn(&spec) {
            Ok(p) => p,
            Err(e) => {
                self.logger.log("app", &format!("could not start the program: {e}"));
                return Err(Ok(if e.kind() == io::ErrorKind::NotFound { StartFailure::EngineMissing } else { StartFailure::Blocked { exit_code: None } }));
            }
        };
        let lines = process.take_lines();
        let deadline = Instant::now() + self.cfg.ready_timeout;
        let mut running = Running { process, lines };
        let ready = loop {
            if let Some(cmd) = self.next_cmd() {
                match cmd {
                    Cmd::Stop => {
                        self.shutdown(&mut running);
                        return Err(Err(Interrupt::Stop));
                    }
                    Cmd::Restart(cwd) => {
                        self.shutdown(&mut running);
                        return Err(Err(Interrupt::Restart(cwd)));
                    }
                    Cmd::TryAgain => {}
                }
            }
            if let Some(p) = running.lines.recv_timeout(POLL).ok().and_then(|line| parse_ready(&line)) {
                break p;
            }
            if let Ok(Some(code)) = running.process.try_wait() {
                running.process.kill_tree();
                return Err(Ok(StartFailure::Blocked { exit_code: code }));
            }
            if Instant::now() >= deadline {
                running.process.kill_tree();
                return Err(Ok(StartFailure::NoAnswer));
            }
        };
        match probe_info(ready, self.cfg.token.expose(), Duration::from_secs(3)) {
            Ok(info) => {
                self.port.store(ready, Ordering::SeqCst);
                self.emit(Event::Running { port: ready, info, recovered: self.recovering });
                Ok(running)
            }
            Err(e) => {
                self.logger.log("app", &format!("the program did not answer: {e}"));
                running.process.kill_tree();
                Err(Ok(StartFailure::NoAnswer))
            }
        }
    }

    /// Close the input, give it a moment to end by itself, then end it and everything it started.
    fn shutdown(&mut self, running: &mut Running) {
        running.process.close_stdin();
        let end = Instant::now() + self.cfg.stop_grace;
        while Instant::now() < end && !matches!(running.process.try_wait(), Ok(Some(_))) {
            thread::sleep(Duration::from_millis(20));
        }
        running.process.kill_tree();
        self.port.store(0, Ordering::SeqCst);
    }
}

enum Next {
    Again,
    Stop,
    Restart(PathBuf),
}

enum Idle {
    TryAgain,
    Stop,
    Restart(PathBuf),
}

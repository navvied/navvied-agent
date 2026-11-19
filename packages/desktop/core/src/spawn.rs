//! Starting the program as a child process. Behind two small traits so the supervisor can be tested without one.

use crate::logs::Logger;
use crate::tree::Tree;
use std::io::{self, BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

/// Not `Debug`: `env` carries the key in the clear (`NAVVIED_SERVE_TOKEN`), and a derived `Debug` would print it
/// wherever this is ever logged or asserted on, bypassing `Token`'s own protection against exactly that.
#[derive(Clone)]
pub struct SidecarSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
}

pub trait Process: Send {
    fn pid(&self) -> u32;
    /// Lines the program writes to its error stream. Taken once.
    fn take_lines(&mut self) -> Receiver<String>;
    /// `Some(code)` once it has ended (`None` inside when a signal ended it).
    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>>;
    /// Closing the input is the polite way to say "stop": the program ends when it sees the end.
    fn close_stdin(&mut self);
    fn kill_tree(&mut self);
}

pub trait Spawner: Send + Sync {
    fn spawn(&self, spec: &SidecarSpec) -> io::Result<Box<dyn Process>>;
}

pub struct OsSpawner {
    pub logger: Arc<Logger>,
}

struct OsProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Option<Receiver<String>>,
    tree: Tree,
    /// Reading the child's stdout and stderr to the log, each on its own thread. `kill_tree` joins both before
    /// returning: without that, a line already read but not yet logged could still land in the file after the
    /// caller believes the program — and its output — are gone, which is exactly the moment a test or the app
    /// itself might read that file and get an inconsistent, in-flight view of it.
    pumps: Vec<JoinHandle<()>>,
}

fn pump(source: &'static str, stream: impl io::Read + Send + 'static, logger: Arc<Logger>, forward: Option<mpsc::Sender<String>>) -> JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            logger.log(source, &line);
            if let Some(tx) = &forward {
                let _ = tx.send(line);
            }
        }
    })
}

impl Spawner for OsSpawner {
    fn spawn(&self, spec: &SidecarSpec) -> io::Result<Box<dyn Process>> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args).envs(spec.env.iter().map(|(k, v)| (k, v))).current_dir(&spec.cwd);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        Tree::prepare(&mut cmd);
        let mut child = cmd.spawn()?;
        let tree = Tree::adopt(&child);
        let (tx, rx) = mpsc::channel();
        let mut pumps = Vec::with_capacity(2);
        if let Some(out) = child.stdout.take() {
            pumps.push(pump("engine out", out, self.logger.clone(), None));
        }
        if let Some(err) = child.stderr.take() {
            pumps.push(pump("engine", err, self.logger.clone(), Some(tx)));
        }
        let stdin = child.stdin.take();
        Ok(Box::new(OsProcess { child, stdin, lines: Some(rx), tree, pumps }))
    }
}

impl Process for OsProcess {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn take_lines(&mut self) -> Receiver<String> {
        self.lines.take().unwrap_or_else(|| mpsc::channel().1)
    }

    fn try_wait(&mut self) -> io::Result<Option<Option<i32>>> {
        Ok(self.child.try_wait()?.map(|s| s.code()))
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    fn kill_tree(&mut self) {
        self.tree.kill(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
        // The pipes are closed now (the process and everything it started are gone), so each pump thread is at
        // most one buffered line away from its own EOF: this does not hang.
        for pump in self.pumps.drain(..) {
            let _ = pump.join();
        }
    }
}

impl Drop for OsProcess {
    fn drop(&mut self) {
        self.kill_tree();
    }
}

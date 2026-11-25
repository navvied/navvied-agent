import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { inTerminal, killTree, processStart, usesProcessGroups } from "./platform.ts";
import { sweep, track } from "./orphans.ts";
import { spawnPty } from "./pty.ts";
import { releaseChild, withGuardStdio } from "./sandbox/handshake.ts";
import { Redactor } from "./redact.ts";
import { QUIET_ENV, cleanOutput } from "./tools/util.ts";

export type JobStatus = "running" | "done" | "failed" | "stopped";

export interface JobView { id: string; title: string; status: JobStatus; code: number | null; startedAt: number }

const KEEP = 400_000;
/** How many commands may be kept: finished ones are forgotten, oldest first, to make room; running ones are never. */
export const MOST_JOBS = 16;
/** How many times one job may wake the model by printing what it was asked to watch for. */
export const MOST_HITS = 3;
/** How long a program asked to quit has before it is forced. */
const QUIT_MS = 3000;
/** After a stop, how long a job's end is waited for. Something it started that got away can hold its output open long after. */
const STOP_GRACE_MS = 1500;
/** How often a job's output file is read, and how often a job taken back after a restart is looked at. */
const PUMP_MS = 100, WATCH_MS = 1000;
/** Records and output of jobs older than this are removed from the state folder. */
const FORGET_AFTER_MS = 3 * 24 * 3_600_000;
const alive = new Set<Jobs>();
/** Commands of a Jobs that was closed, until they have really exited. */
const dying = new Set<Promise<void>>();
let guarded = false;

/** A program that dies must not leave servers running behind it. */
function guard(): void {
  if (guarded) return;
  guarded = true;
  process.on("exit", () => { for (const jobs of alive) jobs.stopAll(); });
  // Being stopped (a closed terminal, a service stop) must not leave servers running either: `exit` does not run for these.
  for (const [name, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) process.once(name, () => { for (const jobs of alive) jobs.stopAll(); process.exit(code); });
}

/** What a started program can be asked and told, whether it is a child with pipes, one in a terminal, or one found again after a restart. */
interface Proc { pid: number | undefined; quit(): void; kill(): void; write?(text: string): boolean; end?(): boolean }

interface Job extends JobView {
  /** Settles when the program has really exited and let go of its folder (not when the job was only marked as ended). */ gone: Promise<void>;
  /** Settles when its end has been reported (the `job` event with its final status), which comes after the exit once its output has closed. */ reported: Promise<void>;
  report: () => void; /** Someone may type to it (BashInput). */ interactive: boolean; proc: Proc; output: string; dropped: number; read: number; ended: boolean;
  /** The model has been told it ended (by reading it, or by the line that says so). */ told: boolean; endedAt?: number;
  /** Makes what it prints safe as it arrives: what is kept here has no secret in it. */ safe: Redactor;
  /** Whether its end (and what it was asked to watch for) wakes the model. */ wake: boolean;
  /** The text a line of its output is waited for to have (lower case), how many times that woke the model, the line not yet told, and the unfinished line. */ watch?: string; hits: number; hit?: string; partial: string;
  /** Where its whole output is, how far that has been read, and what finishes a character cut between two reads. */ file?: string; fd?: number; offset: number; decoder: TextDecoder; timer?: ReturnType<typeof setInterval>;
  /** Reads of it that found nothing new, one after another. */ idle: number;
}

/** What a restart needs to find a job again. */
interface Saved { id: string; session: string; title: string; argv: string[]; pid: number; start: string; startedAt: number; file: string; wake: boolean; watch?: string; hits: number }

export interface JobsOptions {
  /** Where each job's whole output and the record that lets a restart find it again are kept. Without it a private folder of temporary files is used and nothing is taken back. */
  dir?: string;
  /** The conversation the jobs belong to: a record is only taken back by the conversation that made it. */
  session?: string;
  /** The environment a command starts with (without the keys of the program itself). */
  env?: () => NodeJS.ProcessEnv;
  /** A job ended, or printed what it was asked to watch for. */
  onNews?: () => void;
  /** Whether that news starts a turn by itself (the host says so): what the model is told about waiting depends on it. */
  wake?: boolean;
  /** When a process started (see `processStart`). */
  startOf?: (pid: number) => string | undefined;
}

/** What the model is told about a job: the news of it. */
export interface News { id: string; status: JobStatus; code: number | null; ms: number; wake: boolean; ended: boolean; /** The line it printed that was watched for. */ hit?: string; /** That wake was the last one this job may cause. */ lastHit?: boolean; title: string }

/** Commands that keep running after the turn that started them, such as a development server. */
export class Jobs {
  readonly #jobs = new Map<string, Job>();
  #next = 1;
  #folder: string | undefined;

  constructor(private readonly emit: (e: EngineEvent) => void, readonly now: () => number = Date.now, private readonly o: JobsOptions = {}) {
    alive.add(this);
    guard();
  }

  /** Whether the news of a job starts a turn by itself. */
  get wakes(): boolean { return this.o.wake === true; }

  #dir(): string {
    if (!this.#folder) { this.#folder = this.o.dir ?? mkdtempSync(join(tmpdir(), "navvied-jobs-")); mkdirSync(this.#folder, { recursive: true, mode: 0o700 }); }
    return this.#folder;
  }
  #path = (id: string, ext: string): string => join(this.#dir(), `${this.o.session ?? "x"}-${id}.${ext}`);
  #env = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...(this.o.env?.() ?? process.env), ...QUIET_ENV, ...extra });

  /**
   * `interactive`: its input stays open, for BashInput to type to, and it runs in a terminal of its own where the system has one. Otherwise nobody can type to it, it sees the
   * end of its input at once, and its output goes to a file, so that it does not stop when this program does.
   * `notify`: text that, when a line of its output has it, wakes the model; "off" for a job that must not wake it at all.
   * `guarded`: it is confined with a guard that waits to be released (`Launch.guarded`).
   */
  start(argv: string[], cwd: string, title: string, env?: NodeJS.ProcessEnv, interactive = false, notify?: string, guarded = false): JobView {
    const id = `job${this.#next++}`;
    const job = this.#make(id, title, interactive, "", false, notify);
    if (interactive) {
      let exited = (): void => {};
      job.gone = new Promise<void>((resolve) => { exited = resolve; });
      const pty = spawnPty(argv, { cwd, env: this.#env({ ...env, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" }), onData: (text) => this.#feed(job, text), onExit: (code) => { exited(); this.#end(job, code); }, guarded });
      if (pty) job.proc = { pid: pty.pid, quit: () => pty.kill("SIGTERM"), kill: () => pty.kill("SIGKILL"), write: (t) => pty.write(t), end: () => pty.write("\x04") };
      else { exited(); this.#spawnPiped(job, (guarded ? undefined : inTerminal(argv)) ?? argv, cwd, env, guarded); }
      void job.gone.then(this.track(job.proc.pid));
    } else this.#spawnToFile(job, argv, cwd, env);
    return this.#announce(job);
  }

  /** Writes down a confined command that must end with this program, so that the next start ends it if this one is killed before it can (see `orphans.ts`). Returns the call that forgets it. */
  track(pid: number | undefined): () => void { return track(this.#dir(), pid, this.o.startOf); }

  /** Takes over a command that is already running, as one that ran out of its time in the foreground: `printed` is what it has said so far, all of it already shown to the model. */
  adopt(child: ChildProcess, title: string, printed: string): JobView {
    const job = this.#make(`job${this.#next++}`, title, false, printed, true);
    this.#attach(job, child);
    return this.#announce(job);
  }

  #make(id: string, title: string, interactive: boolean, printed: string, shown: boolean, notify?: string): Job {
    const safe = new Redactor();
    const first = printed ? safe.push(printed) + safe.end() : "";
    let report = (): void => {};
    const reported = new Promise<void>((resolve) => { report = resolve; });
    const job: Job = { gone: Promise.resolve(), reported, report, id, title, interactive, status: "running", code: null, startedAt: this.now(), proc: { pid: undefined, quit() {}, kill() {} }, output: first, dropped: 0, read: shown ? first.length : 0, ended: false, told: false, safe, wake: notify !== "off", ...(notify && notify !== "off" ? { watch: notify.toLowerCase() } : {}), hits: 0, partial: "", offset: 0, decoder: new TextDecoder(), idle: 0 };
    this.#jobs.set(id, job);
    return job;
  }

  #announce(job: Job): JobView {
    this.emit({ ev: "job", id: job.id, title: job.title, status: "running", startedAt: job.startedAt });
    return view(job);
  }

  /** A child whose output goes straight into a file: the file is read as it grows, and the child does not depend on this program to keep running. */
  #spawnToFile(job: Job, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
    const [cmd, ...args] = argv;
    job.file = this.#path(job.id, "log");
    const out = openSync(job.file, "w", 0o600);
    let child: ChildProcess;
    try { child = spawn(cmd ?? "", args, { cwd, env: this.#env(env), detached: usesProcessGroups(), windowsHide: true, stdio: ["ignore", out, out] }); } finally { closeSync(out); }
    job.fd = openSync(job.file, "r");
    job.timer = setInterval(() => this.#pump(job), PUMP_MS);
    job.timer.unref?.();
    this.#attach(job, child);
    const start = child.pid !== undefined ? (this.o.startOf ?? processStart)(child.pid) : undefined;
    if (child.pid !== undefined && start !== undefined && this.o.session && this.o.dir) this.#save(job, { pid: child.pid, start, argv });
  }

  /** Without a terminal; a guarded command keeps this form because the guard must be started by the program that releases it, not by a terminal in between. */
  #spawnPiped(job: Job, argv: string[], cwd: string, env?: NodeJS.ProcessEnv, guarded = false): void {
    const [cmd, ...args] = argv;
    const child = spawn(cmd ?? "", args, { cwd, env: this.#env(env), detached: usesProcessGroups(), windowsHide: true, stdio: withGuardStdio(["pipe", "pipe", "pipe"], guarded) });
    if (guarded) releaseChild(child);
    this.#attach(job, child);
  }

  #attach(job: Job, child: ChildProcess): void {
    job.gone = new Promise<void>((resolve) => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { child.once("exit", () => resolve()); child.once("error", () => resolve()); } });
    job.proc = {
      pid: child.pid,
      quit: () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ } },
      kill: () => killTree(child),
      ...(child.stdin ? { write: (t: string) => { try { child.stdin!.write(t); return child.stdin!.writable; } catch { return false; } }, end: () => { try { child.stdin?.end(); return true; } catch { return false; } } } : {}),
    };
    const collect = (d: Buffer): void => this.#feed(job, d.toString("utf8"));
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (e) => { this.#feed(job, `Error: ${e.message}\n`); this.#end(job, null); });
    // A job with an output file is over when the program exits; one with pipes, when the pipes close (what it left behind may still print).
    child.on(job.fd !== undefined ? "exit" : "close", (code) => this.#end(job, code));
  }

  /**
   * Jobs of an earlier run of this conversation (see `JobsOptions.dir`): one whose program still runs is taken back, without its input; one that is gone is reported as ended, with what its
   * output file holds. Nothing is started again. A process is the same one only when its start time is too, because numbers are reused.
   */
  recover(): void {
    const { dir, session } = this.o;
    if (!dir || !session) return;
    sweep(dir, this.o.startOf);
    let files: string[];
    try { files = readdirSync(dir); } catch { return; }
    for (const name of files) {
      const file = join(dir, name);
      try { if (this.now() - statSync(file).mtimeMs > FORGET_AFTER_MS) { rmSync(file, { force: true }); continue; } } catch { continue; }
      if (!name.startsWith(`${session}-`) || !name.endsWith(".json")) continue;
      let rec: Saved;
      try { rec = JSON.parse(readFileSync(file, "utf8")) as Saved; } catch { rmSync(file, { force: true }); continue; }
      if (rec.session !== session || this.#jobs.has(rec.id)) continue;
      this.#next = Math.max(this.#next, Number(rec.id.slice(3)) + 1 || this.#next);
      this.#takeBack(rec);
    }
  }

  #takeBack(rec: Saved): void {
    const job = this.#make(rec.id, rec.title, false, "", false, rec.wake ? rec.watch : "off");
    job.startedAt = rec.startedAt;
    job.hits = rec.hits;
    job.file = rec.file;
    try {
      const size = statSync(rec.file).size;
      job.offset = Math.max(0, size - KEEP);
      job.dropped = job.offset;
      job.fd = openSync(rec.file, "r");
      this.#pump(job);
    } catch { /* what it printed is lost; the job is still reported */ }
    const startOf = this.o.startOf ?? processStart;
    const still = (): boolean => { try { process.kill(rec.pid, 0); } catch { return false; } return startOf(rec.pid) === rec.start; };
    const stop = (signal: NodeJS.Signals): void => { try { process.kill(-rec.pid, signal); } catch { try { process.kill(rec.pid, signal); } catch { /* already gone */ } } };
    job.proc = { pid: rec.pid, quit: () => stop("SIGTERM"), kill: () => stop("SIGKILL") };
    this.emit({ ev: "job", id: job.id, title: job.title, status: "running", startedAt: job.startedAt });
    if (!still()) { this.#end(job, null, true); return; }
    job.timer = setInterval(() => { this.#pump(job); if (!still()) this.#end(job, null, true); }, PUMP_MS * 10);
    job.timer.unref?.();
    job.gone = new Promise<void>((resolve) => { const t = setInterval(() => { if (!still()) { clearInterval(t); resolve(); } }, WATCH_MS); t.unref?.(); });
  }

  #save(job: Job, p: { pid: number; start: string; argv: string[] }): void {
    const rec: Saved = { id: job.id, session: this.o.session!, title: job.title, argv: p.argv, pid: p.pid, start: p.start, startedAt: job.startedAt, file: job.file!, wake: job.wake, ...(job.watch ? { watch: job.watch } : {}), hits: job.hits };
    try { writeFileSync(this.#path(job.id, "json"), JSON.stringify(rec), { mode: 0o600 }); } catch { /* the job runs; it is only not taken back */ }
  }

  #forget(job: Job): void { if (this.o.dir && this.o.session) try { unlinkSync(this.#path(job.id, "json")); } catch { /* there was none */ } }

  /** Reads what the program wrote to its output file since the last time. */
  #pump(job: Job, final = false): void {
    if (job.fd === undefined) return;
    try {
      for (let round = 0; round < 16; round++) {
        const size = fstatSync(job.fd).size;
        if (size <= job.offset) break;
        const buf = Buffer.allocUnsafe(Math.min(size - job.offset, 1 << 20));
        const n = readSync(job.fd, buf, 0, buf.length, job.offset);
        if (n <= 0) break;
        job.offset += n;
        this.#feed(job, job.decoder.decode(buf.subarray(0, n), { stream: true }));
      }
      if (final) this.#feed(job, job.decoder.decode());
    } catch { /* the file is gone: nothing more to read */ }
  }

  #feed(job: Job, raw: string): void { this.#append(job, job.safe.push(raw)); }

  #append(job: Job, text: string): void {
    job.output += text;
    if (job.output.length > KEEP) { const cut = job.output.length - KEEP; job.output = job.output.slice(cut); job.dropped += cut; }
    if (job.watch === undefined || job.hits >= MOST_HITS || job.hit !== undefined || !text) return;
    const lines = (job.partial + text).split("\n");
    job.partial = (lines.pop() ?? "").slice(-1000);
    const line = lines.find((l) => cleanOutput(l).toLowerCase().includes(job.watch!));
    if (line !== undefined) { job.hit = cleanOutput(line).trim().slice(0, 200); job.hits++; this.o.onNews?.(); }
  }

  /**
   * Whether another command can be started. Finished ones are forgotten, the oldest first, to make room; when all are running there
   * is none, and the answer is a sentence saying how to make some.
   */
  room(): string | undefined {
    for (const [id, job] of this.#jobs) { if (this.#jobs.size < MOST_JOBS) break; if (job.status !== "running") this.#jobs.delete(id); }
    if (this.#jobs.size < MOST_JOBS) return undefined;
    const oldest = [...this.#jobs.values()][0]!;
    return `Error: ${MOST_JOBS} commands are already running in the background. Stop one with KillShell first (${oldest.id}, the oldest, is "${oldest.title.slice(0, 60)}"): KillShell {"job_id": "${oldest.id}"}. Then start this again.`;
  }

  /** What the model has not heard yet: the commands that ended, and the lines that were watched for. Reading a job is hearing of it; so is `told`, once the news is sent. */
  news(): News[] {
    return [...this.#jobs.values()].filter((j) => (j.ended && !j.told) || j.hit !== undefined).map((j) => ({ id: j.id, title: j.title, status: j.status, code: j.code, ms: (j.endedAt ?? this.now()) - j.startedAt, wake: j.wake, ended: j.ended && !j.told, ...(j.hit !== undefined ? { hit: j.hit, lastHit: j.hits >= MOST_HITS } : {}) }));
  }

  told(ids: readonly string[]): void { for (const id of ids) { const job = this.#jobs.get(id); if (job) { if (job.ended) job.told = true; job.hit = undefined; } } }

  /** The last lines a job printed, however much has been read: for a note that says it ended. */
  tail(id: string, lines = 20, chars = 1500): string {
    const job = this.#jobs.get(id);
    return job ? cleanOutput(job.output).trimEnd().split("\n").slice(-lines).join("\n").slice(-chars) : "";
  }

  list(): JobView[] { return [...this.#jobs.values()].map(view); }

  get running(): number { return [...this.#jobs.values()].filter((j) => j.status === "running").length; }

  /** How many running jobs can be typed to. */
  get typable(): number { return [...this.#jobs.values()].filter((j) => j.status === "running" && j.interactive && j.proc.write).length; }

  /** Types to a job. `false` when it is not one that can be typed to, or has ended. */
  type(id: string, text: string): boolean {
    const job = this.#jobs.get(id);
    return !!job && job.interactive && job.status === "running" && job.proc.write?.(text) === true;
  }

  /** Ends a job's input, as Ctrl-D does. */
  endInput(id: string): boolean {
    const job = this.#jobs.get(id);
    return !!job && job.interactive && job.status === "running" && job.proc.end?.() === true;
  }

  /**
   * What the job printed since it was last read, and how it is doing. `patient`: the caller waited for it, so finding nothing is no sign of asking again and again; `nudge` is
   * true on the second read in a row that found nothing new and did not wait.
   */
  read(id: string, patient = false): { view: JobView; output: string; skipped: number; ports: number[]; file?: string; wakes: boolean; nudge: boolean } | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    this.#pump(job);
    if (job.ended) job.told = true;
    job.hit = undefined;
    const from = Math.max(0, job.read - job.dropped);
    const skipped = Math.max(0, job.dropped - job.read);
    const output = job.output.slice(from);
    job.read = job.dropped + job.output.length;
    job.idle = patient || output || job.status !== "running" ? 0 : job.idle + 1;
    return { view: view(job), output, skipped, ports: job.status === "running" ? portsIn(job.output) : [], ...(job.file ? { file: job.file } : {}), wakes: job.wake && this.o.wake === true, nudge: job.idle === 2 };
  }

  /**
   * Waits until the job has printed something new or has ended, for at most `ms`, or until `signal` aborts. With `until`, it waits
   * for that text to be in what the job printed (any case) instead of for anything new.
   */
  async waitFor(id: string, ms: number, signal: AbortSignal, until?: string): Promise<void> {
    const job = this.#jobs.get(id);
    if (!job) return;
    const end = this.now() + ms, needle = until?.toLowerCase();
    const waiting = (): boolean => (needle === undefined ? job.dropped + job.output.length === job.read : !job.output.toLowerCase().includes(needle));
    while (job.status === "running" && waiting() && this.now() < end && !signal.aborted) await new Promise((r) => setTimeout(r, 100));
  }

  /** Stops a job and everything it started. `gently`: it is asked to quit first and has a few seconds before it is forced (not on Windows, which has no such request for a program running without a window). */
  stop(id: string, gently = false): JobView | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    this.#halt(job, gently);
    return view(job);
  }

  stopAll(): void { for (const job of this.#jobs.values()) this.#halt(job); }

  close(): void {
    this.stopAll();
    alive.delete(this);
    const gone = this.stopped(10_000);
    dying.add(gone);
    void gone.finally(() => dying.delete(gone));
  }

  /**
   * Resolves when every command has really exited and its end has been reported, or after `most` ms. A folder cannot be removed on Windows while a program that was
   * started in it still runs, so whoever removes a folder after `close()` waits for this first.
   */
  async stopped(most = 5_000): Promise<void> {
    const all = Promise.all([...this.#jobs.values()].map((j) => j.gone.then(() => j.reported)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((r) => { timer = setTimeout(r, most); })]);
    clearTimeout(timer);
  }

  #halt(job: Job, gently = false): void {
    if (job.status !== "running") return;
    job.status = "stopped";
    // The person stopped it: a restart must not take it back.
    this.#forget(job);
    const ask = gently && usesProcessGroups() && job.proc.pid !== undefined;
    if (ask) job.proc.quit(); else job.proc.kill();
    const force = (): void => { if (!job.ended) job.proc.kill(); setTimeout(() => this.#end(job, null), STOP_GRACE_MS).unref(); };
    if (ask) setTimeout(force, QUIT_MS).unref(); else force();
  }

  /** `unknown`: it ended while this program was not looking, so how it ended is not known. */
  #end(job: Job, code: number | null, unknown = false): void {
    if (job.ended) return;
    job.ended = true;
    job.endedAt = this.now();
    clearInterval(job.timer);
    this.#pump(job, true);
    if (job.status === "running") job.status = unknown || code === 0 ? "done" : "failed";
    job.code = code;
    this.#append(job, job.safe.end());
    if (job.partial && job.watch !== undefined && job.hits < MOST_HITS && job.hit === undefined) this.#append(job, "\n");
    if (job.fd !== undefined) { try { closeSync(job.fd); } catch { /* closed */ } job.fd = undefined; }
    this.#forget(job);
    const last = lastLine(job.output);
    this.emit({ ev: "job", id: job.id, title: job.title, status: job.status, startedAt: job.startedAt, ...(code !== null ? { code } : {}), ...(last ? { last } : {}) });
    job.report();
    this.o.onNews?.();
  }
}

/**
 * Stops every command of every Jobs there is and waits until they have exited. A program that shuts down does this; so does a test
 * that is about to remove the folders its commands ran in (Windows will not remove a folder a running program has open).
 */
export async function stopAllJobs(): Promise<void> {
  const open = [...alive];
  for (const jobs of open) jobs.stopAll();
  await Promise.all([...open.map((j) => j.stopped()), ...dying]);
}

const view = (j: Job): JobView => ({ id: j.id, title: j.title, status: j.status, code: j.code, startedAt: j.startedAt });

/** The ports a program says it listens on (`localhost:3000`, `http://0.0.0.0:8080`, `listening on port 5173`), without repeats. */
export function portsIn(output: string): number[] {
  const found = new Set<number>();
  for (const m of output.matchAll(/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\*):(\d{2,5})\b|\bports?\s+(\d{2,5})\b/gi)) {
    const port = Number(m[1] ?? m[2]);
    if (port > 0 && port <= 65535) found.add(port);
  }
  return [...found].slice(0, 5);
}

const lastLine = (output: string): string => (output.trimEnd().split(/\r?\n/).pop() ?? "").slice(0, 200);

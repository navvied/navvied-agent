import { execFile, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Looking at the person's programs from inside the sandbox. The kernel lets a process look into another only from the same user namespace, and
 * the sandbox's is its own: whatever the system's `/proc` is mounted with, `ps`, `pgrep`, `ss -p` and `lsof` inside it see only what the command
 * started, so a program the person already runs (a server holding a port) looks absent. Nothing a mount or a user-id map can do changes that
 * (measured: a bind of the host's `/proc`, a fresh one, a one-to-one map of the person's own ids).
 *
 * So these few programs are answered from outside: `bin/<name>` in a folder of the sandbox's temporary space are shims that hand the call to this
 * engine through a pipe, and the engine runs the real program with the person's own rights and gives back what it printed. It only looks:
 * the programs are fixed, and the options that write, read a named file, kill or show another program's environment are refused. What the
 * command can write is the same as without it.
 */
const SHIMS = ["ps", "pgrep", "pidof", "pkill", "killall", "ss", "lsof", "fuser"] as const;
const REAL: ReadonlySet<string> = new Set(["ps", "pgrep", "pidof", "ss", "lsof", "fuser"]);
const LIMIT = 1_000_000;
const SECONDS = 15;

/** Why a call is not run, in words for the model, or nothing when it is. */
export function refused(program: string, args: readonly string[]): string | undefined {
  if (!REAL.has(program)) return `${program} is not available here`;
  if (args.length > 100 || args.some((a) => a.length > 4096 || a.includes("\0"))) return "too many or too long arguments";
  const letters = args.filter((a) => /^-[^-]/.test(a)).map((a) => a.slice(1));
  const longs = args.filter((a) => a.startsWith("--"));
  if (program === "ss" && (letters.some((l) => /[KDF]/.test(l.replace(/\w=.*/, ""))) || longs.some((l) => /^--(kill|diag|filter)/.test(l)))) return "ss may only look: -K, -D and -F are not available";
  if (program === "lsof" && (letters.some((l) => /[kmD]/.test(l.split("=")[0]!)) || args.some((a) => /^\+[mDe]/.test(a)))) return "lsof may only look: -k, -m and -D are not available";
  if (program === "fuser" && (letters.some((l) => /[kKi]/.test(l)) || longs.some((l) => /^--(kill|interactive)/.test(l)))) return "fuser may only look: -k and -i are not available; stop a program with kill and its number";
  // `ps e` and `ps eww` print the environment of every program, which holds keys; `ps -e` (every program) is another thing.
  if (program === "ps" && args[0] !== undefined && /^[a-zA-Z]+$/.test(args[0]) && args[0].includes("e")) return "ps cannot show the environment of programs; use ps -e (or ps aux) to list them";
  return undefined;
}

const realProgram = (name: string, skip: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === skip) continue;
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch { /* next folder */ }
  }
  return undefined;
};

/** The one script that stands for every program: it sends the call, waits at most `SECONDS` for the answer, and prints it as the program would. */
const SCRIPT = `#!/bin/sh
p=\${0##*/}
d=\${NAVVIED_LOOK:-}
real() { PATH=\${PATH#*:}; exec "$p" "$@"; }
[ -p "$d/ask" ] || real "$@"
# ask NAME ARGS...: runs the program named in the engine, prints its output, and returns its status (99: the engine did not answer).
ask() {
  i=$$
  mkfifo "$d/r.$i" 2>/dev/null || return 99
  exec 3<>"$d/r.$i"
  printf '%s\\0' "$$" "$@" > "$d/q.$i"
  echo "$i" > "$d/ask"
  timeout ${SECONDS} head -c1 <&3 >/dev/null
  r=$?
  exec 3<&-
  if [ $r -eq 0 ] && [ -f "$d/e.$i" ]; then cat "$d/o.$i"; cat "$d/x.$i" >&2; s=$(cat "$d/e.$i"); else s=99; fi
  rm -f "$d/r.$i" "$d/q.$i" "$d/o.$i" "$d/x.$i" "$d/e.$i"
  return "$s"
}
case $p in
  pkill|killall)
    sig=TERM; keep=
    n=$#
    while [ $n -gt 0 ]; do
      a=$1; shift; n=$((n - 1))
      case $a in
        -[0-9]*|-SIG*|-HUP|-INT|-QUIT|-ABRT|-KILL|-TERM|-USR1|-USR2|-STOP|-CONT|-ALRM|-PIPE) sig=\${a#-} ;;
        --signal) sig=$1; shift; n=$((n - 1)) ;;
        --signal=*) sig=\${a#--signal=} ;;
        -s) if [ $p = killall ]; then sig=$1; shift; n=$((n - 1)); else set -- "$@" "$a"; fi ;;
        *) set -- "$@" "$a" ;;
      esac
    done
    [ $p = killall ] && set -- -x "$@"
    # Not in a substitution: that would be a second process with the pattern in its command line, and it would be found.
    ask pgrep "$@" > "$d/p.$$"; s=$?
    out=$(cat "$d/p.$$"); rm -f "$d/p.$$"
    [ $s -eq 99 ] && { echo "$p: the programs of this computer cannot be looked at from here" >&2; exit 2; }
    [ -n "$out" ] || exit 1
    kill -"\${sig#SIG}" $out; exit $?
    ;;
esac
ask "$p" "$@"; s=$?
[ $s -eq 99 ] && real "$@"
exit $s
`;

const live = new Set<Lookout>();
process.once("exit", () => { for (const l of live) l.close(); });

/** The engine's half: a folder with the pipe the shims write to, and the shims. */
class Lookout {
  #dir: string | undefined;
  #fd: number | undefined;
  #failed = false;

  /** The folder to name in `NAVVIED_LOOK` and the one to put first in `PATH`, or nothing where this cannot be set up. */
  start(): { dir: string; bin: string } | undefined {
    if (this.#dir) return { dir: this.#dir, bin: join(this.#dir, "bin") };
    if (this.#failed) return undefined;
    try {
      const dir = mkdtempSync(join(tmpdir(), "navvied-look-"));
      const ask = join(dir, "ask");
      if (spawnSync("mkfifo", ["-m", "600", ask]).status !== 0) throw new Error("no mkfifo");
      mkdirSync(join(dir, "bin"));
      const shim = join(dir, "bin", ".look");
      writeFileSync(shim, SCRIPT, { mode: 0o700 });
      for (const name of SHIMS) symlinkSync(".look", join(dir, "bin", name));
      // Held open for reading and writing, so the pipe never ends when a shim closes it.
      this.#fd = openSync(ask, constants.O_RDWR);
      this.#dir = dir;
      live.add(this);
      let pending = "";
      const stream = createReadStream("", { fd: this.#fd, autoClose: false });
      stream.on("data", (chunk) => {
        pending += chunk.toString();
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) { const id = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1); if (/^[\w.]{1,64}$/.test(id)) void this.#answer(dir, id); }
      });
      stream.on("error", () => {});
      return { dir, bin: join(dir, "bin") };
    } catch {
      this.#failed = true;
      return undefined;
    }
  }

  async #answer(dir: string, id: string): Promise<void> {
    let status = 99, out = "", err = "";
    try {
      const [shim, program, ...args] = readFileSync(join(dir, `q.${id}`), "utf8").split("\0").slice(0, -1);
      const why = shim !== undefined && /^\d+$/.test(shim) && program !== undefined ? refused(program, args) : "bad request";
      const file = why ? undefined : realProgram(program!, join(dir, "bin"));
      if (why || !file) { status = 126; err = `${program}: ${why ?? "not installed"}\n`; }
      else {
        await new Promise<void>((done) => execFile(file, args, { timeout: SECONDS * 1000 - 2000, maxBuffer: LIMIT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] } as never, (e, so, se) => {
          out = String(so ?? ""); err = String(se ?? "");
          status = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0;
          done();
        }));
        // The shim itself and what it started are among the programs: they are not what was looked for.
        if (program === "pgrep" || program === "pidof") out = out.split("\n").filter((l) => l.trim().split(/\s+/)[0] !== shim).join("\n") + (out.endsWith("\n") ? "\n" : "");
        if ((program === "pgrep" || program === "pidof") && status === 0 && !out.trim()) status = 1;
      }
    } catch { status = 99; }
    try {
      writeFileSync(join(dir, `o.${id}`), out.slice(0, LIMIT));
      writeFileSync(join(dir, `x.${id}`), err.slice(0, LIMIT));
      writeFileSync(join(dir, `e.${id}`), String(status));
      const ack = await open(join(dir, `r.${id}`), constants.O_WRONLY | constants.O_NONBLOCK);
      await ack.write("x");
      await ack.close();
    } catch { /* the one who asked is gone */ }
  }

  close(): void {
    if (this.#fd !== undefined) { try { closeSync(this.#fd); } catch { /* closed */ } this.#fd = undefined; }
    if (this.#dir) { try { rmSync(this.#dir, { recursive: true, force: true }); } catch { /* gone */ } this.#dir = undefined; }
    this.#failed = false;
    live.delete(this);
  }
}

/** One for the whole program: every sandbox of it shares the pipe and the folder, so answering costs one reader however many conversations there are. */
export const lookout = new Lookout();

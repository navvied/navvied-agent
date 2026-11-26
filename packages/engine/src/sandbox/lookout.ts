import { execFile, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, createReadStream, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const SHIMS = ["ps", "pgrep", "pidof", "pkill", "killall", "ss", "lsof", "fuser"] as const;
const REAL: ReadonlySet<string> = new Set(["ps", "pgrep", "pidof", "ss", "lsof", "fuser"]);
const attempt = (f: () => void): void => { try { f(); } catch { return; } };
const LIMIT = 1_000_000;
const SECONDS = 15;

export function refused(program: string, args: readonly string[]): string | undefined {
  if (!REAL.has(program)) return `${program} is not available here`;
  if (args.length > 100 || args.some((a) => a.length > 4096 || a.includes("\0"))) return "too many or too long arguments";
  const letters = args.filter((a) => /^-[^-]/.test(a)).map((a) => a.slice(1));
  const longs = args.filter((a) => a.startsWith("--"));
  if (program === "ss" && (letters.some((l) => /[KDF]/.test(l.replace(/\w=.*/, ""))) || longs.some((l) => /^--(kill|diag|filter)/.test(l)))) return "ss may only look: -K, -D and -F are not available";
  if (program === "lsof" && (letters.some((l) => /[kmD]/.test(l.split("=")[0]!)) || args.some((a) => /^\+[mDe]/.test(a)))) return "lsof may only look: -k, -m and -D are not available";
  if (program === "fuser" && (letters.some((l) => /[kKi]/.test(l)) || longs.some((l) => /^--(kill|interactive)/.test(l)))) return "fuser may only look: -k and -i are not available; stop a program with kill and its number";
  if (program === "ps" && args[0] !== undefined && /^[a-zA-Z]+$/.test(args[0]) && args[0].includes("e")) return "ps cannot show the environment of programs; use ps -e (or ps aux) to list them";
  return undefined;
}

const realProgram = (name: string, skip: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === skip) continue;
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch { continue; }
  }
  return undefined;
};

const SCRIPT = `#!/bin/sh
p=\${0##*/}
d=\${NAVVIED_LOOK:-}
real() { PATH=\${PATH#*:}; exec "$p" "$@"; }
[ -p "$d/ask" ] || real "$@"
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

type PipeReader = ReadableStreamDefaultReader<Uint8Array>;

class Lookout {
  #dir: string | undefined;
  #pipe: { fd: number; reader: PipeReader } | undefined;
  #failed = false;
  readonly #holders = new Set<object>();

  start(holder: object): { dir: string; bin: string } | undefined {
    const ready = this.#ready();
    if (ready) this.#holders.add(holder);
    return ready;
  }

  release(holder: object): void {
    if (this.#holders.delete(holder) && this.#holders.size === 0) this.close();
  }

  #ready(): { dir: string; bin: string } | undefined {
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
      const fd = openSync(ask, constants.O_RDWR | constants.O_NONBLOCK);
      const reader = Bun.file(fd).stream().getReader() as PipeReader;
      this.#pipe = { fd, reader };
      this.#dir = dir;
      live.add(this);
      void this.#listen(dir, reader).catch(() => this.close());
      return { dir, bin: join(dir, "bin") };
    } catch {
      this.#failed = true;
      return undefined;
    }
  }

  async #listen(dir: string, reader: PipeReader): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      pending += decoder.decode(chunk.value, { stream: true });
      for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) { const id = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1); if (/^[\w.]{1,64}$/.test(id)) void this.#answer(dir, id); }
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
    } catch { return; }
  }

  close(): void {
    this.#holders.clear();
    const pipe = this.#pipe;
    this.#pipe = undefined;
    if (pipe) void pipe.reader.cancel().catch(() => undefined).then(() => attempt(() => closeSync(pipe.fd)));
    if (this.#dir) { attempt(() => rmSync(this.#dir!, { recursive: true, force: true })); this.#dir = undefined; }
    this.#failed = false;
    live.delete(this);
  }
}

export const lookout = new Lookout();

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

const attempt = <T>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };

/** How long the holder is waited for to enter its own user namespace, in milliseconds. */
const WAIT_MS = 1000;

/**
 * The user namespace every confined command of one conversation runs in. Bubblewrap makes a new one for each command, and a process in another user
 * namespace cannot be looked at by one in a sibling (the kernel refuses the "may I trace it" test that `ps` and `/proc` are filtered by when the
 * system mounts `/proc` with `hidepid`, as hardened systems do). So a program started by one command, a server or a worker, was invisible to the
 * next command: not in `ps`, not in `/proc`, not reachable by `pkill`. A holder keeps one namespace alive and each command joins it (`--userns`), so
 * the commands of a conversation see each other, and the conversation sees nothing else it was not already allowed to.
 * The holder is `cat` reading a pipe nobody writes: it ends when that pipe closes, which is when this program ends however it ends, and it has no rights of its own.
 */
export class UserNamespace {
  #holder: ChildProcess | undefined;
  #file: string | undefined;
  #failed = false;

  /** The file that names the namespace (to be opened as a descriptor), or nothing where one cannot be held: commands then get one each, as before. */
  file(): string | undefined {
    if (this.#file || this.#failed) return this.#file;
    const child = spawn("bwrap", ["--unshare-user", "--die-with-parent", "--ro-bind", "/", "/", "--cap-drop", "ALL", "--", "cat"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    const pid = child.pid;
    const mine = (() => { try { return readlinkSync("/proc/self/ns/user"); } catch { return undefined; } })();
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (const start = Date.now(); pid !== undefined && mine !== undefined && Date.now() - start < WAIT_MS; Atomics.wait(wait, 0, 0, 5)) {
      // Bubblewrap itself stays where it was; the program it starts is the one inside the new namespace.
      const inside = [pid, ...(attempt(() => readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)) ?? [])].find((p) => attempt(() => readlinkSync(`/proc/${p}/ns/user`)) !== undefined && attempt(() => readlinkSync(`/proc/${p}/ns/user`)) !== mine);
      if (inside !== undefined) { this.#holder = child; return (this.#file = `/proc/${inside}/ns/user`); }
    }
    child.kill();
    this.#failed = true;
    return undefined;
  }

  close(): void { this.#holder?.kill(); this.#holder = undefined; this.#file = undefined; this.#failed = false; }
}

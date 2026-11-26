import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bubblewrapArgs, guarded, joinUserns, withFilter } from "./bubblewrap.ts";
import { denialIn, type Denial } from "./denial.ts";
import { planFor, type Plan, type Setting } from "./policy.ts";
import { seatbeltProfile } from "./seatbelt.ts";
import { lookout } from "./lookout.ts";
import { endsWithThisProgram } from "./ends-with-us.ts";
import { UserNamespace } from "./userns.ts";
import { seccompProgram } from "./seccomp.ts";
import { windowsAbility, windowsLaunch, windowsLine, sandboxHelper } from "./windows.ts";

export { DEFAULT_SETTING, allowsWrite, isHidden, planFor, type Plan, type Setting } from "./policy.ts";
export { denialIn, type Denial } from "./denial.ts";
export { seatbeltProfile } from "./seatbelt.ts";
export { seccompProgram } from "./seccomp.ts";
export { bubblewrapArgs } from "./bubblewrap.ts";
export { GUARD_STDIO, release, releaseFds } from "./handshake.ts";
export { commandLine, quoteArg, useSandboxHelper, windowsLaunch, windowsLine } from "./windows.ts";
export { runConfined } from "./windows-run.ts";

/** What this computer can do: the program that confines, whether the system calls are filtered too, and why there is none. */
export interface Ability { how: "bubblewrap" | "seatbelt" | "jobobject" | "none"; filter: boolean; why?: string }

export interface SandboxOptions {
  /** What the person chose, asked for each command so a change applies at once. */
  setting: () => Setting;
  /** Folders the program itself writes and a command may too, and files of the program itself that hold keys. */
  extra?: () => string[];
  hide?: () => string[];
  home?: string;
  tmp?: string[];
  platform?: NodeJS.Platform;
  /** This program already runs inside a sandbox (a hosted session): another one cannot be made inside it. */
  nested?: boolean;
  /** The words that start this program again as the Windows helper (default: what the program registered). */
  helper?: string[];
  /** Overrides what is found on this computer (for tests). */
  ability?: Ability;
}

/** A command as it will be started. When `confined`, `line` says what is really in force; otherwise it says why nothing is, once. */
export type Launch =
  | { confined: true; argv: string[]; /** Started with `GUARD_STDIO` and released with `release` (see `handshake.ts`); without that the command never starts. */ guarded: boolean; /** Where the shims that let the command look at the computer's programs are (see `lookout.ts`): the folder for `NAVVIED_LOOK` and the one to put first in `PATH`. */ look?: { dir: string; bin: string }; line: string; plan: Plan; denial(output: string, cwd: string): Denial | undefined }
  | { confined: false; line?: string };

const BASE = ["--ro-bind", "/", "/", "--dev", "/dev", "--cap-drop", "ALL"];

let folder: string | undefined;
/** The filter is a file only bubblewrap reads, in a folder made for this program run (so nobody can put another one in its place). */
function filterFile(program: Uint8Array): string {
  if (!folder) {
    folder = mkdtempSync(join(tmpdir(), "navvied-sandbox-"));
    process.on("exit", () => { try { rmSync(folder!, { recursive: true, force: true }); } catch { /* gone already */ } });
  }
  const file = join(folder, "filter");
  writeFileSync(file, program, { mode: 0o600 });
  return file;
}

function detect(platform: NodeJS.Platform): Ability {
  if (platform === "win32") return windowsAbility();
  if (platform === "darwin") {
    const r = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "true"], { stdio: "ignore", timeout: 10_000 });
    return r.status === 0 ? { how: "seatbelt", filter: false } : { how: "none", filter: false, why: "sandbox-exec is not available" };
  }
  if (platform !== "linux") return { how: "none", filter: false, why: "this system has no sandbox navvied can use" };
  const plain = spawnSync("bwrap", [...BASE, "true"], { encoding: "utf8", timeout: 10_000 });
  if (plain.error) return { how: "none", filter: false, why: "bwrap is not installed" };
  if (plain.status !== 0) return { how: "none", filter: false, why: /namespace|uid map|Operation not permitted|Permission denied|unshare/i.test(plain.stderr ?? "") ? "this system does not allow user namespaces" : "bwrap does not start here" };
  const program = seccompProgram();
  if (!program) return { how: "bubblewrap", filter: false };
  const file = filterFile(program);
  const [cmd, ...args] = withFilter(file, [...BASE, "--seccomp", "3"], ["true"]);
  const filtered = spawnSync(cmd!, args, { stdio: "ignore", timeout: 10_000 });
  return { how: "bubblewrap", filter: filtered.status === 0 };
}

const found = new Map<NodeJS.Platform, Ability>();

/** What this computer can do, found once (starting a program to ask costs a few milliseconds). */
export function abilityOf(platform: NodeJS.Platform = process.platform): Ability {
  let a = found.get(platform);
  if (!a) { a = detect(platform); found.set(platform, a); }
  return a;
}

export class Sandbox {
  #said = false;
  #file: string | undefined;
  readonly #space = new UserNamespace();
  constructor(private readonly o: SandboxOptions) {}

  close(): void {
    this.#space.close();
    lookout.release(this);
  }

  setting(): Setting { return this.o.setting(); }

  ability(): Ability {
    if (this.o.ability) return this.o.ability;
    if (this.o.nested) return { how: "none", filter: false, why: "navvied already runs inside a sandbox" };
    return abilityOf(this.o.platform);
  }

  confine(argv: string[], at: { root: string; cwd: string; /** A job that is meant to outlive this program (a restart takes it back): it is not ended with its parent. */ detached?: boolean }): Launch {
    if (!this.setting().on) return { confined: false };
    const ability = this.ability();
    if (ability.how === "none") {
      if (this.#said) return { confined: false };
      this.#said = true;
      return { confined: false, line: `[no sandbox: ${ability.why ?? "none here"}; commands run as they are]` };
    }
    const setting = this.setting();
    if (ability.how === "jobobject") {
      const helper = this.o.helper ?? sandboxHelper();
      if (!helper) return { confined: false, line: "[no sandbox: navvied cannot start its own helper here; commands run as they are]" };
      const detached = at.detached === true;
      return { confined: true, argv: windowsLaunch(helper, argv, { detached }), guarded: false, line: windowsLine(setting, { detached }), plan: { writable: [], hiddenDirs: [], hiddenFiles: [] }, denial: () => undefined };
    }
    const plan = planFor({ root: at.root, home: this.o.home ?? homedir(), tmp: this.o.tmp ?? [tmpdir(), "/tmp", "/var/tmp", "/dev/shm"], extra: this.o.extra?.() ?? [], hide: this.o.hide?.() ?? [] });
    const filtered = ability.how === "bubblewrap" && ability.filter;
    const guard = ability.how === "bubblewrap" && at.detached !== true;
    let started: string[];
    if (ability.how === "seatbelt") started = ["sandbox-exec", "-p", seatbeltProfile(plan, setting), ...argv];
    else {
      const space = this.#space.file();
      const bwrap = bubblewrapArgs(plan, setting, { cwd: at.cwd, filter: filtered, dieWithParent: at.detached !== true, userns: space !== undefined });
      const inside = guard ? guarded(argv) : argv;
      if (filtered) { this.#file ??= filterFile(seccompProgram()!); started = withFilter(this.#file, bwrap, inside); } else started = ["bwrap", ...bwrap, ...inside];
      if (space) started = joinUserns(space, started);
      if (guard) started = endsWithThisProgram(started);
    }
    const parts = ["writes only in the project, temp and caches", ...(plan.hiddenDirs.length + plan.hiddenFiles.length ? ["secret folders hidden"] : []), `network ${setting.network ? "on" : "off"}`, ...(filtered ? ["risky system calls blocked"] : [])]
    const look = ability.how === "bubblewrap" ? lookout.start(this) : undefined;
    if (ability.how === "bubblewrap" && !look) parts.push("other programs not listed");
    return { confined: true, argv: started, guarded: guard, ...(look ? { look } : {}), line: `[sandbox: ${parts.join("; ")}]`, plan, denial: (output, cwd) => denialIn(output, plan, cwd) };
  }
}

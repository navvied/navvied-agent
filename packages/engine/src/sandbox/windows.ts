import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import type { Setting } from "./policy.ts";

/** What this program is called to start again as the helper that confines one command (set once by the program that knows its own command line). */
let registered: string[] | undefined;
export const useSandboxHelper = (words: string[] | undefined): void => { registered = words; };
export const sandboxHelper = (): string[] | undefined => registered;

/** One argument as the C runtime of a Windows program reads it back: quotes and the backslashes before them are the only special characters. */
export function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { slashes++; continue; }
    out += ch === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${ch}`;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/**
 * The command line a program is started with. `cmd.exe /s /c <text>` reads its text itself, not as arguments: quoting it would change what it runs,
 * so what follows `/c` is passed as it is (what Node does for cmd.exe too).
 */
export function commandLine(argv: readonly string[]): string {
  const [program = "", ...args] = argv;
  const c = args.findIndex((a) => /^\/c$/i.test(a));
  const raw = /^cmd(\.exe)?$/i.test(win32.basename(program)) && c >= 0 && args.slice(0, c).some((a) => /^\/s$/i.test(a));
  return raw ? [...[program, ...args.slice(0, c + 1)].map(quoteArg), args.slice(c + 1).join(" ")].join(" ") : argv.map(quoteArg).join(" ");
}

/** The words that start `argv` through the helper. A detached job (meant to outlive this program) is not ended when this program is. */
export const windowsLaunch = (helper: readonly string[], argv: readonly string[], o: { detached: boolean }): string[] => [...helper, "sandbox-run", ...(o.detached ? ["--detached"] : []), "--", ...argv];

/** The one line that says what is and is not in force, built from what the helper does (see windows-run.ts), never from the configuration. */
export function windowsLine(setting: Pick<Setting, "network">, o: { detached: boolean }): string {
  const parts = ["administrator rights removed", o.detached ? "a job keeps its own programs" : "its programs end with the command", "writes and secret folders are not confined", setting.network ? "network on" : "network cannot be switched off here"];
  return `[sandbox: ${parts.join("; ")}]`;
}

/** Whether the helper can confine a command on this computer: it is asked to run a trivial one, so what is reported is what happened. */
export function windowsAbility(helper: readonly string[] | undefined = registered, run: typeof spawnSync = spawnSync): { how: "jobobject" | "none"; filter: false; why?: string } {
  if (!helper) return { how: "none", filter: false, why: "navvied cannot start its own helper here" };
  const [cmd, ...args] = windowsLaunch(helper, ["cmd.exe", "/d", "/c", "exit 0"], { detached: false });
  const r = run(cmd!, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (r.status === 0) return { how: "jobobject", filter: false };
  const said = String(r.stderr ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("sandbox:"));
  return { how: "none", filter: false, why: said ? said.slice("sandbox:".length).trim().slice(0, 120) : "the Windows helper does not start" };
}

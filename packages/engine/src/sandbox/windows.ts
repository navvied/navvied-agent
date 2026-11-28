import { spawnSync } from "../process-start.ts";
import { win32 } from "node:path";
import type { Setting } from "./policy.ts";
import { shellFor, type Shell } from "../platform.ts";

let registered: string[] | undefined;
export const useSandboxHelper = (words: string[] | undefined): void => { registered = words; };
export const sandboxHelper = (): string[] | undefined => registered;

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

export function commandLine(argv: readonly string[]): string {
  const [program = "", ...args] = argv;
  const c = args.findIndex((a) => /^\/c$/i.test(a));
  const raw = /^cmd(\.exe)?$/i.test(win32.basename(program)) && c >= 0 && args.slice(0, c).some((a) => /^\/s$/i.test(a));
  return raw ? [...[program, ...args.slice(0, c + 1)].map(quoteArg), args.slice(c + 1).join(" ")].join(" ") : argv.map(quoteArg).join(" ");
}

export const windowsLaunch = (helper: readonly string[], argv: readonly string[], o: { detached: boolean }): string[] => [...helper, "sandbox-run", ...(o.detached ? ["--detached"] : []), "--", ...argv];

export function windowsLine(setting: Pick<Setting, "network">, o: { detached: boolean }): string {
  const parts = ["administrator rights removed", o.detached ? "a job keeps its own programs" : "its programs end with the command", "writes and secret folders are not confined", setting.network ? "network on" : "network cannot be switched off here"];
  return `[sandbox: ${parts.join("; ")}]`;
}

const PROBE_WORDS = "navvied-sandbox-probe";
const PROBE_CODE = 7;
const MOST_WHY = 200;
const PROBE_MS = 15_000;

const throughAnotherProgram = (shell: Shell): string => {
  const said = `echo ${PROBE_WORDS}`;
  if (shell.name === "cmd") return `${said}| findstr ${PROBE_WORDS}& exit ${PROBE_CODE}`;
  return `${said} | ${shell.name === "PowerShell" ? `findstr ${PROBE_WORDS}` : "cat"}; exit ${PROBE_CODE}`;
};

const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

export function windowsAbility(helper: readonly string[] | undefined = registered, run: typeof spawnSync = spawnSync, shell: Shell = shellFor("win32")): { how: "jobobject" | "none"; filter: false; why?: string } {
  if (!helper) return { how: "none", filter: false, why: "navvied cannot start its own helper here" };
  const [cmd, ...args] = windowsLaunch(helper, shell.argv(throughAnotherProgram(shell)), { detached: false });
  const r = run(cmd!, args, { encoding: "utf8", timeout: PROBE_MS, windowsHide: true });
  const heard = String(r.stdout ?? "").includes(PROBE_WORDS);
  if (r.status === PROBE_CODE && heard) return { how: "jobobject", filter: false };
  const errors = String(r.stderr ?? "");
  const own = errors.split("\n").map((line) => line.trim()).find((line) => line.startsWith("sandbox:"));
  const said = firstLine(errors);
  const why = own ? own.slice("sandbox:".length).trim()
    : r.status === null ? "the Windows helper does not start"
    : `a command run through the Windows helper does not come back as it is (${shell.name}: exit ${r.status}${heard ? "" : ", its words lost"})${said ? `: ${said}` : ""}`;
  return { how: "none", filter: false, why: why.slice(0, MOST_WHY) };
}

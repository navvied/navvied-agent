import { spawnSync } from "@navvied/engine";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dockerBackend, localBackend, sshBackend, type Backend } from "@navvied/engine";
import type { BackendInfo } from "@navvied/protocol";
import type { TerminalConfig } from "./config.ts";

const ORDER = ["local", "docker", "ssh"] as const;
type Id = (typeof ORDER)[number];
const DEFAULT_IMAGE = "debian:stable-slim";

/** Which backend the person chose, kept in the computer's own state. */
export class TerminalState {
  constructor(private readonly file: string) {}
  chosen(): Id {
    try { const raw = JSON.parse(readFileSync(this.file, "utf8")) as { backend?: unknown }; return ORDER.find((x) => x === raw.backend) ?? "local"; } catch { return "local"; }
  }
  set(backend: Id): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, backend }));
      renameSync(tmp, this.file);
    } catch { /* a full disk must not stop the work */ }
  }
}

/** Whether a program is there: it is asked to say its version. Starting one can take seconds (Docker on Windows), so an answer is kept for half a minute. */
export type Probe = (program: string) => boolean;
const KEEP_MS = 30_000;
const seen = new Map<string, { ok: boolean; at: number }>();
const has: Probe = (program) => {
  const known = seen.get(program);
  if (known && Date.now() - known.at < KEEP_MS) return known.ok;
  let ok = false;
  try { ok = spawnSync(program, ["--version"], { stdio: "ignore", timeout: 5000, windowsHide: true }).status === 0; } catch { /* not there */ }
  seen.set(program, { ok, at: Date.now() });
  return ok;
};
const containerProgram = (probe: Probe): string | undefined => ["docker", "podman"].find(probe);

/** The places commands can run, with whether each can be used right now and, when not, what to do about it. */
export function listBackends(state: TerminalState, config: TerminalConfig | undefined, probe: Probe = has): BackendInfo[] {
  const using = state.chosen();
  const program = containerProgram(probe);
  const ssh = config?.ssh;
  const sshReady = ssh !== undefined && probe("ssh");
  return [
    { id: "local", label: "This computer", about: "Run commands directly on this computer. No isolation.", ready: true, using: using === "local" },
    { id: "docker", label: "Docker or Podman", about: "Run commands in an isolated container that keeps its files between commands.", ready: program !== undefined, using: using === "docker", ...(program ? {} : { hint: "Docker or Podman was not found. Install Docker Desktop, docker-ce or Podman." }) },
    { id: "ssh", label: "Another computer (SSH)", about: "Run commands on another computer over SSH.", ready: sshReady, using: using === "ssh", ...(sshReady ? {} : { hint: ssh ? "The ssh program was not found on this computer." : 'Add "terminal": { "ssh": { "host": "…" } } to config.json.' }) },
  ];
}

/** The backend for new conversations: the one chosen when it can be used, otherwise this computer. */
export function backendFor(state: TerminalState, config: TerminalConfig | undefined, probe: Probe = has): Backend {
  const chosen = state.chosen();
  if (chosen === "docker") { const program = containerProgram(probe); if (program) return dockerBackend({ program, image: config?.docker?.image ?? DEFAULT_IMAGE }); }
  if (chosen === "ssh" && config?.ssh) return sshBackend(config.ssh);
  return localBackend;
}

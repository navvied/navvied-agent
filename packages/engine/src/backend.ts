import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { shellFor } from "./platform.ts";

/**
 * Where the Bash tool runs its commands. The files the other tools read and write stay on this computer; only the commands move,
 * so a container or another machine can run what the agent runs without the agent knowing the difference.
 */
export interface Backend {
  readonly id: "local" | "docker" | "ssh";
  /** What to start for `command` while working in `cwd`: the program with its arguments, and the folder to start it in on this computer. Throws a sentence a person can read. */
  prepare(command: string, cwd: string): { argv: string[]; cwd: string };
}

/** The command on this computer, with no isolation: how it always worked. */
export const localBackend: Backend = { id: "local", prepare: (command, cwd) => ({ argv: shellFor().argv(command), cwd }) };

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

const sh = (program: string, args: string[], seconds = 60): { ok: boolean; out: string } => {
  const r = spawnSync(program, args, { encoding: "utf8", timeout: seconds * 1000, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

/**
 * A container that stays between commands, with the working folder mounted in it, so files and installed programs persist.
 * `program` is docker or a program that answers like it, alone or with the arguments it starts with.
 */
export function dockerBackend(o: { program: string | string[]; image: string }): Backend {
  const [program = "docker", ...lead] = typeof o.program === "string" ? [o.program] : o.program;
  const docker = (args: string[], seconds?: number) => sh(program, [...lead, ...args], seconds);
  const ready = new Set<string>();
  return {
    id: "docker",
    prepare(command, cwd) {
      const name = `navvied-${createHash("sha1").update(cwd).digest("hex").slice(0, 10)}`;
      if (!ready.has(name)) {
        const state = docker(["inspect", "-f", "{{.State.Running}}", name]);
        if (!state.ok) {
          const made = docker(["run", "-d", "--name", name, "-v", `${cwd}:/work`, "-w", "/work", o.image, "sleep", "infinity"], 300);
          if (!made.ok) throw new Error(`The container could not be started: ${made.out.split("\n").pop() ?? "unknown error"}`);
        } else if (state.out !== "true") {
          const started = docker(["start", name]);
          if (!started.ok) throw new Error(`The container could not be started: ${started.out.split("\n").pop() ?? "unknown error"}`);
        }
        ready.add(name);
      }
      return { argv: [program, ...lead, "exec", "-w", "/work", name, "sh", "-c", command], cwd };
    },
  };
}

/** Commands run on another machine over ssh, in `dir` there when one is given. It must log in without asking for a password. */
export function sshBackend(o: { host: string; user?: string; dir?: string }): Backend {
  return {
    id: "ssh",
    prepare: (command, cwd) => ({ argv: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", o.user ? `${o.user}@${o.host}` : o.host, o.dir ? `cd ${quote(o.dir)} && ${command}` : command], cwd }),
  };
}

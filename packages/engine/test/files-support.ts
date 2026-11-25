import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@navvied/protocol";
import { Jobs, defaultTools } from "../src/index.ts";
import { FileState } from "../src/tools/file-state.ts";
import type { Part, Tool, ToolContext } from "../src/types.ts";
import { removeTrees } from "../../protocol/test/support/cleanup.ts";

const dirs: string[] = [];
export const workdir = (): string => { const d = mkdtempSync(join(tmpdir(), "navvied-files-")); dirs.push(d); return d; };
export const cleanFiles = (): Promise<void> => removeTrees(dirs);

export const tool = (name: string, patch: "auto" | "on" | "off" = "on"): Tool => { const t = defaultTools({ applyPatch: patch }).find((x) => x.name === name); if (!t) throw new Error(`no tool ${name}`); return t; };

export type Ctx = ToolContext & { emitted: EngineEvent[]; shown: Part[] };

/** What a tool is given in a conversation: a record of the files read, and a way to show a picture. */
export function conversation(cwd: string, extra: Partial<ToolContext> = {}): Ctx {
  const emitted: EngineEvent[] = [], shown: Part[] = [];
  return { cwd, signal: new AbortController().signal, emit: (e) => emitted.push(e), allowPrivateNetwork: false, jobs: new Jobs((e) => emitted.push(e)), files: new FileState(), show: (p) => shown.push(p), ...extra, emitted, shown };
}

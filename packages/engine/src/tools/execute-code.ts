import { untrusted } from "./untrusted.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSecretName, redact, secretsNow } from "../redact.ts";
import type { Tool } from "../types.ts";
import { serveCalls } from "./code-rpc.ts";
import { CodeSession } from "./code-session.ts";
import { STUBS } from "./code-stubs.ts";
import { QUIET_ENV, clip, spill, str } from "./util.ts";

export const EXECUTE_CODE_TOOL = "ExecuteCode";

export interface CodeLimits { seconds: number; calls: number; stdout: number }
export const CODE_LIMITS: CodeLimits = { seconds: 300, calls: 50, stdout: 20_000 };

/** A script that prints more than this is not kept in memory past it. */
const MOST_HELD = 5_000_000;
const FENCE = /^\s*```(?:python3?|py)?[^\S\n]*\n([\s\S]*?)\n?```\s*$/;

/** The variables a script is given: the program's own, without any whose name or value is a secret. */
function scrubbed(env: NodeJS.ProcessEnv): Record<string, string> {
  const known = new Set(secretsNow(env));
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !isSecretName(e[0]) && !known.has(e[1])));
}

export function executeCodeTool(limits: CodeLimits = CODE_LIMITS): Tool {
  return {
    name: EXECUTE_CODE_TOOL,
    readOnly: false,
    experimental: true,
    description: `Run Python 3 that calls tools as functions: from navvied_tools import *. Use for 3 or more tool calls with logic between them: loops over files, pages or records, paging, filtering big results first. Use normal tools for 1-2 calls, results you must read in full, or when the person must answer. Only what it prints comes back; variables stay between calls (reset=true clears). read(path, offset=None, limit=None), write(path, content), edit(path, old, new, replace_all=False), bash(command), web_fetch(url), web_search(query) give text; grep(pattern, path=None, glob=None), glob(pattern) give lists; call_tool(name, **args) runs any other tool offered to you (JSON is parsed). A failed call raises ToolError. ${limits.calls} calls, ${limits.seconds} s.`,
    parameters: { type: "object", properties: { code: { type: "string", description: "the script" }, reset: { type: "boolean", description: "clear variables first" } }, required: ["code"] },
    fixArgs: (a) => { const alias = ["script", "python", "source", "program"].find((k) => typeof a[k] === "string"); return a.code === undefined && alias ? { code: a[alias] } : a; },
    title: (a) => `Run script: ${str(a.code).trim().split("\n")[0]?.slice(0, 200) ?? ""}`,
    async run(a, ctx) {
      const code = FENCE.exec(str(a.code))?.[1] ?? str(a.code);
      if (!code.trim()) return 'Error: the script is empty. Send the Python as code: {"code": "from navvied_tools import *\\nprint(glob(\\"src/**/*.ts\\"))"}';
      if (!ctx.call) return "Error: scripts cannot call tools here. Use the tools one at a time.";
      if (ctx.backend && ctx.backend.id !== "local") return "Error: a script runs on this computer only, and commands are set to run elsewhere. Use the tools one at a time.";
      const python = Bun.which("python3");
      if (!python) return "Error: ExecuteCode needs python3 on the PATH, and it was not found. Use Bash, or the tools one at a time.";

      const make = (): CodeSession => {
        const dir = mkdtempSync(join(tmpdir(), "navvied-code-"));
        writeFileSync(join(dir, "navvied_tools.py"), STUBS);
        return new CodeSession({ python, dir, cwd: ctx.cwd, env: { ...scrubbed(process.env), ...QUIET_ENV, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" } });
      };
      const session = ctx.keep ? ctx.keep(EXECUTE_CODE_TOOL, make) : make();
      const socket = join(session.dir, `rpc-${++served}.sock`);
      const calls = await serveCalls(socket, ctx.call, limits.calls);
      let out = "", dropped = false;
      try {
        const ran = await session.run(code, { sock: socket, reset: a.reset === true, timeoutMs: limits.seconds * 1000, signal: ctx.signal, onOut: (text) => { ctx.live?.(text); if (out.length < MOST_HELD) out += text; else dropped = true; } });
        const printed = redact(out).trimEnd();
        const saved = printed.length > limits.stdout && !ctx.root ? spill(printed) : undefined;
        const status = ran.timedOut ? `[timed out after ${limits.seconds} s and stopped; the variables are gone]` : ran.interrupted ? "[interrupted; the variables are gone]" : ran.exit === 0 ? "" : ran.exit === null ? "[the Python program ended; the variables are gone]" : `[exit ${ran.exit}]`;
        ctx.report?.({ code: ran.exit, truncated: printed.length > limits.stdout || dropped, timedOut: ran.timedOut });
        const note = ran.lost && !ran.timedOut && !ran.interrupted && ran.exit !== null ? "[the Python program was started again: earlier variables are gone]" : "";
        const parts = [note, clip(printed, limits.stdout, 0.4) + (saved ? `\n[the whole output is saved in ${saved}: read the part you need with Read]` : ""), status].filter(Boolean);
        const text = parts.length ? parts.join("\n") : "(no output)";
        return calls.readWeb() ? untrusted("fetch", text) : text;
      } finally {
        calls.close();
        if (!ctx.keep) session.close();
      }
    },
  };
}

let served = 0;

export const executeCode = executeCodeTool();

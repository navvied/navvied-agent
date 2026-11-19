import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Rules, hardBlock, hasRules, parseRules, type RuleSet } from "@navvied/engine";
import type { Options } from "../args.ts";
import { configPath, loadConfig } from "../config.ts";
import type { IO } from "../io.ts";

/** What a program that runs its own tools calls it its tools, in the names navvied's rules use. */
const OURS: Record<string, string> = { Bash: "Bash", Write: "Write", Edit: "Edit", MultiEdit: "Edit", NotebookEdit: "Edit", Read: "Read", WebFetch: "WebFetch" };

async function readAll(stdin: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stdin) text += chunk;
  return text;
}

/**
 * `navvied guard`: a program that runs its own tools (a model reached through a program the person is signed in to) calls this before
 * each tool, with the call as JSON on standard input. Exit 2 stops the tool and what is written on standard error is told to the model.
 * It applies the same things navvied's own engine does: what is never done, and the person's allow / ask / deny rules. A program
 * cannot be asked a question from here, so a rule that says "ask" stops the tool and says why.
 */
export async function guardCommand(options: Options, io: IO): Promise<number> {
  let call: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try { call = JSON.parse(await readAll(io.stdin)); } catch { return 0; }
  const name = typeof call.tool_name === "string" ? OURS[call.tool_name] : undefined;
  const input = typeof call.tool_input === "object" && call.tool_input !== null && !Array.isArray(call.tool_input) ? call.tool_input as Record<string, unknown> : {};
  if (!name) return 0;
  const cwd = resolve(typeof call.cwd === "string" && call.cwd ? call.cwd : options.cwd ?? process.cwd());

  const forbidden = hardBlock(name, input, cwd);
  if (forbidden) { io.stderr.write(`Blocked: ${forbidden}. navvied never does this.\n`); return 2; }

  const file = loadConfig(configPath(io.env, options.config), io.env);
  const own: RuleSet | undefined = file.ok ? file.value?.permissions : undefined;
  let project: RuleSet = { allow: [], ask: [], deny: [] };
  try { project = parseRules(JSON.parse(readFileSync(join(cwd, ".navvied", "permissions.json"), "utf8"))); } catch { /* none */ }
  const set: RuleSet = { allow: own?.allow ?? [], ask: [...(own?.ask ?? []), ...project.ask], deny: [...(own?.deny ?? []), ...project.deny] };
  if (!hasRules(set)) return 0;
  const verdict = new Rules(set, cwd).check(name, input);
  if (verdict.kind === "deny") { io.stderr.write(`Blocked by the permission rule ${verdict.rule}. Do not try again; tell the user what you wanted to do.\n`); return 2; }
  if (verdict.kind === "ask") { io.stderr.write(`The permission rule ${verdict.rule} says this needs the user's approval, and it cannot be asked here. Tell the user what you wanted to do.\n`); return 2; }
  return 0;
}

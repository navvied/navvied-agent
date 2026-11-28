/**
 * The reference solutions of the mcp-sample-* and mcp-elicit-* tasks: `bun mcp-asks-solve.ts <task>`, run in the workspace. The connected program is
 * given the engine's own answers to its requests (`Sampler`, `Elicitor`), with a stand-in for the model that repeats the code it was asked for and, where
 * the task says so, nobody to ask.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpClient } from "../../engine/src/mcp.ts";
import { Elicitor } from "../../engine/src/mcp-elicit.ts";
import { McpAnswers } from "../../engine/src/mcp-host.ts";
import { Sampler } from "../../engine/src/mcp-sampling.ts";

const task = process.argv[2] ?? "";
const attended = task === "mcp-sample-code";
const answers = new McpAnswers(
  new Sampler({
    run: async (_system, messages) => /CODE-\w+/.exec(JSON.stringify(messages))?.[0] ?? "",
    model: () => "stand-in",
    attended: () => attended,
    bypass: () => false,
    approve: async () => ({ optionId: "deny" }),
    hide: (text) => text,
  }),
  new Elicitor({ ask: async () => undefined, attended: () => false, secret: () => undefined }),
);
const config = { command: process.execPath, args: [join(dirname(import.meta.path), "mcp-asks.ts")], env: { BENCH_SECRET: process.env.BENCH_SECRET ?? "" }, ...(task === "mcp-sample-code" ? { sampling: "allow" as const } : {}) };
const client = await McpClient.start("lab", config, undefined, answers.handlers("lab", config));
const none = new AbortController().signal;
try {
  if (task === "mcp-sample-code" || task === "mcp-sample-unattended") {
    const said = await client.call("condense", { ticket: "T-1" }, none);
    writeFileSync("label.txt", `${said.startsWith("condensed: ") ? said.slice("condensed: ".length) : "unavailable"}\n`);
  } else if (task === "mcp-elicit-unattended") {
    const said = await client.call("deploy", { target: "staging" }, none);
    writeFileSync("deploy.txt", `${said.startsWith("deployed: ") ? said.slice("deployed: ".length) : "stopped"}\n`);
  } else { console.error(`unknown task ${task}`); process.exit(2); }
} finally { client.close(); }

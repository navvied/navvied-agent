/**
 * Starts the command line's `run` with a scripted screen: `bun computer-run.ts run <task> --cwd <dir> --json …`, as the harness starts the agent. The screen is the world
 * named by BENCH_COMPUTER, made with the run's secret; every call it gets is written to `.bench-computer.log` in the workspace, for the task's check.
 */
import { parseArgs } from "../../cli/src/args.ts";
import { runCommand } from "../../cli/src/commands/run.ts";
import { processIO } from "../../cli/src/io.ts";
import { screenOf } from "./computer-worlds.ts";

const parsed = parseArgs(process.argv.slice(2));
if (!parsed.ok) { process.stderr.write(`error: ${parsed.error}\n`); process.exit(2); }
process.exit(await runCommand(parsed.prompt, parsed.options, processIO(), { computer: screenOf(process.env.BENCH_COMPUTER ?? "", process.env.BENCH_SECRET ?? "", process.cwd()) }));

/** A stand-in for the program in sandbox.test.ts: it starts one confined `sleep 3<tag>` the way the Bash tool does, and the test kills it. */
import { homedir } from "node:os";
import { DEFAULT_SANDBOX, Jobs, Sandbox } from "../src/index.ts";
import { run } from "../src/tools/util.ts";

const [, , root = "", tag = "", how = "foreground"] = process.argv;
const launch = new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: homedir() }).confine(["sleep", `3${tag}`], { root, cwd: root, detached: how === "detached" });
if (!launch.confined) throw new Error("not confined");
console.log("go");
if (how === "interactive") new Jobs(() => {}).start(launch.argv, root, "sleep", undefined, true, undefined, launch.guarded);
else void run(launch.argv, { cwd: root, signal: new AbortController().signal, timeoutMs: 60_000, guarded: launch.guarded });
setTimeout(() => {}, 5000);

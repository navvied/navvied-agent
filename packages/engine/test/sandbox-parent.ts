import { homedir } from "node:os";
import { DEFAULT_SANDBOX, Jobs, Sandbox } from "../src/index.ts";
import { run } from "../src/tools/util.ts";

const [, , root = "", tag = "", how = "foreground"] = process.argv;
const SHELLS: Record<string, string> = {
  shell: `sleep 3${tag} & sleep 3${tag}; wait`,
  "own session": `setsid sleep 4${tag} < /dev/null > /dev/null 2>&1 & sleep 3${tag}; wait`,
};
const command = SHELLS[how] ? ["bash", "-c", SHELLS[how]!] : ["sleep", `3${tag}`];
const launch = new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: homedir() }).confine(command, { root, cwd: root, detached: how === "detached" });
if (!launch.confined) throw new Error("not confined");
if (how === "interactive") new Jobs(() => {}).start(launch.argv, root, "sleep", undefined, true, undefined, launch.guarded);
else void run(launch.argv, { cwd: root, signal: new AbortController().signal, timeoutMs: 60_000, guarded: launch.guarded });
console.log("started");
setTimeout(() => {}, 5000);

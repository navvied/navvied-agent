import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DEFAULT_SANDBOX, Engine, Sandbox } from "../src/index.ts";
import { ScriptedProvider } from "./helpers.ts";

const [, , project = "", how = "engine"] = process.argv;

async function useTheEngine(): Promise<void> {
  const provider = new ScriptedProvider((_request, n) => (n === 0 ? { calls: [{ name: "Bash", args: { command: 'echo "answered by $(command -v ps)"; ps -e > /dev/null && echo listed' } }] } : { text: "done" }));
  const engine = new Engine({ provider, cwd: project, window: 100_000, heartbeatMs: 0, emit: (e) => { if (e.ev === "tool" && e.status !== "running") console.log(e.output); } });
  engine.handle({ cmd: "prompt", text: "go", mode: "auto" });
  await engine.idle();
  await engine.shutdown();
}

function shareBetweenTwoSandboxes(): void {
  const make = (): Sandbox => new Sandbox({ setting: () => ({ ...DEFAULT_SANDBOX }), home: homedir() });
  const folderOf = (box: Sandbox): string => {
    const launch = box.confine(["true"], { root: project, cwd: project, detached: true });
    if (!launch.confined || !launch.look) throw new Error("no lookout");
    return launch.look.dir;
  };
  const one = make(), two = make();
  const shared = folderOf(one);
  folderOf(one);
  console.log("same folder:", folderOf(two) === shared);
  one.close();
  one.close();
  console.log("kept for the other:", existsSync(shared));
  two.close();
  console.log("gone with the last:", !existsSync(shared));
  const later = make();
  console.log("set up again:", existsSync(folderOf(later)));
  later.close();
}

if (how === "engine") await useTheEngine(); else shareBetweenTwoSandboxes();

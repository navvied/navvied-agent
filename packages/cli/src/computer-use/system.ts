import type { Child, Probe, Spawn } from "./host.ts";
import type { Run } from "./install.ts";

/** The real programs behind the host's seams: `Bun.spawn` for children and for the short commands the host runs. */
export const spawnChild: Spawn = (cmd, args, env) => {
  const p = Bun.spawn([cmd, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const lines: ((l: string) => void)[] = [];
  void (async () => {
    let rest = "";
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
      rest += new TextDecoder().decode(chunk);
      for (let n = rest.indexOf("\n"); n >= 0; n = rest.indexOf("\n")) { const l = rest.slice(0, n); rest = rest.slice(n + 1); if (l) lines.forEach((f) => f(l)); }
    }
  })();
  const child: Child = {
    write: (d) => { p.stdin.write(d); void p.stdin.flush(); },
    onLine: (f) => { lines.push(f); },
    onExit: (f) => { void p.exited.then((c) => f(c)); },
    closeInput: () => { try { void p.stdin.end(); } catch { /* already closed */ } },
    kill: () => { try { p.kill(); } catch { /* already gone */ } },
  };
  return child;
};

export const run: Run = async (cmd, args) => {
  try {
    const p = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } catch (e) { return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) }; }
};

export const probeStatus: Probe = async (cmd, args, env) => {
  try { return (await Bun.spawn([cmd, ...args], { env, stdout: "ignore", stderr: "ignore" }).exited) === 0; } catch { return false; }
};

import type { McpPromptInfo, McpResourceInfo, PluginInfo } from "@navvied/protocol";
import type { Kit } from "./providers/kit.ts";

const NONE = "No skills, tool servers or hooks are set up. Skills are folders with a SKILL.md in ~/.config/navvied/skills; tool servers (mcp) and hooks go in config.json.";
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export async function pluginsScreen(k: Kit): Promise<void> {
  let at = 0;
  for (;;) {
    const got = await k.link.call("plugins", { cmd: "plugins" });
    if (typeof got === "string") { k.say(got); return; }
    const rows = [
      ...got.items.map((p) => ({ label: `${p.enabled ? "on " : "off"}  ${p.kind}  ${p.name}`, hint: p.trusted === false ? "Waits for your trust." : p.problem ?? p.description })),
      { label: "Install a plugin", hint: "From a folder or an address." },
    ];
    const picked = await k.choose("Plugins", "Plugins", rows, { at: Math.min(at, rows.length - 1), body: got.items.length ? ["Enter switches one on or off."] : [NONE] });
    if (picked === undefined) return;
    at = picked;
    const p = got.items[picked];
    if (!p) { await install(k); continue; }
    if (p.trusted === false) { await trust(k, p); continue; }
    if (p.kind === "mcp" || p.kind === "plugin") { await one(k, p); continue; }
    await k.link.call("plugins", { cmd: "plugin.toggle", id: p.id, enabled: !p.enabled });
    k.note.push(`${p.name} is now ${p.enabled ? "off" : "on"}${p.fromNext ? " (from the next new conversation)" : ""}.`);
  }
}

async function trust(k: Kit, p: PluginInfo): Promise<void> {
  const picked = await k.choose("Trust this project's plugin?", "Trust this project's plugin?", [{ label: "Trust this project" }, { label: "Do not trust" }], { body: [`This project asks to use the plugin ${p.name}.`, "It can run commands when the project is open."] });
  if (picked === 0 || picked === 1) k.link.send({ cmd: "skill.review", id: `trust:plugin:${p.name}`, accept: picked === 0 });
}

async function one(k: Kit, p: PluginInfo): Promise<void> {
  for (;;) {
    const rows = [
      { label: p.enabled ? "Turn it off" : "Turn it on" },
      ...(p.kind === "mcp" ? [{ label: "Sign in", hint: "For a program that asks you to sign in." }, { label: "What it offers", hint: "Tools, resources and prompts." }] : []),
    ];
    const picked = await k.choose(p.name, p.name, rows, { body: [k.dim(p.description)] });
    if (picked === 0) { await k.link.call("plugins", { cmd: "plugin.toggle", id: p.id, enabled: !p.enabled }); k.note.push(`${p.name} is now ${p.enabled ? "off" : "on"}${p.fromNext ? " (from the next new conversation)" : ""}.`); return; }
    if (picked === 1) { await signIn(k, p.name); continue; }
    if (picked === 2) { await offers(k, p.name); continue; }
    return;
  }
}

export async function signIn(k: Kit, server: string): Promise<void> {
  const seen: { url?: string; state?: string; reason?: string } = {};
  let waiting: (() => void)[] = [];
  const change = (): Promise<void> => new Promise((resolve) => { waiting.push(resolve); });
  const stop = k.link.watch((e) => {
    if (e.ev !== "mcp.signin" || e.server !== server) return;
    seen.state = e.state;
    if (e.url) seen.url = e.url;
    if (e.reason) seen.reason = e.reason;
    const now = waiting; waiting = [];
    for (const w of now) w();
  });
  try {
    for (;;) {
      seen.state = undefined;
      const first = change();
      k.link.send({ cmd: "mcp.signin", server });
      await first;
      if (seen.state === "waiting") {
        k.io.system.open(seen.url ?? "");
        let pressed: number | undefined;
        do {
          pressed = await k.choose(`Connect ${server}`, `Connect ${server}`, [{ label: "Copy link" }, { label: "Cancel" }], {
            body: [`Sign in to let navvied use ${server}.`, k.dim(seen.url ?? ""), "", "Waiting for you to finish in your browser."],
            live: () => (seen.state === "waiting" ? undefined : { rows: [{ label: "Cancel" }], auto: 1 }),
          });
          if (pressed === 0 && seen.state === "waiting") void k.io.system.copy(seen.url ?? "");
        } while (pressed === 0 && seen.state === "waiting");
        if (seen.state === "waiting") { k.link.send({ cmd: "mcp.signin.cancel", server }); return; }
      }
      if (seen.state === "done") {
        const found = await catalog(k, server);
        k.note.push(`Connected to ${server}.`, `navvied found ${plural(found.count, "tool")}, ${plural(found.docs.length, "resource")} and ${plural(found.prompts.length, "prompt")}.`);
        return;
      }
      if (seen.state === "stopped") return;
      const again = await k.choose(`Connect ${server}`, `Connect ${server}`, [{ label: "Try again" }, { label: "Cancel" }], { body: ["Sign-in did not finish.", ...(seen.reason ? [k.dim(seen.reason)] : [])] });
      if (again !== 0) return;
    }
  } finally { stop(); }
}

async function catalog(k: Kit, server: string): Promise<{ count: number; docs: McpResourceInfo[]; prompts: McpPromptInfo[] }> {
  const [tools, resources, prompts] = await Promise.all([k.link.call("mcp.tools", { cmd: "mcp.tools", server }), k.link.call("mcp.resources", { cmd: "mcp.resources", server }), k.link.call("mcp.prompts", { cmd: "mcp.prompts" })]);
  return { count: typeof tools === "string" ? 0 : tools.items.length, docs: typeof resources === "string" ? [] : resources.items.filter((r) => r.server === server), prompts: typeof prompts === "string" ? [] : prompts.items.filter((i) => i.server === server) };
}

async function offers(k: Kit, server: string): Promise<void> {
  const { count, docs, prompts: mine } = await catalog(k, server);
  for (;;) {
    const picked = await k.choose(server, server, [
      { label: plural(count, "tool"), hint: "navvied searches them when it needs one, so they do not fill the conversation." },
      { label: `Resources  ${docs.length}` }, { label: `Prompts  ${mine.length}` },
    ]);
    if (picked === 1 && docs.length) await k.choose("Resources", "Resources", docs.map((d) => ({ label: d.name ?? d.uri, ...(d.description ? { hint: d.description } : {}) })));
    else if (picked === 2 && mine.length) await usePrompt(k, server, mine);
    else if (picked === undefined) return;
  }
}

async function usePrompt(k: Kit, server: string, prompts: McpPromptInfo[]): Promise<void> {
  const picked = await k.choose("Prompts", "Prompts", prompts.map((p) => ({ label: p.name, ...(p.description ? { hint: p.description } : {}) })));
  const p = picked === undefined ? undefined : prompts[picked];
  if (!p) return;
  const args: Record<string, string> = {};
  for (const a of p.arguments ?? []) {
    const got = await k.text(p.name, k.frame("", a.description ?? a.name));
    if (got === undefined) return;
    if (got || a.required) args[a.name] = got;
  }
  k.link.send({ cmd: "mcp.prompt", server, name: p.name, ...(Object.keys(args).length ? { args } : {}) });
  k.note.push("Added to the message box.");
}

async function install(k: Kit): Promise<void> {
  const from = await k.text("Install a plugin", k.frame("", "Where is it?", k.dim("A folder on this computer, or an address.")));
  if (!from) return;
  const asked = await k.link.call("plugin.install", { cmd: "plugin.install", from });
  if (typeof asked === "string") { k.note.push(asked); return; }
  if (asked.state === "failed") { k.note.push(asked.error ?? "It could not be installed."); return; }
  const b = asked.brings;
  const adds = [b && b.commands.length ? plural(b.commands.length, "command") : "", b && b.hooks ? plural(b.hooks, "hook") : "", b && b.skills.length ? plural(b.skills.length, "skill") : "", b && b.mcp.length ? plural(b.mcp.length, "connected program") : "", b && b.agents.length ? plural(b.agents.length, "helper") : ""].filter(Boolean);
  const hash = asked.hash ?? "";
  const print = `sha256 ${hash.slice(0, 32).match(/.{1,8}/g)?.join(" ") ?? ""}`;
  const picked = await k.choose("Install plugin", "Install plugin", [{ label: "Install" }, { label: "Cancel" }], {
    body: [asked.name ?? from, k.dim(`From ${asked.from}.${adds.length ? ` Adds ${adds.join(" and ")}.` : ""}`), "", "Fingerprint", print, k.dim("Check it matches the one the publisher shows."), ...(asked.findings?.length ? ["", ...asked.findings.map((f) => k.dim(f))] : [])],
  });
  if (picked !== 0) return;
  const done = await k.link.call("plugin.install", { cmd: "plugin.install", from, fingerprint: hash });
  k.note.push(typeof done === "string" ? done : done.state === "done" ? "Installed." : done.error ?? "It could not be installed.");
}

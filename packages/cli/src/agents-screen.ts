import type { Kit } from "./providers/kit.ts";

const ago = (ms: number): string => { const m = Math.max(0, Math.round((Date.now() - ms) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

export async function agentsScreen(k: Kit): Promise<void> {
  for (;;) {
    const got = await k.link.call("a2a", { cmd: "a2a.list" });
    if (typeof got === "string") { k.say(got); return; }
    const rows = [...got.tokens.map((t) => ({ label: t.name, hint: t.lastUsed === undefined ? "Not asked yet" : `Last asked ${ago(t.lastUsed)}` })), { label: "Create access token" }];
    const picked = await k.choose("Other agents", "Other agents", rows, { body: got.tokens.length ? [] : ["No other agents."] });
    if (picked === undefined) return;
    const t = got.tokens[picked];
    if (t) { await revoke(k, t.name); continue; }
    await create(k);
  }
}

async function revoke(k: Kit, name: string): Promise<void> {
  const picked = await k.choose(`Revoke access for ${name}?`, `Revoke access for ${name}?`, [{ label: "Keep it" }, { label: "Revoke" }], { body: ["It can no longer ask this navvied."] });
  if (picked === 1) await k.link.call("a2a", { cmd: "a2a.token.revoke", name });
}

async function create(k: Kit): Promise<void> {
  const name = await k.text("New access token", k.frame("", "What is the other agent called?", k.dim("Letters, digits, dots, dashes and underscores.")));
  if (!name) return;
  const made = await k.link.call("a2a.token", { cmd: "a2a.token.add", name });
  if (typeof made === "string") { k.note.push(made); return; }
  for (;;) {
    const picked = await k.choose("New access token", "New access token", [{ label: "Copy" }, { label: "Done" }], { body: ["Give this token to the other agent's owner.", "", made.token, "", k.dim("Shown once. Copy it now.")] });
    if (picked === 0) { await k.io.system.copy(made.token); k.note.push("Copied."); continue; }
    return;
  }
}

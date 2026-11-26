import type { ComputerPermission, ComputerState, ToolEntry } from "@navvied/protocol";
import type { Kit } from "./providers/kit.ts";
import { toolSetup } from "./tool-setup.ts";

const PERMISSIONS = { accessibility: { title: "Accessibility" }, "screen-recording": { title: "Screen Recording" } } as const;
const ABOUT = "Use the screen, mouse and keyboard.";

const state = (k: Kit, cmd: object): Promise<ComputerState | string> => k.link.call("computer.state", cmd) as Promise<ComputerState | string>;

export async function computerScreen(k: Kit, e: Pick<ToolEntry, "title">): Promise<void> {
  let now = await state(k, { cmd: "computer.state" });
  if (typeof now === "string") { k.note.push(now); return; }
  if (now.on) { const off = await state(k, { cmd: "computer.on", on: false }); if (typeof off === "string") k.note.push(off); return; }
  if (now.step === "unavailable") { k.note.push(now.reason ?? "Computer Use cannot be used here."); return; }
  const start = await k.choose("Control the computer", "Control the computer", [{ label: "Turn on" }, { label: "Not now" }], {
    body: [e.title, "", "Computer Use lets navvied use the screen, the mouse and the keyboard of this computer.", "It asks before it uses an app, and you can stop it at any time."],
  });
  if (start !== 0) return;
  for (;;) {
    now = await state(k, { cmd: "computer.state" });
    if (typeof now === "string") { k.note.push(now); return; }
    if (now.step === "unavailable") { k.note.push(now.reason ?? "Computer Use cannot be used here."); return; }
    if (now.step === "install") {
      await toolSetup(k, { id: "computer", title: e.title, about: ABOUT });
      const after = await state(k, { cmd: "computer.state" });
      if (typeof after === "string" || after.step === "install") return;
      continue;
    }
    if (now.step === "ready") {
      const on = await state(k, { cmd: "computer.on", on: true });
      k.note.push(typeof on === "string" ? on : "Computer Use is on. It asks before it uses an app.");
      return;
    }
    if (!(await permissions(k, now.permissions))) return;
  }
}

async function permissions(k: Kit, list: ComputerPermission[]): Promise<boolean> {
  const shown = list.filter((p) => p.state !== "not-needed");
  const picked = await k.choose("Two permissions", "Two permissions", shown.map((p) => ({ label: `${PERMISSIONS[p.id].title}  ${p.state === "granted" ? "Granted" : "Allow"}` })), {
    at: Math.max(0, shown.findIndex((p) => p.state === "missing")), body: ["Only you can answer the system's questions."],
  });
  const p = picked === undefined ? undefined : shown[picked];
  if (!p) return false;
  if (p.state === "granted") return true;
  k.link.send({ cmd: "computer.permission", id: p.id });
  const said = await k.choose(PERMISSIONS[p.id].title, PERMISSIONS[p.id].title, [{ label: "I did it" }, { label: "Not now" }], { body: [`Opening the system settings for ${PERMISSIONS[p.id].title}.`, "Switch navvied on there, then come back. navvied waits."] });
  return said === 0;
}

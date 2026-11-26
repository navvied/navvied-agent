import type { ComputerPermission, ComputerPermissionId, ComputerState, EngineEvent } from "@navvied/protocol";
import type { ComputerHelper } from "@navvied/engine";
import type { Grants, GrantId } from "./grants.ts";
import type { ComputerUse } from "./service.ts";

/** What the hub asks of this computer for the screen: where turning it on stands, a grant asked for, the switch. */
export interface ComputerPort {
  state(): Promise<ComputerState>;
  request(id: ComputerPermissionId): Promise<void>;
  turn(on: boolean): Promise<void>;
  helper?(owner?: object): ComputerHelper | undefined;
  control?(who: "person" | "agent"): Promise<void>;
}

export interface PortInput {
  use: ComputerUse;
  grants: Grants;
  grantsRead?: Promise<void>;
  isOn(): boolean;
  setOn(on: boolean): void;
  changed(): void;
  unavailable?: string;
}

const GRANTS: GrantId[] = ["accessibility", "screen-recording"];

export class ComputerHere implements ComputerPort {
  private asked = new Set<GrantId>();
  private cached: ComputerState["step"] = "unavailable";
  private who: "agent" | "person" = "agent";
  private helpers = new WeakMap<object, ComputerHelper>();

  constructor(private i: PortInput) {}

  isOn(): boolean { return this.i.isOn(); }

  get step(): ComputerState["step"] { return this.cached; }

  async state(): Promise<ComputerState> {
    await this.i.grantsRead;
    const { use, grants } = this.i;
    const support = use.support();
    const reason = this.i.unavailable ?? (support.ok ? undefined : support.message);
    if (reason) { this.cached = "unavailable"; return { on: false, step: "unavailable", permissions: [], reason }; }
    const permissions: ComputerPermission[] = GRANTS.map((id) => ({ id, state: grants.state(id) }));
    const step: ComputerState["step"] = !use.installed() ? "install" : permissions.some((p) => p.state === "missing") ? "permissions" : "ready";
    this.cached = step;
    const on = step === "ready" && this.i.isOn();
    return { on, step, permissions, ...(on ? { control: this.who } : {}) };
  }

  async request(id: ComputerPermissionId): Promise<void> {
    await this.i.grantsRead;
    const { grants } = this.i;
    if (grants.state(id) !== "missing") return;
    if (this.asked.has(id)) grants.settings(id);
    else { this.asked.add(id); grants.ask(id); }
    this.i.changed();
  }

  async turn(on: boolean): Promise<void> {
    if (on && (await this.state()).step !== "ready") return;
    this.i.setOn(on);
    if (!on) { await this.i.use.close(); this.who = "agent"; }
  }

  /** The driver for one conversation while computer use is on (the same one every turn, so what was allowed is remembered); none while it is off. */
  helper(owner: object = this): ComputerHelper | undefined {
    if (this.i.unavailable || !this.i.isOn() || !this.i.use.support().ok) return undefined;
    let h = this.helpers.get(owner);
    if (!h) { h = this.i.use.helper(); this.helpers.set(owner, h); }
    return h;
  }

  /** The person takes the screen: every step is refused with `human_has_control` until it is given back. */
  async control(who: "person" | "agent"): Promise<void> {
    this.who = who;
    if (who === "person") this.i.use.halt(); else this.i.use.resume();
    this.i.changed();
  }

  /** `tool.setup` for the row `computer`: the driver is fetched, its hash and signature checked, and each step is told. */
  async setup(tell: (e: EngineEvent) => void, signal?: AbortSignal): Promise<void> {
    const say = (state: "downloading" | "verifying" | "done" | "failed" | "unavailable", more: { bytes?: number; total?: number; percent?: number; error?: string } = {}) => tell({ ev: "tool.setup", id: "computer", state, ...more });
    if (!this.i.use.support().ok) { say("unavailable", { error: (this.i.use.support() as { message: string }).message }); return; }
    say("downloading", { bytes: 0, total: 0, percent: 0 });
    const r = await this.i.use.fetch((bytes, total) => say("downloading", { bytes, total, ...(total ? { percent: Math.floor((100 * bytes) / total) } : {}) }), signal);
    if (r.ok) { say("done", { percent: 100 }); this.i.changed(); return; }
    const error = r.why === "download" ? (r.result.why === "nodisk" ? "There is not enough free space for it." : r.result.why === "paused" || r.result.why === "cancelled" ? "It was stopped." : "It could not be downloaded.") : r.why === "signature" ? "It could not be checked, so it was not kept." : "It could not be unpacked.";
    say("failed", { error });
  }
}

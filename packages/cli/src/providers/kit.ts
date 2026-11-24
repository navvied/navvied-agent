import type { EngineEvent } from "@navvied/protocol";
import type { Choice, Frame, IO } from "../io.ts";
import { paint } from "../render.ts";
import type { Link } from "./link.ts";

export type Caps = Extract<EngineEvent, { ev: "caps" }>;

/** How a screen ends: the person went back, or chose a model and the conversation moved on to it. */
export type Result = "back" | "switched";

export interface Live { rows: Choice[]; body?: string[]; /** Close the list with this answer (-1: no row). */ auto?: number }

/** What every screen of the providers shares: the terminal, the hub, and a line said at the top of the next screen (a list covers the conversation, so a result said there would not be seen). */
export class Kit {
  note: string[] = [];

  constructor(readonly io: IO, readonly link: Link, readonly say: (text: string) => void, readonly switching: (handover: boolean) => void) {}

  get color(): boolean { return this.io.color; }
  dim = (t: string): string => paint(this.io.color, "dim", t);

  /** The heading line of a screen, for those that show only a heading (waiting) and must not use up what is waiting to be said. */
  heading(text: string): string[] { return [paint(this.io.color, "cyan", paint(this.io.color, "bold", text))]; }

  /** The frame of a screen, with what is waiting to be said. */
  frame(heading: string, ...body: string[]): Frame {
    return { ...(heading ? { heading: this.heading(heading) } : {}), ...(body.length ? { body } : {}), ...(this.note.length ? { notice: this.note.splice(0) } : {}) };
  }

  /** A list. `live` is asked again twice a second so progress moves. Resolves to the row, or undefined when the person goes back. */
  async choose(title: string, heading: string, rows: Choice[], o: { at?: number; body?: string[]; live?: () => Live | undefined } = {}): Promise<number | undefined> {
    if (!this.io.choose) return undefined;
    const frame = this.frame(heading === title ? "" : heading, ...(o.body ?? []));
    const watch = o.live ? {
      everyMs: 500,
      next: async () => {
        const now = o.live?.();
        if (!now) return undefined;
        return { items: now.rows, frame: { ...frame, ...(now.body ? { body: now.body } : {}) }, ...(now.auto !== undefined ? { auto: now.auto } : {}) };
      },
    } : undefined;
    const answer = await this.io.choose(title, rows, o.at ?? 0, frame, watch);
    return typeof answer === "number" ? answer : undefined;
  }

  async text(title: string, frame: Frame, initial = ""): Promise<string | undefined> {
    const got = await this.io.text?.(title, initial, frame);
    return typeof got === "string" ? got.trim() : undefined;
  }

  async secret(title: string, frame: Frame): Promise<string | undefined> {
    const got = await this.io.secret?.(title, frame);
    return typeof got === "string" ? got : undefined;
  }

  /** Asks yes or no, no first: the person has to press for the change. */
  async confirm(title: string, heading: string, yes: string, no: string): Promise<boolean> {
    return (await this.choose(title, heading, [{ label: no }, { label: yes }])) === 1;
  }
}

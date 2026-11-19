export type KeyName = "enter" | "tab" | "backspace" | "delete" | "escape" | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown";

export type Key =
  | { kind: "text"; text: string }
  | { kind: "key"; name: KeyName; ctrl: boolean; alt: boolean; shift: boolean }
  | { kind: "ctrl"; letter: string }
  | { kind: "alt"; text: string }
  | { kind: "paste"; text: string }
  | { kind: "wheel"; direction: "up" | "down" };

const PASTE_END = "\u001b[201~";
const NAMED: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE: Record<string, KeyName> = { "1": "home", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };
const PLAIN = /^[^\u0000-\u001f\u007f]+/;

const named = (name: KeyName, modifier = 1): Key => {
  const bits = Math.max(0, modifier - 1);
  return { kind: "key", name, shift: Boolean(bits & 1), alt: Boolean(bits & 2), ctrl: Boolean(bits & 4) };
};

/** Turns the bytes a terminal sends into keys. Sequences split across chunks are held until they are complete. */
export class KeyParser {
  #buf = "";
  #pasting: string | undefined;

  push(chunk: string): Key[] {
    this.#buf += chunk;
    const keys: Key[] = [];
    for (;;) {
      if (this.#pasting !== undefined) {
        const end = this.#buf.indexOf(PASTE_END);
        if (end < 0) { this.#pasting += this.#buf; this.#buf = ""; return keys; }
        keys.push({ kind: "paste", text: this.#pasting + this.#buf.slice(0, end) });
        this.#buf = this.#buf.slice(end + PASTE_END.length);
        this.#pasting = undefined;
        continue;
      }
      if (!this.#buf) return keys;
      const used = this.#one(keys);
      if (used === 0) return keys;
      this.#buf = this.#buf.slice(used);
    }
  }

  /** A lone Escape cannot be told from the start of a sequence until nothing more arrives; call this after a short wait. */
  flush(): Key[] {
    if (this.#buf !== "\u001b") return [];
    this.#buf = "";
    return [named("escape")];
  }

  /** Characters consumed from the buffer, or 0 when the sequence is not complete yet. */
  #one(out: Key[]): number {
    const b = this.#buf;
    const c = b[0]!;
    if (c === "\u001b") return this.#escape(out);
    if (c === "\r" || c === "\n") { out.push(named("enter")); return 1; }
    if (c === "\t") { out.push(named("tab")); return 1; }
    if (c === "\u007f" || c === "\b") { out.push(named("backspace")); return 1; }
    if (c < " ") { if (c !== "\u0000") out.push({ kind: "ctrl", letter: String.fromCharCode(c.charCodeAt(0) + 96) }); return 1; }
    const run = PLAIN.exec(b)![0];
    out.push({ kind: "text", text: run });
    return run.length;
  }

  #escape(out: Key[]): number {
    const b = this.#buf;
    if (b.length === 1) return 0;
    const next = b[1]!;
    if (next === "[") return this.#csi(out);
    if (next === "O") {
      if (b.length < 3) return 0;
      const name = NAMED[b[2]!];
      if (name) out.push(named(name));
      return 3;
    }
    if (next === "\r" || next === "\n") { out.push({ kind: "key", name: "enter", shift: false, alt: true, ctrl: false }); return 2; }
    if (next === "\u007f") { out.push({ kind: "key", name: "backspace", shift: false, alt: true, ctrl: false }); return 2; }
    if (next === "\u001b") { out.push(named("escape")); return 1; }
    const char = String.fromCodePoint(b.codePointAt(1)!);
    out.push({ kind: "alt", text: char });
    return 1 + char.length;
  }

  #csi(out: Key[]): number {
    const b = this.#buf;
    let i = 2;
    while (i < b.length && b.charCodeAt(i) >= 0x30 && b.charCodeAt(i) <= 0x3f) i++;
    while (i < b.length && b.charCodeAt(i) >= 0x20 && b.charCodeAt(i) <= 0x2f) i++;
    if (i >= b.length) return 0;
    const params = b.slice(2, i);
    const final = b[i]!;
    const used = i + 1;
    const [first = "", second = ""] = params.split(";");
    const modifier = Number(second) || 1;

    if (final === "~" && first === "200") { this.#pasting = ""; return used; }
    if (final === "~" && first === "201") return used;
    if ((final === "M" || final === "m") && params.startsWith("<")) {
      const button = Number(first.slice(1));
      if (final === "M" && (button & 0x43) === 0x40) out.push({ kind: "wheel", direction: "up" });
      else if (final === "M" && (button & 0x43) === 0x41) out.push({ kind: "wheel", direction: "down" });
      return used;
    }
    if (final === "Z") { out.push({ kind: "key", name: "tab", shift: true, alt: false, ctrl: false }); return used; }
    if (final === "u") {
      const code = Number(first);
      if (code === 13) out.push(named("enter", modifier));
      else if (code === 27) out.push(named("escape", modifier));
      else if (code === 9) out.push(named("tab", modifier));
      else if (code === 127) out.push(named("backspace", modifier));
      else if (code >= 32) out.push({ kind: "text", text: String.fromCodePoint(code) });
      return used;
    }
    if (final === "~") { const name = TILDE[first]; if (name) out.push(named(name, modifier)); return used; }
    const name = NAMED[final];
    if (name) out.push(named(name, modifier));
    return used;
  }
}

import { describe, expect, test } from "bun:test";
import { LineSplitter, encodeCommand, parseCommand, parseEvent, validateCommand, type Command } from "../src/index.ts";
import { garbage, int, mutate, pick, prng, value } from "./prng.ts";

const RUNS = 3000;
const VALID = [
  { cmd: "prompt", text: "hello", qid: "q1", mode: "plan", effort: "high", paths: ["/a"], images: [{ mime: "image/png", data: "AA==" }] },
  { cmd: "approve", id: "a1", optionId: "allow" },
  { cmd: "restore", id: "k1", preview: true },
  { cmd: "load", id: "s1" },
  { cmd: "cancel" },
];

describe("random input never breaks the protocol layer", () => {
  test("parseCommand and validateCommand never throw; an accepted command is stable under re-validation", () => {
    const r = prng(1);
    let accepted = 0;
    for (let i = 0; i < RUNS; i++) {
      const v = r() < 0.4 ? value(r) : mutate(r, pick(r, VALID));
      const viaJson = parseCommand(JSON.stringify(v) ?? "null");
      const direct = validateCommand(v);
      expect(viaJson.ok === direct.ok).toBe(true);
      if (viaJson.ok) {
        accepted++;
        const again = validateCommand(viaJson.value);
        expect(again.ok && JSON.stringify(again.value) === JSON.stringify(viaJson.value)).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  test("random text and truncated JSON are rejected with a message, not an exception", () => {
    const r = prng(2);
    for (let i = 0; i < RUNS; i++) {
      const raw = r() < 0.5 ? garbage(r) : JSON.stringify(value(r)).slice(0, int(r, 60));
      for (const parse of [parseCommand, parseEvent]) {
        const result = parse(raw);
        if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
      }
    }
  });

  test("an accepted command only ever carries known fields", () => {
    const r = prng(3);
    const known = new Set(["cmd", "text", "qid", "images", "files", "effort", "mode", "paths", "id", "optionId", "preview", "input"]);
    for (let i = 0; i < RUNS; i++) {
      const base = { cmd: pick(r, ["prompt", "cancel", "approve", "compact", "load", "checkpoints", "restore"]), text: pick(r, ["hi", "", "x"]), id: "a", optionId: "o", ...(value(r) as object) };
      const result = validateCommand(base);
      if (result.ok) for (const key of Object.keys(result.value)) expect(known.has(key)).toBe(true);
    }
  });

  test("the prototype cannot be polluted by a hostile command", () => {
    const hostile = JSON.parse('{"cmd":"prompt","text":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    validateCommand(hostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("encoding then parsing is the identity for valid commands", () => {
    const r = prng(4);
    for (let i = 0; i < RUNS; i++) {
      const cmd: Command = pick(r, [
        { cmd: "prompt", text: garbage(r) || "x", ...(r() < 0.5 ? { mode: pick(r, ["ask", "auto", "plan"] as const) } : {}) },
        { cmd: "approve", id: "a" + int(r, 99), optionId: pick(r, ["allow", "deny"]) },
        { cmd: "restore", id: "k" + int(r, 99), preview: r() < 0.5 },
        { cmd: "cancel" }, { cmd: "compact" }, { cmd: "checkpoints" }, { cmd: "load", id: "s" + int(r, 99) },
      ] as Command[]);
      const wire = encodeCommand(cmd);
      expect(wire.indexOf("\n")).toBe(wire.length - 1);
      const back = parseCommand(wire.trim());
      const expected = cmd.cmd === "restore" && !cmd.preview ? { cmd: "restore", id: cmd.id } : cmd;
      expect(back.ok && back.value).toEqual(expected as Command);
    }
  });
});

describe("the line splitter", () => {
  test("yields the same lines however the stream is cut into chunks", () => {
    const r = prng(5);
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 1 + int(r, 8) }, () => JSON.stringify(value(r)).replace(/\n/g, " "));
      const stream = lines.map((l) => `${l}\n`).join("");
      const splitter = new LineSplitter();
      const out: string[] = [];
      for (let at = 0; at < stream.length; ) {
        const size = 1 + int(r, 40);
        out.push(...splitter.push(stream.slice(at, at + size)));
        at += size;
      }
      out.push(...splitter.flush());
      expect(out).toEqual(lines.map((l) => l.trim()).filter(Boolean));
    }
  });
});

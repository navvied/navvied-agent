import { describe, expect, test } from "bun:test";
import {
  RecentIds,
  EventEncoder, LIMITS, LineSplitter, MAX_LINE, PROTOCOL_VERSION, encodeCommand, parseCommand, parseEvent, validateCommand,
  type Command, type EngineEvent,
} from "../src/index.ts";

describe("RecentIds", () => {
  test("accepts an id once, refuses repeats, and forgets the oldest past its limit", () => {
    const ids = new RecentIds(2);
    expect([ids.isNew("a"), ids.isNew("a"), ids.isNew("b"), ids.isNew("c")]).toEqual([true, false, true, true]);
    expect(ids.isNew("b")).toBe(false);
    expect(ids.isNew("a")).toBe(true);
  });
});

describe("commands", () => {
  const samples: Command[] = [
    { cmd: "prompt", text: "fix the login bug", qid: "3f2c9a52-9d0e-4c61-8b1e-0a1b2c3d4e5f", mode: "plan", effort: "high", paths: ["/work/app"] },
    { cmd: "prompt", text: "", images: [{ mime: "image/png", data: "iVBORw0KGgo=" }] },
    { cmd: "cancel" },
    { cmd: "compact" },
    { cmd: "model", id: "raphael-sage-2" },
    { cmd: "effort", level: "high" },
    { cmd: "effort", level: "auto" },
    { cmd: "approve", id: "perm1", optionId: "allow" },
    { cmd: "load", id: "session-1" },
    { cmd: "checkpoints" },
    { cmd: "restore", id: "k1" },
    { cmd: "restore", id: "k1", preview: true },
    { cmd: "job.stop", id: "job1" },
  ];

  test.each(samples.map((s) => [s.cmd, s] as const))("%s round-trips through the codec", (_name, cmd) => {
    const wire = encodeCommand(cmd);
    expect(wire.endsWith("\n")).toBe(true);
    expect(wire.indexOf("\n")).toBe(wire.length - 1); // exactly one line
    const r = parseCommand(wire.trim());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(cmd);
  });

  test("the protocol has a version", () => expect(PROTOCOL_VERSION).toBe(1));

  test("unknown fields are dropped, never forwarded", () => {
    const r = validateCommand({ cmd: "prompt", text: "hi", sneaky: "value", mode: "auto", __proto__: { x: 1 } });
    expect(r.ok && r.value).toEqual({ cmd: "prompt", text: "hi", mode: "auto" });
  });

  test.each([
    ["not an object", "[]", /JSON object/],
    ["not json", "{oops", /not valid JSON/],
    ["no cmd", "{}", /missing cmd/],
    ["unknown cmd", '{"cmd":"explode"}', /unknown command "explode"/],
    ["prompt without text", '{"cmd":"prompt"}', /text must be a string/],
    ["empty prompt", '{"cmd":"prompt","text":"   "}', /needs text or an image/],
    ["bad mode", '{"cmd":"prompt","text":"x","mode":"yolo"}', /mode must be one of/],
    ["bad effort", '{"cmd":"prompt","text":"x","effort":"ludicrous"}', /effort must be one of/],
    ["bad qid", '{"cmd":"prompt","text":"x","qid":""}', /qid/],
    ["bad paths", '{"cmd":"prompt","text":"x","paths":[1]}', /paths/],
    ["image without data", '{"cmd":"prompt","text":"x","images":[{"mime":"image/png"}]}', /needs mime and data/],
    ["image that is not an image", '{"cmd":"prompt","text":"x","images":[{"mime":"text/html","data":"AA=="}]}', /image type/],
    ["approve without option", '{"cmd":"approve","id":"p1"}', /id and optionId/],
    ["model without id", '{"cmd":"model"}', /model needs an id/],
    ["effort that does not exist", '{"cmd":"effort","level":"ludicrous"}', /effort.level must be/],
    ["effort without a level", '{"cmd":"effort"}', /effort.level must be/],
    ["load without id", '{"cmd":"load"}', /needs an id/],
    ["restore without id", '{"cmd":"restore"}', /restore needs an id/],
    ["restore with a non-boolean preview", '{"cmd":"restore","id":"k","preview":"yes"}', /preview must be true or false/],
  ])("rejects: %s", (_name, line, why) => {
    const r = parseCommand(line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(why);
  });

  test("size limits", () => {
    expect(validateCommand({ cmd: "prompt", text: "x".repeat(LIMITS.text + 1) }).ok).toBe(false);
    const many = Array.from({ length: LIMITS.images + 1 }, () => ({ mime: "image/png", data: "AA==" }));
    expect(validateCommand({ cmd: "prompt", text: "x", images: many }).ok).toBe(false);
    const paths = Array.from({ length: LIMITS.paths + 50 }, (_, i) => `/p/${i}`);
    const r = validateCommand({ cmd: "prompt", text: "x", paths });
    expect(r.ok && r.value.cmd === "prompt" && r.value.paths?.length).toBe(LIMITS.paths);
  });
});

describe("events", () => {
  test("the encoder stamps a strictly increasing seq and a unique eid", () => {
    const enc = new EventEncoder();
    const lines = [enc.encode({ ev: "text", text: "a" }), enc.encode({ ev: "alive" }), enc.encode({ ev: "done", stop: "end_turn" })];
    const parsed = lines.map((l) => { const r = parseEvent(l.trim()); if (!r.ok) throw new Error(r.error); return r.value; });
    expect(parsed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(new Set(parsed.map((e) => e.eid)).size).toBe(3);
    expect(parsed[0]).toMatchObject({ ev: "text", text: "a" });
    expect(enc.seq).toBe(3);
  });

  test("an unknown event passes through (forward compatibility)", () => {
    const r = parseEvent('{"ev":"from_the_future","x":1,"seq":9,"eid":"e9"}');
    expect(r.ok ? (r.value.ev as string) : "").toBe("from_the_future");
  });

  test("the envelope is checked", () => {
    expect(parseEvent("[]").ok).toBe(false);
    expect(parseEvent('{"text":"no ev"}').ok).toBe(false);
    expect(parseEvent("nope").ok).toBe(false);
  });

  test("every event shape survives a round trip", () => {
    const enc = new EventEncoder();
    const events: EngineEvent[] = [
      { ev: "session", id: "s1" }, { ev: "loaded", id: "s1" },
      { ev: "caps", steer: true, modes: ["ask", "auto", "plan"], defaultMode: "auto", compact: true },
      { ev: "caps", steer: true, modes: ["auto"], compact: false, models: [{ id: "m1", name: "Raphael Sage", brand: "raphael", badge: "FREE", blurb: "Everyday", current: true }, { id: "m2", name: "Jarvis Prime", locked: true }], efforts: ["low", "high"], effort: "high" },
      { ev: "user", qid: "q", text: "héllo", images: 2 }, { ev: "taken", qid: "q" }, { ev: "text", text: "héllo\n“quoted”" }, { ev: "thought", text: "hm" }, { ev: "thought_end", ms: 1200 },
      { ev: "job", id: "job1", title: "dev server", status: "done", code: 0, startedAt: 1, last: "ready" },
      { ev: "approval", id: "p2", title: "Edit file: a.ts", options: [{ optionId: "allow", name: "Allow" }], change: { tool: "Edit", file: "a.ts", old: "x", new: "y" } },
      { ev: "tool", id: "t1", name: "Edit", status: "running", input: { file_path: "a.ts" } },
      { ev: "tool", id: "t1", name: "Edit", status: "done", output: "ok" },
      { ev: "plan", entries: [{ title: "step", status: "in_progress" }] },
      { ev: "usage", ctx: 10, win: 100, out: 2 },
      { ev: "approval", id: "p1", title: "Run command: ls", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
      { ev: "plan_proposal", id: "pp" }, { ev: "phase", name: "compacting" }, { ev: "alive" }, { ev: "notice", msg: "A connected program could not start." },
      { ev: "done", stop: "cancelled" }, { ev: "error", msg: "boom" },
      { ev: "checkpoints", items: [{ id: "k1", at: 1, label: "x", repos: ["app"] }] },
      { ev: "restore", id: "k1", preview: false, changes: [{ repo: "app", path: "a.ts", change: "revert" }], undoId: "u1" },
    ];
    for (const e of events) {
      const r = parseEvent(enc.encode(e).trim());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toMatchObject(e as object);
    }
  });

  test("text containing newlines and unicode stays on one line", () => {
    const line = new EventEncoder().encode({ ev: "text", text: "a\nb c" });
    expect(line.trim().split("\n").length).toBe(1);
  });
});

describe("line splitter", () => {
  test("joins a message split across chunks", () => {
    const s = new LineSplitter();
    expect(s.push('{"cmd":"can')).toEqual([]);
    expect(s.push('cel"}\n{"cmd":"compact"}\n{"cm')).toEqual(['{"cmd":"cancel"}', '{"cmd":"compact"}']);
    expect(s.push('d":"cancel"}\n')).toEqual(['{"cmd":"cancel"}']);
  });
  test("ignores blank lines and CRLF", () => {
    expect(new LineSplitter().push('\n\r\n{"a":1}\r\n  \n')).toEqual(['{"a":1}']);
  });
  test("flush returns an unterminated final line once", () => {
    const s = new LineSplitter();
    s.push('{"a":1}');
    expect(s.flush()).toEqual(['{"a":1}']);
    expect(s.flush()).toEqual([]);
  });
  test("multi-byte characters split between chunks are the caller's decoder's job; strings pass intact", () => {
    const s = new LineSplitter();
    expect(s.push("{\"t\":\"日本")).toEqual([]);
    expect(s.push("語\"}\n")).toEqual(['{"t":"日本語"}']);
  });
  test("a line longer than the cap throws and resets", () => {
    const s = new LineSplitter();
    expect(() => s.push("x".repeat(MAX_LINE + 1))).toThrow(RangeError);
    expect(s.push('{"ok":1}\n')).toEqual(['{"ok":1}']);
  });
});

describe("the commands of the list of conversations, and the kind", () => {
  test("new, rename, remove and pin are rebuilt from their checked fields, with the kind when there is one", () => {
    expect(parseCommand('{"cmd":"new","kind":"chat","junk":1}')).toEqual({ ok: true, value: { cmd: "new", kind: "chat" } });
    expect(parseCommand('{"cmd":"rename","id":"a","title":"  Bali  "}')).toEqual({ ok: true, value: { cmd: "rename", id: "a", title: "Bali" } });
    expect(parseCommand('{"cmd":"remove","id":"a","kind":"agent"}')).toEqual({ ok: true, value: { cmd: "remove", id: "a", kind: "agent" } });
    expect(parseCommand('{"cmd":"pin","id":"a","pinned":true}')).toEqual({ ok: true, value: { cmd: "pin", id: "a", pinned: true } });
    for (const bad of ['{"cmd":"rename","id":"a","title":"  "}', '{"cmd":"rename","title":"x"}', '{"cmd":"pin","id":"a","pinned":"yes"}', '{"cmd":"remove"}', '{"cmd":"new","kind":"robot"}']) expect(parseCommand(bad).ok).toBe(false);
  });
});


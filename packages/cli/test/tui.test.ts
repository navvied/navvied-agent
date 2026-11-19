import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { LineEditor } from "../src/tui/editor.ts";
import { composeFrame, maxInputRows, viewportRows } from "../src/tui/frame.ts";
import { KeyParser, type Key } from "../src/tui/keys.ts";
import { Menu, Secret, chipLines, suggestionLines, workLines } from "../src/tui/menu.ts";
import { Tui } from "../src/tui/terminal.ts";
import { Transcript, sanitize } from "../src/tui/transcript.ts";
import { clip, visibleWidth, wrap } from "../src/tui/wrap.ts";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const press = (editor: LineEditor, ...keys: Key[]) => keys.map((k) => editor.apply(k));
const text = (s: string): Key => ({ kind: "text", text: s });
const named = (name: Extract<Key, { kind: "key" }>["name"], mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}): Key => ({ kind: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const ctrl = (letter: string): Key => ({ kind: "ctrl", letter });

describe("key parser", () => {
  const keys = (...chunks: string[]): Key[] => { const p = new KeyParser(); return chunks.flatMap((c) => p.push(c)); };

  test("plain text, Enter, Tab, Backspace and control letters", () => {
    expect(keys("hi there\r\t\u007f\u0001\u0003")).toEqual([text("hi there"), named("enter"), named("tab"), named("backspace"), ctrl("a"), ctrl("c")]);
  });

  test("arrows, Home, End, Delete, paging, with and without modifiers", () => {
    expect(keys("\u001b[A\u001b[B\u001b[C\u001b[D\u001b[H\u001b[F\u001b[3~\u001b[5~\u001b[6~")).toEqual(
      ["up", "down", "right", "left", "home", "end", "delete", "pageup", "pagedown"].map((n) => named(n as "up")));
    expect(keys("\u001bOA\u001bOH")).toEqual([named("up"), named("home")]);
    expect(keys("\u001b[1;5C\u001b[1;3D\u001b[1;2A")).toEqual([named("right", { ctrl: true }), named("left", { alt: true }), named("up", { shift: true })]);
    expect(keys("\u001b[Z")).toEqual([named("tab", { shift: true })]);
  });

  test("a sequence split across chunks is held until it is whole", () => {
    const p = new KeyParser();
    expect(p.push("\u001b")).toEqual([]);
    expect(p.push("[")).toEqual([]);
    expect(p.push("1;5")).toEqual([]);
    expect(p.push("D")).toEqual([named("left", { ctrl: true })]);
  });

  test("a lone Escape is reported once the wait is over, and is not mistaken for a sequence", () => {
    const p = new KeyParser();
    expect(p.push("\u001b")).toEqual([]);
    expect(p.flush()).toEqual([named("escape")]);
    expect(p.flush()).toEqual([]);
  });

  test("Alt with a letter, Alt+Enter and Alt+Backspace", () => {
    expect(keys("\u001bb\u001b\r\u001b\u007f")).toEqual([{ kind: "alt", text: "b" }, named("enter", { alt: true }), named("backspace", { alt: true })]);
  });

  test("bracketed paste arrives as one piece, newlines included, even when split", () => {
    expect(keys("\u001b[200~line one\nline two\u001b[201~")).toEqual([{ kind: "paste", text: "line one\nline two" }]);
    expect(keys("\u001b[200~abc", "def\u001b[201~x")).toEqual([{ kind: "paste", text: "abcdef" }, text("x")]);
  });

  test("the mouse wheel is read; clicks and releases are ignored", () => {
    expect(keys("\u001b[<64;10;5M\u001b[<65;10;5M\u001b[<0;3;3M\u001b[<0;3;3m")).toEqual([{ kind: "wheel", direction: "up" }, { kind: "wheel", direction: "down" }]);
  });

  test("non-Latin text and emoji stay whole", () => {
    expect(keys("日本語 🚀")).toEqual([text("日本語 🚀")]);
  });

  test("the keyboard protocol form of Shift+Enter and Escape", () => {
    expect(keys("\u001b[13;2u\u001b[27u")).toEqual([named("enter", { shift: true }), named("escape")]);
  });

  test("a sequence it does not know is swallowed, not shown as text", () => {
    expect(keys("\u001b[99999x", "ok")).toEqual([text("ok")]);
  });
});

describe("wrapping", () => {
  test("breaks at spaces, keeps indentation, and never exceeds the width", () => {
    expect(wrap("hello brave new world of terminals", 12)).toEqual(["hello brave", "new world of", "terminals"]);
    expect(wrap("  - indented list item that wraps around nicely", 20)).toEqual(["  - indented list", "  item that wraps", "  around nicely"]);
    expect(wrap("short", 20)).toEqual(["short"]);
  });

  test("a word longer than the line is cut", () => {
    expect(wrap("abcdefghijklmnopqrstuvwxyz", 10)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
  });

  test("a long path with no spaces breaks at a slash, not mid-name, when one is in reach", () => {
    expect(wrap("/tmp/navvied-cli-preview-abcdef/navvied-eval-fix-off-by-one-preview/src/range.ts (6 lines).", 40)).toEqual([
      "/tmp/navvied-cli-preview-abcdef/",
      "navvied-eval-fix-off-by-one-preview/src/",
      "range.ts (6 lines).",
    ]);
    // No slash in reach at all: it still falls back to a hard cut, same as any other unbroken word.
    expect(wrap("a".repeat(12), 5)).toEqual(["aaaaa", "aaaaa", "aa"]);
  });

  test("colour carries over a break and is closed at the end of each row", () => {
    const rows = wrap("\u001b[31mred words that need to wrap\u001b[0m and plain", 14);
    expect(rows[0]).toBe("\u001b[31mred words that\u001b[0m");
    expect(rows[1]!.startsWith("\u001b[31m")).toBe(true);
    expect(rows.every((r) => visibleWidth(r) <= 14)).toBe(true);
    expect(strip(rows.join(" "))).toBe("red words that need to wrap and plain");
  });

  test("wide characters count as two columns", () => {
    const rows = wrap("日本語のテキストを折り返す", 8);
    expect(rows).toEqual(["日本語の", "テキスト", "を折り返", "す"]);
    expect(rows.every((r) => visibleWidth(r) <= 8)).toBe(true);
  });

  test("clip keeps the colours and closes them", () => {
    expect(clip("\u001b[32mabcdefghij\u001b[0m", 4)).toBe("\u001b[32mabcd\u001b[0m");
    expect(clip("short", 10)).toBe("short");
  });

  test("nothing is lost: every wrapped row is within the width, whatever the text", () => {
    let seed = 7;
    const next = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    const words = ["a", "bb", "ccc", "日本", "😀", "\u001b[1mbold\u001b[0m", "x".repeat(30), " "];
    for (let n = 0; n < 300; n++) {
      const line = Array.from({ length: 1 + (next() % 20) }, () => words[next() % words.length]!).join(next() % 2 ? " " : "");
      const width = 5 + (next() % 30);
      const rows = wrap(line, width);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(visibleWidth(r)).toBeLessThanOrEqual(width);
      expect(strip(rows.join("")).replace(/\s/g, "")).toBe(strip(line).replace(/\s/g, ""));
    }
  });
});

describe("line editor", () => {
  test("typing, cursor movement, backspace and delete", () => {
    const e = new LineEditor();
    press(e, text("hello"), named("left"), named("left"), text("X"), named("backspace"), named("delete"));
    expect(e.text).toBe("helo");
    press(e, named("home"), text(">"), named("end"), text("<"));
    expect(e.text).toBe(">helo<");
  });

  test("Enter returns the line and empties the box; the line is remembered once", () => {
    const e = new LineEditor();
    press(e, text("first"));
    expect(e.apply(named("enter"))).toEqual({ handled: true, submit: "first" });
    expect(e.text).toBe("");
    press(e, text("first"));
    e.apply(named("enter"));
    expect(e.history).toEqual(["first"]);
    expect(e.apply(named("enter"))).toEqual({ handled: true, submit: "" });
    expect(e.history).toEqual(["first"]);
  });

  test("word movement and deletion, and killing to the ends of the line", () => {
    const e = new LineEditor();
    press(e, text("one two three"), ctrl("w"));
    expect(e.text).toBe("one two ");
    press(e, { kind: "alt", text: "b" }, text("X"));
    expect(e.text).toBe("one Xtwo ");
    press(e, ctrl("a"), ctrl("k"));
    expect(e.text).toBe("");
    press(e, text("abc def"), named("left", { ctrl: true }), ctrl("u"));
    expect(e.text).toBe("def");
  });

  test("history: Up recalls older lines, Down comes back, and the unfinished text is restored", () => {
    const e = new LineEditor();
    for (const l of ["one", "two", "three"]) { press(e, text(l)); e.apply(named("enter")); }
    press(e, text("draft"), named("up"));
    expect(e.text).toBe("three");
    press(e, named("up"), named("up"), named("up"));
    expect(e.text).toBe("one");
    press(e, named("down"), named("down"));
    expect(e.text).toBe("three");
    press(e, named("down"));
    expect(e.text).toBe("draft");
  });

  test("a new line with Alt+Enter, and Up and Down move between the lines before touching history", () => {
    const e = new LineEditor();
    press(e, text("first line"), named("enter", { alt: true }), text("second"));
    expect(e.text).toBe("first line\nsecond");
    press(e, named("up"));
    expect(e.cursor).toBe(6);
    press(e, named("down"));
    expect(e.cursor).toBe(17);
  });

  test("a paste keeps its line breaks, drops one trailing break, and does not submit", () => {
    const e = new LineEditor();
    expect(e.apply({ kind: "paste", text: "a\r\nb\n" })).toEqual({ handled: true });
    expect(e.text).toBe("a\nb");
  });

  test("Ctrl+C clears the text, and on an empty line asks to interrupt; Ctrl+D on an empty line means end of input", () => {
    const e = new LineEditor();
    press(e, text("abc"));
    expect(e.apply(ctrl("c"))).toEqual({ handled: true });
    expect(e.text).toBe("");
    expect(e.apply(ctrl("c"))).toEqual({ handled: true, interrupt: true });
    expect(e.apply(ctrl("d"))).toEqual({ handled: true, eof: true });
    press(e, text("ab"), named("home"));
    e.apply(ctrl("d"));
    expect(e.text).toBe("b");
  });

  test("keys it does not use are left for others", () => {
    const e = new LineEditor();
    expect(e.apply(named("escape")).handled).toBe(false);
    expect(e.apply(named("tab", { shift: true })).handled).toBe(false);
    expect(e.apply(named("pageup")).handled).toBe(false);
    expect(e.apply({ kind: "wheel", direction: "up" }).handled).toBe(false);
  });

  test("layout: the prompt opens the first row, long text wraps under it, and the cursor follows", () => {
    const e = new LineEditor();
    press(e, text("abcdefghij"));
    const l = e.layout("> ", 2, 8);
    expect(l.rows).toEqual(["> abcdef", "  ghij"]);
    expect(l.cursor).toEqual({ row: 1, col: 6 });
    press(e, named("home"));
    expect(e.layout("> ", 2, 8).cursor).toEqual({ row: 0, col: 2 });
  });

  test("layout: a cursor at the very end of a full row moves to a fresh row, wide characters count double, and an empty box shows the placeholder", () => {
    const e = new LineEditor();
    press(e, text("abcdef"));
    expect(e.layout("> ", 2, 8).cursor).toEqual({ row: 1, col: 2 });
    const w = new LineEditor();
    press(w, text("日本語"));
    expect(w.layout("> ", 2, 8).rows).toEqual(["> 日本語", "  "]);
    expect(w.layout("> ", 2, 8).cursor).toEqual({ row: 1, col: 2 });
    expect(w.layout("> ", 2, 9).cursor).toEqual({ row: 0, col: 8 });
    const empty = new LineEditor().layout("> ", 2, 20, "Ask anything");
    expect(empty.rows).toEqual(["> Ask anything"]);
    expect(empty.cursor).toEqual({ row: 0, col: 2 });
  });
});

describe("transcript", () => {
  test("streamed text grows the open line; a newline closes it", () => {
    const t = new Transcript();
    t.write("Hel");
    t.write("lo");
    expect(t.view(20, 3, 0)).toEqual(["Hello", "", ""]);
    t.write(" there\nnext");
    expect(t.view(20, 3, 0)).toEqual(["Hello there", "next", ""]);
  });

  test("only colours survive: cursor moves, screen clears and other controls are removed", () => {
    expect(sanitize("a\u001b[2Jb\u001b[31mred\u001b[0m\u001b[1A\u001b]0;title\u0007c\u0008d\te")).toBe("ab\u001b[31mred\u001b[0mcd    e");
  });

  test("a carriage return rewrites the open line, as a progress line does", () => {
    const t = new Transcript();
    t.write("10%\r50%\r100%\n");
    expect(t.view(20, 2, 0)).toEqual(["100%", ""]);
  });

  test("short content sits at the top; long content shows the newest rows, and scrolling back moves the window", () => {
    const t = new Transcript();
    for (let i = 1; i <= 10; i++) t.write(`line ${i}\n`);
    expect(t.view(20, 4, 0)).toEqual(["line 8", "line 9", "line 10", ""]);
    expect(t.view(20, 4, 2)).toEqual(["line 6", "line 7", "line 8", "line 9"]);
    expect(t.view(20, 4, 999)).toEqual(["line 1", "line 2", "line 3", "line 4"]);
    expect(t.maxBack(20, 4)).toBe(7);
  });

  test("wrapping follows the width, so a resize re-flows the whole conversation", () => {
    const t = new Transcript();
    t.write("aaa bbb ccc ddd\n");
    expect(t.view(7, 4, 0)).toEqual(["aaa bbb", "ccc ddd", "", ""]);
    expect(t.view(40, 2, 0)).toEqual(["aaa bbb ccc ddd", ""]);
  });

  test("live lines sit under the conversation, move the newest rows up, never become history, and go away when emptied", () => {
    const t = new Transcript();
    t.write("one\ntwo\n");
    t.setLive(["working", "next: x"]);
    expect(t.view(20, 6, 0)).toEqual(["one", "two", "", "working", "next: x", ""]);
    expect(t.view(20, 3, 0)).toEqual(["", "working", "next: x"]);
    t.setLive(["spinner 2"]);
    expect(t.view(20, 4, 0)).toEqual(["one", "two", "", "spinner 2"]);
    t.setLive([]);
    expect(t.view(20, 4, 0)).toEqual(["one", "two", "", ""]);
    expect(t.totalRows(20)).toBe(3);
    t.setLive(["x"]);
    t.clear();
    expect(t.view(20, 2, 0)).toEqual(["", ""]);
  });

  test("live lines are wrapped to the width and cannot move the cursor", () => {
    const t = new Transcript();
    t.setLive(["aaa bbb ccc\u001b[2J"]);
    expect(t.view(7, 3, 0)).toEqual(["", "", ""].slice(0, 1).concat(["aaa bbb", "ccc"]));
  });

  test("it keeps a bounded history", () => {
    const t = new Transcript();
    for (let i = 0; i < 25_000; i++) t.write(`row ${i}\n`);
    expect(t.lineCount).toBeLessThanOrEqual(20_000);
    expect(t.view(20, 2, 0)[0]).toBe("row 24999");
  });
});

describe("frame", () => {
  const editor = (s = ""): ReturnType<LineEditor["layout"]> => { const e = new LineEditor(); e.setText(s); return e.layout("> ", 2, 30); };
  const base = (over: Partial<Parameters<typeof composeFrame>[0]> = {}) => {
    const transcript = new Transcript();
    transcript.write("hello\n");
    return composeFrame({ cols: 30, rows: 10, transcript, back: 0, input: editor("hi"), status: "status", rule: "---", scrolledRule: "^^^", ...over });
  };

  test("conversation on top, then rule, input, rule and status; the cursor is in the input", () => {
    const f = base();
    expect(f.rows).toHaveLength(10);
    expect(f.rows[0]).toBe("hello");
    expect(f.rows.slice(-4)).toEqual(["---", "> hi", "---", "status"]);
    expect(f.cursor).toEqual({ row: 7, col: 4 });
  });

  test("scrolled back, the top rule says how to return", () => {
    const transcript = new Transcript();
    for (let i = 0; i < 30; i++) transcript.write(`l${i}\n`);
    expect(composeFrame({ cols: 30, rows: 10, transcript, back: 5, input: editor(), status: "", rule: "---", scrolledRule: "^^^" }).rows[6]).toBe("^^^");
  });

  test("a list of suggestions covers the bottom of the conversation and leaves the text cursor where it is", () => {
    const f = base({ overlay: ["one", "two"] });
    expect(f.rows.slice(4, 6)).toEqual(["one", "two"]);
    expect(f.rows[0]).toBe("hello");
    expect(f.cursor).toBeDefined();
  });

  test("a menu replaces the whole conversation, from the top, and hides the text cursor", () => {
    const f = base({ overlay: ["one", "two"], modal: true });
    expect(f.rows.slice(0, 3)).toEqual(["one", "two", ""]);
    expect(f.rows).not.toContain("hello");
    expect(f.rows.slice(-4)).toEqual(["---", "> hi", "---", "status"]);
    expect(f.cursor).toBeUndefined();
  });

  test("a long input grows the box up to a limit and then scrolls inside it", () => {
    expect(maxInputRows(24)).toBe(6);
    expect(maxInputRows(8)).toBe(2);
    expect(viewportRows(24, 1)).toBe(20);
    expect(viewportRows(24, 99)).toBe(15);
    const e = new LineEditor();
    e.setText(Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n"));
    const f = base({ rows: 24, input: e.layout("> ", 2, 30) });
    expect(f.rows).toHaveLength(24);
    expect(f.rows[f.cursor!.row]).toContain("line19");
  });

  test("the scrolled-back rule and a long rule never outgrow the row", () => {
    const transcript = new Transcript();
    for (let i = 0; i < 30; i++) transcript.write(`l${i}\n`);
    const f = composeFrame({ cols: 20, rows: 10, transcript, back: 3, input: editor(), status: "", rule: "─".repeat(60), scrolledRule: "x".repeat(90) });
    for (const r of f.rows) expect(visibleWidth(r)).toBeLessThanOrEqual(20);
  });

  test("it fits any terminal size", () => {
    for (const [cols, rows] of [[10, 4], [20, 6], [80, 3], [200, 60]] as const) {
      const f = base({ cols, rows, status: "x".repeat(300) });
      expect(f.rows.length).toBeLessThanOrEqual(rows);
      for (const r of f.rows) expect(visibleWidth(r)).toBeLessThanOrEqual(cols);
    }
  });
});

describe("menu", () => {
  const items = [{ label: "alpha", hint: "first" }, { label: "beta", hint: "second" }, { label: "gamma", hint: "third" }];
  const menu = (initial = 0) => new Menu("Pick one", items, initial, false);

  test("arrows move and wrap, a digit jumps, Enter chooses", () => {
    const m = menu();
    m.apply(named("down"));
    m.apply(named("down"));
    m.apply(named("down"));
    expect(m.apply(named("enter"))).toEqual({ done: 0 });
    m.apply(text("3"));
    expect(m.apply(named("enter"))).toEqual({ done: 2 });
    m.apply(named("up"));
    expect(m.apply(named("enter"))).toEqual({ done: 1 });
  });

  test("Left goes back, Escape and Ctrl+C cancel", () => {
    expect(menu().apply(named("left"))).toEqual({ back: true });
    expect(menu().apply(named("escape"))).toEqual({ cancel: true });
    expect(menu().apply(ctrl("c"))).toEqual({ cancel: true });
  });

  test("the wheel moves the selection", () => {
    const m = menu();
    m.apply({ kind: "wheel", direction: "down" });
    expect(m.apply(named("enter"))).toEqual({ done: 1 });
  });

  test("it shows the title, the choices with their hints, the selection mark, and the keys", () => {
    const rows = menu(1).lines(60, 20);
    expect(rows[0]).toBe("  Pick one");
    expect(rows.some((r) => /› 2  beta/.test(r))).toBe(true);
    expect(rows.some((r) => /^ {9}second/.test(r))).toBe(true);
    expect(rows.at(-1)).toMatch(/^ {2}↑ ↓ choose {3}Enter confirm/);
  });

  test("a long list is windowed to the room it has and can be narrowed by typing", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `model-${i}` }));
    const m = new Menu("Which model?", many, 0, false);
    expect(m.lines(40, 12).length).toBeLessThanOrEqual(12);
    for (const ch of "model-3") m.apply(text(ch));
    expect(m.lines(40, 30).filter((r) => r.includes("model-3")).length).toBeGreaterThan(1);
    expect(m.apply(named("enter"))).toEqual({ done: 3 });
    for (const ch of "zzz") m.apply(text(ch));
    expect(m.lines(40, 30).some((r) => r.includes("Nothing matches"))).toBe(true);
    expect(m.apply(named("enter"))).toBeUndefined();
    m.apply(named("escape"));
    m.apply(named("escape"));
    expect(m.apply(named("escape"))).toEqual({ cancel: true });
  });

  test("every row fits the width", () => {
    for (const r of new Menu("A very long title that goes on and on", items, 0, true).lines(20, 10)) expect(visibleWidth(r)).toBeLessThanOrEqual(20);
  });

  test("numbered: false drops the digits (the title already makes the choice obvious) and the digit jump with them", () => {
    const m = new Menu("Which model?", items, 0, false, { numbered: false });
    const rows = m.lines(60, 20);
    expect(rows.some((r) => /›\s+alpha/.test(r))).toBe(true);
    expect(rows.some((r) => /\d\s+alpha/.test(r))).toBe(false);
    m.apply(text("3"));
    expect(m.apply(named("enter"))).toEqual({ done: 0 });
  });
});

describe("secret field", () => {
  test("it shows how many characters arrived, never the characters", () => {
    const s = new Secret("Paste your key", false);
    s.apply({ kind: "paste", text: "sk-abcdef" });
    expect(s.lines(60).join("\n")).toContain("9 characters");
    expect(s.lines(60).join("\n")).not.toContain("abcdef");
    expect(s.apply(named("enter"))).toEqual({ done: "sk-abcdef" });
  });

  test("Backspace edits, and Left or Backspace on an empty field goes back", () => {
    const s = new Secret("Key", false);
    s.apply(text("ab"));
    s.apply(named("backspace"));
    expect(s.apply(named("enter"))).toEqual({ done: "a" });
    expect(new Secret("Key", false).apply(named("left"))).toEqual({ back: true });
    expect(new Secret("Key", false).apply(named("escape"))).toEqual({ cancel: true });
  });
});

describe("suggestion rows", () => {
  const list = [{ label: "/help", hint: "Show this list", insert: "/help", run: true }, { label: "/mode <x>", hint: "Switch mode", insert: "/mode ", run: false }];
  test("a mark on the selected one, names aligned, and what Enter will do", () => {
    const rows = suggestionLines(list, 0, 60, 10, false);
    expect(rows[0]).toBe("  › /help       Show this list");
    expect(rows[1]).toBe("    /mode <x>   Switch mode");
    expect(rows.at(-1)).toMatch(/Enter run/);
    expect(suggestionLines(list, 1, 60, 10, false).at(-1)).toMatch(/Enter complete/);
  });

  test("a hint is a quick cue, the first sentence, cut at a word when even that is too wide (not mid-word)", () => {
    const long = [{ label: "/mode <name>", hint: "Switch mode (or press Shift+Tab). Ask approves each change, Edits lets file edits through.", insert: "/mode ", run: false }];
    const row = suggestionLines(long, 0, 60, 10, false)[0]!;
    expect(row).toContain("Switch mode (or press Shift+Tab).");
    expect(row).not.toContain("Ask approves");
    const narrow = suggestionLines([{ label: "/x", hint: "a very long cue with no period anywhere in it at all", insert: "/x", run: false }], 0, 20, 10, false)[0]!;
    expect(narrow.endsWith("…")).toBe(true);
    expect(visibleWidth(strip(narrow))).toBeLessThanOrEqual(20);
  });

  test("a list cut short says how many more there are, like the menu does", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `/cmd${i}`, insert: `/cmd${i}`, run: true }));
    const rows = suggestionLines(many, 0, 60, 6, false);
    expect(rows.some((r) => /\d+ of 20/.test(r))).toBe(true);
    expect(suggestionLines(list, 0, 60, 10, false).some((r) => / of /.test(r))).toBe(false);
  });
});

describe("the chip row (files an @mention would attach)", () => {
  test("one chip per file, as a plain row, and a reminder of how to remove one", () => {
    const rows = chipLines([{ name: "photo.png" }, { name: "report.pdf" }], 60, false);
    expect(rows[0]).toBe("  photo.png   report.pdf");
    expect(rows[1]).toContain("2 attached");
    expect(rows[1]).toContain("Backspace");
  });

  test("nothing mentioned, nothing shown", () => {
    expect(chipLines([], 60, false)).toEqual([]);
  });
});

class FakeInput extends EventEmitter {
  raw = false;
  paused = false;
  setRawMode(on: boolean): this { this.raw = on; return this; }
  setEncoding(): this { return this; }
  resume(): this { this.paused = false; return this; }
  pause(): this { this.paused = true; return this; }
  type(s: string): void { this.emit("data", s); }
}

class FakeOutput extends EventEmitter {
  columns = 40;
  rows = 12;
  written: string[] = [];
  write(s: string): boolean { this.written.push(s); return true; }
  /** The screen as a person would see it: the last full text of each row, reconstructed from the writes. */
  screen(): string[] {
    const grid: string[] = Array<string>(this.rows).fill("");
    for (const chunk of this.written) {
      if (chunk.includes("\u001b[2J")) grid.fill("");
      for (const m of chunk.matchAll(/\u001b\[(\d+);1H\u001b\[2K([^\u001b]*(?:\u001b\[[0-9;]*m[^\u001b]*)*)/g)) grid[Number(m[1]) - 1] = strip(m[2]!).trimEnd();
    }
    return grid;
  }
  clear(): void { this.written = []; }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

function tui(over: Partial<{ mouse: boolean }> = {}) {
  const input = new FakeInput(), output = new FakeOutput();
  const t = new Tui({ input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, color: false, mouse: over.mouse ?? false });
  return { t, input, output };
}

describe("the whole-screen interface", () => {
  test("it opens the alternate screen with raw input, and closes it all again", () => {
    const { t, input, output } = tui({ mouse: true });
    t.start();
    expect(input.raw).toBe(true);
    const opening = output.written.join("");
    expect(opening).toContain("\u001b[?1049h");
    expect(opening).toContain("\u001b[?2004h");
    expect(opening).toContain("\u001b[?1000h");
    t.stop();
    expect(input.raw).toBe(false);
    const all = output.written.join("");
    expect(all.endsWith("\u001b[?2004l\u001b[?25h\u001b[?1049l")).toBe(true);
    expect(all).toContain("\u001b[?1000l");
  });

  test("it draws the conversation, the two rules, the prompt with its hint, and the status", async () => {
    const { t, output } = tui();
    t.setStatus(() => " model   Auto");
    t.setPrompt("❯ ", "Ask anything");
    t.start();
    t.write("Hello from navvied\n");
    await settle();
    const rows = output.screen();
    expect(rows[0]).toBe("Hello from navvied");
    expect(rows.slice(-4)).toEqual(["─".repeat(40), "❯ Ask anything", "─".repeat(40), " model   Auto"]);
    t.stop();
  });

  test("typed text is echoed into the conversation on Enter, and arrives as a line", async () => {
    const { t, input, output } = tui();
    t.start();
    const lines = t.lines()[Symbol.asyncIterator]();
    input.type("hello");
    await settle();
    expect(output.screen().at(-3)).toBe("❯ hello");
    input.type("\r");
    expect((await lines.next()).value).toBe("hello");
    await settle();
    expect(output.screen()[0]).toBe("❯ hello");
    t.stop();
  });

  test("a slash opens the list of commands; arrows choose; Enter runs; Escape closes it", async () => {
    const { t, input, output } = tui();
    t.setSuggest((text) => text.startsWith("/") ? { from: 0, items: [
      { label: "/help", hint: "Show this list", insert: "/help", run: true },
      { label: "/mode <x>", hint: "Switch mode", insert: "/mode ", run: false },
      { label: "/exit", hint: "Quit", insert: "/exit", run: true },
    ].filter((s) => s.label.startsWith(text)) } : undefined);
    t.start();
    const lines = t.lines()[Symbol.asyncIterator]();
    input.type("/");
    await settle();
    const shown = output.screen().join("\n");
    expect(shown).toContain("› /help");
    expect(shown).toContain("/mode <x>");
    input.type("\u001b[B\u001b[B");
    input.type("\r");
    expect((await lines.next()).value).toBe("/exit");
    input.type("/");
    await settle();
    input.type("\u001b[B\r");
    await settle();
    expect(output.screen().at(-3)).toBe("❯ /mode");
    input.type("\u001b");
    await new Promise((r) => setTimeout(r, 160));
    t.stop();
  });

  test("Escape closes the list without running anything", async () => {
    const { t, input, output } = tui();
    t.setSuggest((text) => text === "/" ? { from: 0, items: [{ label: "/help", insert: "/help", run: true }] } : undefined);
    t.start();
    input.type("/");
    await settle();
    expect(output.screen().join("\n")).toContain("› /help");
    input.type("\u001b");
    await new Promise((r) => setTimeout(r, 160));
    expect(output.screen().join("\n")).not.toContain("› /help");
    expect(output.screen().at(-3)).toBe("❯ /");
    t.stop();
  });

  test("while scrolled back the rule says how to return and fits the row exactly", async () => {
    const { t, input, output } = tui();
    t.start();
    for (let i = 1; i <= 40; i++) t.write(`line ${i}\n`);
    input.type("\u001b[5~");
    await settle();
    const rule = output.screen().find((r) => r.includes("PageDown newer output"))!;
    expect(rule.startsWith("── PageDown newer output")).toBe(true);
    expect([...rule].length).toBe(40);
    t.stop();
  });

  test("PageUp scrolls back through the conversation, a notice says how to return, and typing returns to the latest", async () => {
    const { t, input, output } = tui();
    t.start();
    for (let i = 1; i <= 40; i++) t.write(`line ${i}\n`);
    await settle();
    expect(output.screen()[0]).toBe("line 34");
    input.type("\u001b[5~");
    await settle();
    const scrolled = output.screen();
    expect(Number(scrolled[0]!.replace("line ", ""))).toBeLessThan(34);
    expect(scrolled.join("\n")).toContain("PageDown newer output");
    input.type("x");
    await settle();
    expect(output.screen()[0]).toBe("line 34");
    t.stop();
  });

  test("the wheel scrolls, and new output does not pull the view away from what is being read", async () => {
    const { t, input, output } = tui({ mouse: true });
    t.start();
    for (let i = 1; i <= 40; i++) t.write(`line ${i}\n`);
    input.type("\u001b[<64;5;5M");
    await settle();
    const before = output.screen()[0];
    t.write("line 41\nline 42\n");
    await settle();
    expect(output.screen()[0]).toBe(before);
    t.stop();
  });

  test("Esc and Shift+Tab reach the app when no list or menu is open; Ctrl+C on an empty box interrupts", async () => {
    const { t, input } = tui();
    const seen: string[] = [];
    t.onIdleKey((k) => { seen.push(k); });
    let interrupted = 0;
    t.onInterrupt(() => { interrupted++; });
    t.start();
    input.type("\u001b[Z");
    input.type("\u001b");
    await new Promise((r) => setTimeout(r, 160));
    input.type("\u0003");
    expect(seen).toEqual(["shift-tab", "escape"]);
    expect(interrupted).toBe(1);
    t.stop();
  });

  test("a menu replaces the conversation, takes the keys, and gives it back with the choice", async () => {
    const { t, input, output } = tui();
    t.start();
    const pending = t.choose("Where does the model run?", [{ label: "Here" }, { label: "Hosted" }]);
    await settle();
    expect(output.screen().join("\n")).toContain("› 1  Here");
    input.type("\u001b[B");
    input.type("\r");
    expect(await pending).toBe(1);
    await settle();
    expect(output.screen().join("\n")).not.toContain("Where does the model run?");
    const back = t.choose("Next", [{ label: "A" }]);
    input.type("\u001b[D");
    expect(await back).toBe("back");
    const cancelled = t.choose("Next", [{ label: "A" }]);
    input.type("\u001b");
    await new Promise((r) => setTimeout(r, 160));
    expect(await cancelled).toBeUndefined();
    t.stop();
  });

  test("a secret is read without being shown, then or later", async () => {
    const { t, input, output } = tui();
    t.start();
    const pending = t.secret("Paste your key");
    input.type("\u001b[200~sk-secret-value\u001b[201~");
    await settle();
    expect(output.screen().join("\n")).not.toContain("secret-value");
    input.type("\r");
    expect(await pending).toBe("sk-secret-value");
    await settle();
    expect(output.screen().join("\n")).not.toContain("secret-value");
    t.stop();
  });

  test("the lines end when the input closes (Ctrl+D) and when the interface stops", async () => {
    const a = tui();
    a.t.start();
    const lines = a.t.lines()[Symbol.asyncIterator]();
    a.input.type("\u0004");
    expect((await lines.next()).done).toBe(true);
    a.t.stop();
    const b = tui();
    b.t.start();
    const more = b.t.lines()[Symbol.asyncIterator]();
    const next = more.next();
    b.t.stop();
    expect((await next).done).toBe(true);
  });

  test("a resize redraws the whole screen at the new size", async () => {
    const { t, output } = tui();
    t.setStatus(() => "status");
    t.start();
    t.write("hello\n");
    await settle();
    output.rows = 8;
    output.columns = 30;
    output.clear();
    output.emit("resize");
    const rows = output.screen();
    expect(rows).toHaveLength(8);
    expect(rows.at(-1)).toBe("status");
    expect(rows[0]).toBe("hello");
    t.stop();
  });

  test("an escape sequence in the program's output cannot disturb the screen", async () => {
    const { t, output } = tui();
    t.start();
    t.write("before\u001b[2J\u001b[5;5Hafter\n");
    await settle();
    expect(output.screen()[0]).toBe("beforeafter");
    t.stop();
  });
});

describe("a menu that changes while it is open", () => {
  test("new choices arrive on their own, the selection can move to them, and a choice can be made for the person", async () => {
    const { t, input, output } = tui();
    output.rows = 24;
    t.start();
    let round = 0;
    const pending = t.choose("Your key", [{ label: "Open the page" }, { label: "Paste it" }], 0, { notice: ["Waiting"] }, {
      everyMs: 15,
      next: async () => {
        round++;
        if (round === 2) return { items: [{ label: "Use the key in my clipboard" }, { label: "Open the page" }, { label: "Paste it" }], at: 0 };
        if (round === 4) return { auto: 0 };
        return undefined;
      },
    });
    for (let i = 0; i < 40 && !output.screen().join("\n").includes("Use the key in my clipboard"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(output.screen().join("\n")).toContain("Use the key in my clipboard");
    expect(await pending).toBe(0);
    t.stop();
  });

  test("the updates stop when the person chooses first", async () => {
    const { t, input } = tui();
    t.start();
    let asked = 0;
    const pending = t.choose("Pick", [{ label: "A" }, { label: "B" }], 0, {}, { everyMs: 10, next: async () => { asked++; return undefined; } });
    await settle();
    input.type("\r");
    expect(await pending).toBe(0);
    const after = asked;
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toBe(after);
    t.stop();
  });
});

describe("a screen that waits", () => {
  test("it shows the steps, the program's output as it arrives, and the status, then gives back the result", async () => {
    const { t, output } = tui();
    t.start();
    let finish!: (v: string) => void;
    const pending = t.work("Finish signing in", { body: ["Sign in and press Allow."], status: "Waiting for you to sign in…" }, async ({ log }) => {
      log("Opening browser…");
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    await settle();
    const shown = output.screen().join("\n");
    expect(shown).toContain("Finish signing in");
    expect(shown).toContain("Sign in and press Allow.");
    expect(shown).toContain("Opening browser…");
    expect(shown).toContain("Waiting for you to sign in…");
    finish("done");
    expect(await pending).toBe("done");
    await settle();
    expect(output.screen().join("\n")).not.toContain("Waiting for you to sign in");
    t.stop();
  });

  test("Escape cancels it and tells the task to stop; Left goes back; a task that fails raises its error", async () => {
    const { t, input } = tui();
    t.start();
    let stopped = false;
    const cancelled = t.work("Waiting", {}, ({ signal }) => new Promise<void>((resolve) => { signal.addEventListener("abort", () => { stopped = true; resolve(); }); }));
    input.type("\u001b");
    await new Promise((r) => setTimeout(r, 160));
    expect(await cancelled).toBeUndefined();
    expect(stopped).toBe(true);
    const back = t.work("Waiting", {}, () => new Promise<void>(() => {}));
    input.type("\u001b[D");
    expect(await back).toBe("back");
    await expect(t.work("Failing", {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    t.stop();
  });

  test("the rows show the heading, a notice with its dot, the steps, only the last lines of output, and the keys", () => {
    const rows = workLines("Installing", { heading: ["Connect a model"], notice: ["Something to know"], body: ["Step one"], status: "Installing…" }, Array.from({ length: 10 }, (_, i) => `line ${i}`), 60, false);
    expect(rows[0]).toBe("  Connect a model");
    expect(rows.some((r) => r.startsWith("  ● Something to know"))).toBe(true);
    expect(rows.some((r) => r === "    Step one")).toBe(true);
    expect(rows.filter((r) => /^ {4}line \d$/.test(r))).toHaveLength(6);
    expect(rows.some((r) => r.includes("line 9"))).toBe(true);
    expect(rows.some((r) => r.includes("line 3"))).toBe(false);
    expect(rows.at(-1)).toMatch(/← back {3}Esc cancel/);
  });
});

describe("menus with a heading and a notice", () => {
  test("the heading comes first, then the notice with a dot on its first line, then the title and the choices", () => {
    const rows = new Menu("Which one?", [{ label: "A" }, { label: "B" }], 0, false, { heading: ["Connect a model", "Pick with the arrows"], notice: ["Something went wrong here", "macOS:  one command"] }).lines(60, 30);
    expect(rows.slice(0, 7)).toEqual(["  Connect a model", "  Pick with the arrows", "", "  ● Something went wrong here", "    macOS:  one command", "", "  Which one?"]);
  });

  test("a long notice wraps under its dot", () => {
    const rows = new Menu("T", [{ label: "A" }], 0, false, { notice: ["word ".repeat(30).trim()] }).lines(40, 30);
    const notice = rows.filter((r) => r.includes("word"));
    expect(notice.length).toBeGreaterThan(2);
    expect(notice[0]!.startsWith("  ● word")).toBe(true);
    expect(notice[1]!.startsWith("    word")).toBe(true);
  });

  test("a text field shows what is typed, offers an initial answer, and a notice", () => {
    const field = new Secret("API address", false, true, "https://", { notice: ["Not an address"] });
    field.apply(text("example.com"));
    const rows = field.lines(60);
    expect(rows.some((r) => r === "    https://example.com▏")).toBe(true);
    expect(rows.some((r) => r.startsWith("  ● Not an address"))).toBe(true);
    expect(field.apply(named("enter"))).toEqual({ done: "https://example.com" });
  });
});

describe("the steps page (Ctrl+O)", () => {
  test("Ctrl+O reaches the app; a page of text takes the keys, scrolls, and Esc gives the screen back", async () => {
    const { t, input, output } = tui();
    const seen: string[] = [];
    t.onIdleKey((k) => { seen.push(k); });
    t.start();
    input.type("\u000f");
    expect(seen).toEqual(["ctrl-o"]);
    const lines = Array.from({ length: 80 }, (_, i) => `step line ${i + 1}`);
    const closed = t.view("Steps", () => lines);
    await settle();
    expect(output.screen().join("\n")).toContain("step line 80");
    expect(output.screen().join("\n")).not.toContain("step line 1\n");
    input.type("\u001b[H"); // Home
    await settle();
    expect(output.screen().join("\n")).toContain("step line 1");
    input.type("\u001b[F"); // End
    await settle();
    expect(output.screen().join("\n")).toContain("step line 80");
    input.type("\u000f"); // Ctrl+O closes
    await closed;
    t.stop();
  });
});

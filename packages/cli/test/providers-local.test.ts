import { describe, expect, test } from "bun:test";
import type { EngineEvent, LocalFile, MachineInfo } from "@navvied/protocol";
import { LocalState, fileRows, items, localRows, localScreen, machineLines, ollamaRows, resultRows } from "../src/providers/local.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

type RuntimeEvent = Extract<EngineEvent, { ev: "local.runtime" }>;
type Held = Extract<EngineEvent, { ev: "local.installed" }>["items"][number];
const machine = (extra: Partial<MachineInfo> = {}): MachineInfo => ({ os: "linux", arch: "x64", gpus: [{ name: "Card", vendor: "nvidia", kind: "discrete", memoryMb: 16384 }], ramMb: 16384, disk: { path: "/m", freeMb: 217088, totalMb: 500000 }, ...extra });
const runtime = (r: Partial<RuntimeEvent> = {}): RuntimeEvent => ({ ev: "local.runtime", server: "stopped", state: "ready", version: "b11671", ...r });
const FILE: LocalFile = { repo: "owner/model-9b", page: "https://hub.example/owner/model-9b", file: "model-9b-Q4_K_M.gguf", quant: "Q4_K_M", sizeMb: 5939, parts: 1, gated: false, fit: "gpu", needMb: 7000 };
const GATED: LocalFile = { ...FILE, repo: "owner/tiny-12b", file: "tiny.gguf", gated: true, page: "https://hub.example/owner/tiny-12b", fit: "ram" };
const installed = (items_: Held[]): EngineEvent => ({ ev: "local.installed", items: items_ });
const found = (items_: LocalFile[], notes?: string[]): EngineEvent => ({ ev: "local.found", items: items_, ...(notes ? { notes } : {}) });
const held = (f: LocalFile, state: Held["state"], extra: Partial<Held> = {}): Held => ({ repo: f.repo, file: f.file, quant: f.quant, sizeMb: f.sizeMb, state, ...extra });
const fileEvent = (f: LocalFile, state: Extract<EngineEvent, { ev: "local.file" }>["state"], extra = {}): EngineEvent => ({ ev: "local.file", repo: f.repo, file: f.file, state, ...extra });

/** A hub with a machine, a runtime in some state, what is installed and the short list to start with; the rest is answered by `more`. */
function hub(o: { ollama?: Extract<EngineEvent, { ev: "local.ollama" }>; rt?: RuntimeEvent; held?: Held[]; recommended?: LocalFile[]; m?: MachineInfo; more?: (c: Record<string, unknown>) => EngineEvent | string | undefined } = {}): FakeLink {
  return new FakeLink((c) => c.cmd === "machine" ? { ev: "machine", ...(o.m ?? machine()) } : c.cmd === "local.runtime" ? (o.rt ?? runtime()) : c.cmd === "local.models" ? installed(o.held ?? []) : c.cmd === "local.recommended" ? found(o.recommended ?? []) : c.cmd === "local.ollama" ? (o.ollama ?? { ev: "local.ollama", state: "missing" }) : o.more?.(c));
}

describe("this machine", () => {
  test("a card with memory of its own, the computer's memory and the free disk, in aligned rows", () => {
    expect(machineLines(machine())).toEqual(["This machine", "GPU memory  16.0 GB", "RAM         16.0 GB", "Free disk   212.0 GB"]);
  });
  test("with no card, one memory for both, or nothing readable: said as it is, never guessed", () => {
    expect(machineLines(machine({ gpus: [] }))[1]).toBe("Graphics card  None");
    expect(machineLines(machine({ gpus: [{ name: "M", vendor: "apple", kind: "unified", memoryMb: 16384 }] }))).toEqual(["This machine", "RAM        16.0 GB", "Memory     Unified", "Free disk  212.0 GB"]);
    expect(machineLines(machine({ gpus: [{ name: "?", vendor: "unknown", kind: "unknown" }] }))[1]).toBe("GPU memory  Unknown");
    expect(machineLines(undefined)).toEqual(["This machine", "Memory could not be read."]);
  });
});

describe("the runtime row", () => {
  const first = (rt?: Partial<RuntimeEvent>): [string, string | undefined][] => { const s = new LocalState(); if (rt) s.runtime = runtime(rt); return localRows(s).slice(0, 2).map((r) => [r.label, r.hint]); };
  test("not installed: the release, and Install runtime", () => {
    expect(first({ state: "none" })[0]).toEqual(["Install runtime", "llama.cpp b11671"]);
  });
  test("while it downloads it says how far, in the web's words, and offers Cancel", () => {
    expect(first({ state: "installing", bytes: 131_000_000, total: 312_000_000 })[0]).toEqual(["Cancel", "Downloading 131 of 312 MB"]);
  });
  test("checking, failed (with the reason, and a way to try again)", () => {
    expect(first({ state: "verifying" })[0]).toEqual(["Checking the download", undefined]);
    expect(first({ state: "failed", error: "The download is damaged and was deleted." })[0]).toEqual(["Try again", "The download is damaged and was deleted."]);
    expect(first({ state: "failed" })[0]![1]).toBe("The download failed.");
  });
  test("ready: the release and whether it runs; Stop server while it runs; Remove runtime always", () => {
    expect(first({ state: "ready" })).toEqual([["llama.cpp b11671", "Stopped"], ["Remove runtime", undefined]]);
    expect(first({ state: "ready", server: "running" })).toEqual([["llama.cpp b11671", "Running"], ["Stop server", undefined]]);
    const s = new LocalState();
    s.runtime = runtime({ server: "running" });
    expect(localRows(s).slice(0, 3).map((r) => r.label)).toEqual(["llama.cpp b11671", "Stop server", "Remove runtime"]);
  });
});

describe("the screen", () => {
  test("it asks the hub for the machine, the runtime, the models and the short list to start with", async () => {
    const link = hub({ recommended: [FILE] });
    const t = scripted([undefined]);
    expect(await localScreen(t.kit(link))).toBe("back");
    expect(link.sent).toEqual([{ cmd: "machine" }, { cmd: "local.runtime" }, { cmd: "local.models" }, { cmd: "local.ollama" }, { cmd: "local.recommended" }]);
    expect(t.shown[0]!.frame.body).toEqual(machineLines(machine()));
    expect(t.shown[0]!.items.map((i) => [i.label, i.hint])).toEqual([["llama.cpp b11671", "Stopped"], ["Remove runtime", undefined], ["Get Ollama", "Not installed. https://ollama.com/download"], ["Search Hugging Face", undefined], ["owner/model-9b  Q4_K_M", "Fits your GPU. 5.8 GB"]]);
  });
  test("the list is the short list, then what is here and was not in it", () => {
    const s = new LocalState();
    s.found = { items: [FILE], notes: [], query: "" };
    s.feed(installed([held({ ...FILE, repo: "owner/other", file: "o.gguf" }, "done"), held(FILE, "done")]));
    expect(items(s).map((i) => i.f.repo)).toEqual(["owner/model-9b", "owner/other"]);
    s.found = { items: [FILE], notes: [], query: "model" };
    expect(items(s).map((i) => i.f.repo)).toEqual(["owner/model-9b"]);
  });
  test("what is here comes in name order with numbers read as numbers, so 9b before 14b", () => {
    const s = new LocalState();
    s.feed(installed([{ repo: "o/m-14b", file: "a", quant: "Q4", sizeMb: 1, state: "done" }, { repo: "o/m-9b", file: "b", quant: "Q4", sizeMb: 1, state: "done" }]));
    expect(items(s).map((i) => i.f.repo)).toEqual(["o/m-9b", "o/m-14b"]);
  });
  test("in a cloud session the hub refuses and the sentence is said, with no list", async () => {
    const link = new FakeLink(() => "This is only available on a computer, not in Navvied Cloud.");
    const t = scripted([]);
    const kit = t.kit(link);
    expect(await localScreen(kit)).toBe("back");
    expect(kit.note).toEqual(["This is only available on a computer, not in Navvied Cloud."]);
    expect(t.shown).toEqual([]);
  });
  test("installing the runtime, cancelling it and removing it are commands; a refusal is said on the next screen", async () => {
    const link = hub({ rt: runtime({ state: "none" }), more: (c) => c.cmd === "local.runtime.install" ? "There is not enough free disk space." : undefined });
    const t = scripted(["Install runtime", undefined]);
    await localScreen(t.kit(link));
    expect(t.shown[1]!.frame.notice).toEqual(["There is not enough free disk space."]);
    const link2 = hub({ more: (c) => c.cmd === "local.runtime.remove" ? runtime({ state: "none" }) : undefined });
    await localScreen(scripted(["Remove runtime", undefined]).kit(link2));
    expect(link2.commands("local.runtime.remove")).toHaveLength(1);
    const link3 = hub({ rt: runtime({ server: "running" }), more: (c) => c.cmd === "local.stop" ? { ev: "local.server", state: "stopped" } : undefined });
    await localScreen(scripted(["Stop server", undefined]).kit(link3));
    expect(link3.commands("local.stop")).toHaveLength(1);
  });
  test("the list follows the hub while it is open: the runtime's progress moves with no key pressed", async () => {
    const link = hub({ rt: runtime({ state: "installing", bytes: 0, total: 312_000_000 }), more: (c) => c.cmd === "local.runtime.cancel" ? runtime({ state: "none" }) : undefined });
    const t = scripted([{ label: "Cancel", before: () => link.emit(runtime({ state: "installing", bytes: 131_000_000, total: 312_000_000 })) }, undefined]);
    await localScreen(t.kit(link));
    expect(t.shown[0]!.items[0]!.hint).toBe("Downloading 131 of 312 MB");
  });
});

describe("Ollama", () => {
  const ready = (models: { name: string; tools?: boolean }[] = []): Extract<EngineEvent, { ev: "local.ollama" }> => ({ ev: "local.ollama", state: "ready", version: "0.12.3", models });
  const rowsOf = (o?: Extract<EngineEvent, { ev: "local.ollama" }>, pulling?: Extract<EngineEvent, { ev: "local.ollama.model" }>, name = ""): [string, string | undefined][] => { const s = new LocalState(); if (o) s.feed(o); if (pulling) s.feed(pulling); s.ollamaName = name; return ollamaRows(s).map((r) => [r.label, r.hint]); };
  test("nothing is said until the hub has answered; not installed says where to get it", () => {
    expect(rowsOf()).toEqual([]);
    expect(rowsOf({ ev: "local.ollama", state: "missing" })).toEqual([["Get Ollama", "Not installed. https://ollama.com/download"]]);
  });
  test("ready: its version, its models (those without tools say so), a name to fetch one by, and Download", () => {
    expect(rowsOf(ready([{ name: "qwen3:14b", tools: true }, { name: "tiny:1b", tools: false }, { name: "other" }]))).toEqual([
      ["Ollama 0.12.3", "Ready"], ["qwen3:14b", undefined], ["tiny:1b", "No tools"], ["other", undefined], ["Model name", "qwen3:14b"], ["Download", undefined],
    ]);
    expect(rowsOf(ready(), undefined, "llama3:8b")[1]).toEqual(["Model name", "llama3:8b"]);
  });
  test("while one is fetched the name and Download give way to how far it is, and Cancel", () => {
    expect(rowsOf(ready(), { ev: "local.ollama.model", model: "llama3:8b", state: "downloading", bytes: 50, total: 200 }).slice(1)).toEqual([["Cancel", "llama3:8b  25%"]]);
  });
  test("a name is typed, Download sends it, and the screen follows the fetch", async () => {
    const link = hub({ ollama: ready(), more: (c) => c.cmd === "local.ollama.pull" ? { ev: "local.ollama.model", model: "llama3:8b", state: "downloading", bytes: 1, total: 4 } : c.cmd === "local.ollama.cancel" ? { ev: "local.ollama.model", model: "llama3:8b", state: "idle" } : undefined });
    const t = scripted(["Model name", "Download", "Cancel", undefined], ["llama3:8b"]);
    await localScreen(t.kit(link));
    expect(link.commands("local.ollama.pull")).toEqual([{ cmd: "local.ollama.pull", model: "llama3:8b" }]);
    expect(t.shown.find((x) => x.items.some((i) => i.label === "Cancel"))!.items.find((i) => i.label === "Cancel")!.hint).toBe("llama3:8b  25%");
    expect(link.commands("local.ollama.cancel")).toEqual([{ cmd: "local.ollama.cancel", model: "llama3:8b" }]);
    expect(t.shown.at(-1)!.items.map((i) => i.label)).toContain("Model name");
  });
  test("Download with no name asks for one; a failed fetch is said", async () => {
    const link = hub({ ollama: ready(), more: (c) => c.cmd === "local.ollama.pull" ? { ev: "local.ollama.model", model: "nope", state: "failed", error: "Ollama does not have that model." } : undefined });
    const t = scripted(["Download", undefined], ["nope"]);
    await localScreen(t.kit(link));
    expect(t.shown[1]!.title).toBe("Model name");
    expect(t.shown.at(-1)!.frame.notice).toEqual(["Ollama does not have that model."]);
  });
});

describe("searching and downloading", () => {
  test("a result says where it runs and what it takes; a model that needs a licence says so", () => {
    expect(resultRows([FILE, GATED, { ...FILE, fit: "none", sizeMb: 158_000 }, { ...FILE, fit: undefined, sizeMb: 700 }]).map((r) => [r.label, r.hint])).toEqual([
      ["owner/model-9b  Q4_K_M", "Fits your GPU. 5.8 GB"],
      ["owner/tiny-12b  Q4_K_M", "Uses system RAM. Needs your token"],
      ["owner/model-9b  Q4_K_M", "Too big for this machine. 154.3 GB"],
      ["owner/model-9b  Q4_K_M", "0.7 GB"],
    ]);
  });
  test("a search replaces the list; the hub's notes stay above it; Download, then the file's own screen shows how far it is, and Pause stops it", async () => {
    const link = hub({ recommended: [GATED], more: (c) => c.cmd === "local.search" ? found([FILE], ["One repository could not be read."]) : c.cmd === "local.pull" ? fileEvent(FILE, "downloading", { bytes: 1_048_576_000, total: 6_227_000_000 }) : c.cmd === "local.pause" ? fileEvent(FILE, "paused", { bytes: 1_048_576_000, total: 6_227_000_000 }) : undefined });
    const t = scripted(["Search Hugging Face", "owner/model-9b  Q4_K_M", "Download 5.8 GB", "Pause", undefined, undefined, undefined], ["model"]);
    await localScreen(t.kit(link));
    expect(link.commands("local.search")).toEqual([{ cmd: "local.search", query: "model" }]);
    expect(link.commands("local.pull")).toEqual([{ cmd: "local.pull", repo: FILE.repo, file: FILE.file }]);
    const list = t.shown.find((s) => s.title === "Local Models" && s.items.some((i) => i.label.startsWith("owner/model-9b")))!;
    expect(list.items.map((i) => i.label)).not.toContain("owner/tiny-12b  Q4_K_M");
    expect(list.frame.body).toContain("One repository could not be read.");
    const start = t.shown.find((s) => s.title === "owner/model-9b")!;
    expect(start.frame.body).toEqual(["owner/model-9b  Q4_K_M", "Fits your GPU, 6.8 GB of memory."]);
    const progress = t.shown.filter((s) => s.title === "owner/model-9b")[1]!;
    expect(progress.items.map((i) => i.label)).toEqual(["Pause", "Cancel"]);
    expect(progress.frame.body).toContain("1.0 of 6.2 GB");
    expect(progress.frame.body!.at(-1)).toMatch(/^█+░+ +17%$/);
    expect(t.shown.filter((s) => s.title === "owner/model-9b").at(-1)!.items.map((i) => i.label)).toEqual(["Resume", "Cancel"]);
  });
  test("a search that finds nothing says so", async () => {
    const link = hub({ more: (c) => c.cmd === "local.search" ? found([]) : undefined });
    const t = scripted(["Search Hugging Face", undefined], ["zzz"]);
    await localScreen(t.kit(link));
    expect(t.shown.at(-1)!.frame.notice).toEqual(["No model found."]);
  });
  test("an empty search goes back to the short list", async () => {
    const link = hub({ recommended: [FILE], more: (c) => c.cmd === "local.search" ? found([GATED]) : undefined });
    const t = scripted(["Search Hugging Face", "Search Hugging Face", undefined], ["tiny", ""]);
    await localScreen(t.kit(link));
    expect(link.commands("local.recommended")).toHaveLength(2);
    expect(t.shown.at(-1)!.items.map((i) => i.label)).toContain("owner/model-9b  Q4_K_M");
  });
  test("not enough disk is said before anything is fetched, and the file's screen closes", async () => {
    const link = hub({ recommended: [FILE], more: (c) => c.cmd === "local.pull" ? fileEvent(FILE, "nodisk", { error: "Not enough free disk space: 6 GB needed, 8.1 GB free." }) : undefined });
    const t = scripted(["owner/model-9b  Q4_K_M", "Download 5.8 GB", undefined]);
    await localScreen(t.kit(link));
    expect(t.shown.at(-1)!.frame.notice).toEqual(["Not enough free disk space: 6 GB needed, 8.1 GB free."]);
  });
  test("a model that needs a licence: where to accept it, the token hidden and saved for the hub, then the download", async () => {
    const link = hub({ recommended: [GATED], more: (c) => c.cmd === "provider.save" ? { ev: "providers", items: [{ id: "huggingface", key: true }] } : c.cmd === "local.pull" ? fileEvent(GATED, "downloading", { bytes: 1, total: 100 }) : c.cmd === "local.pause" ? fileEvent(GATED, "paused", { bytes: 1, total: 100 }) : undefined });
    const t = scripted(["owner/tiny-12b  Q4_K_M", "Needs your token", "Pause", undefined, undefined], ["hf_secret"]);
    await localScreen(t.kit(link));
    expect(link.commands("provider.save")).toEqual([{ cmd: "provider.save", id: "huggingface", key: "hf_secret" }]);
    expect(link.commands("local.pull")).toHaveLength(1);
    const ask = t.shown.find((s) => s.title === "Hugging Face token")!;
    expect(ask.frame.body).toEqual(["Accept the licence on Hugging Face first.", "Open the licence page: https://hub.example/owner/tiny-12b", "hf_..."]);
    expect(JSON.stringify(t.shown)).not.toContain("hf_secret");
  });
  test("a token the hub refuses is said and nothing is fetched", async () => {
    const link = hub({ recommended: [GATED], more: (c) => c.cmd === "provider.save" ? "The provider did not accept the key." : undefined });
    const t = scripted(["owner/tiny-12b  Q4_K_M", "Needs your token", undefined, undefined], ["hf_bad"]);
    await localScreen(t.kit(link));
    expect(link.commands("local.pull")).toEqual([]);
  });
});

describe("a model on this computer", () => {
  const heldOf = (state: Held["state"], extra: Partial<Held> = {}): Held[] => [held(FILE, state, extra)];
  const state = (items_: Held[], server?: Extract<EngineEvent, { ev: "local.server" }>): LocalState => { const s = new LocalState(); s.feed(installed(items_)); if (server) s.feed(server); return s; };
  const labels = (s: LocalState) => fileRows(s, { f: FILE }).map((r) => r.label);
  test("what can be done follows its state", () => {
    expect(labels(new LocalState())).toEqual(["Download 5.8 GB"]);
    expect(labels(state(heldOf("done")))).toEqual(["Run", "Remove"]);
    expect(labels(state(heldOf("downloading", { bytes: 1, total: 2 })))).toEqual(["Pause", "Cancel"]);
    expect(labels(state(heldOf("paused")))).toEqual(["Resume", "Cancel"]);
    expect(labels(state(heldOf("nodisk")))).toEqual(["Cancel"]);
    expect(labels(state(heldOf("failed")))).toEqual(["Download 5.8 GB"]);
    expect(labels(state(heldOf("done"), { ev: "local.server", state: "running", repo: FILE.repo, file: FILE.file }))).toEqual(["Stop", "Remove"]);
  });
  test("a model that needs a licence offers the token, not the download", () => {
    expect(fileRows(new LocalState(), { f: GATED }).map((r) => r.label)).toEqual(["Needs your token"]);
  });
  test("a file that goes idle is gone from the list", () => {
    const s = state(heldOf("done"));
    s.feed(fileEvent(FILE, "idle"));
    expect(s.held.size).toBe(0);
  });
  test("a file event for something not listed yet keeps what the search said of it", () => {
    const s = new LocalState();
    s.remember([FILE]);
    s.feed(fileEvent(FILE, "downloading", { bytes: 10, total: 100 }));
    expect(s.get(FILE.repo, FILE.file)).toMatchObject({ quant: "Q4_K_M", sizeMb: 5939, state: "downloading", bytes: 10, total: 100 });
  });
  test("Run starts it and the list then says Running; Stop stops it", async () => {
    const link = hub({ held: heldOf("done"), more: (c) => c.cmd === "local.run" ? { ev: "local.server", state: "running", repo: FILE.repo, file: FILE.file } : c.cmd === "local.stop" ? { ev: "local.server", state: "stopped" } : undefined });
    const t = scripted(["owner/model-9b  Q4_K_M", "Run", "Stop", undefined, undefined]);
    await localScreen(t.kit(link));
    expect(link.commands("local.run")).toEqual([{ cmd: "local.run", repo: FILE.repo, file: FILE.file }]);
    expect(link.commands("local.stop")).toHaveLength(1);
    expect(t.shown.find((s) => s.items[0]?.label === "Stop")!.frame.body).toContain("Running");
  });
  test("a model that does not fit is not run: the hub's sentence is said", async () => {
    const link = hub({ held: heldOf("done"), more: (c) => c.cmd === "local.run" ? "It does not fit in the memory this computer has." : undefined });
    const t = scripted(["owner/model-9b  Q4_K_M", "Run", undefined, undefined]);
    await localScreen(t.kit(link));
    expect(t.shown[2]!.frame.notice).toEqual(["It does not fit in the memory this computer has."]);
  });
  test("removing asks first, in the web's words: Keep sends nothing, Remove takes the files away and leaves the screen", async () => {
    const link = hub({ held: heldOf("done"), more: (c) => c.cmd === "local.remove" ? fileEvent(FILE, "idle") : undefined });
    const t = scripted(["owner/model-9b  Q4_K_M", "Remove", "Keep", "Remove", "Remove", undefined]);
    await localScreen(t.kit(link));
    expect(link.commands("local.remove")).toEqual([{ cmd: "local.remove", repo: FILE.repo, file: FILE.file }]);
    expect(t.shown.find((s) => s.title.startsWith("Remove owner/model-9b"))!.title).toBe("Remove owner/model-9b and its files?");
    expect(t.shown.find((s) => s.title.startsWith("Remove owner"))!.items.map((i) => i.label)).toEqual(["Keep", "Remove"]);
  });
  test("Cancel stops a download and takes what was fetched away", async () => {
    const link = hub({ held: heldOf("downloading", { bytes: 5, total: 10 }), more: (c) => c.cmd === "local.cancel" ? fileEvent(FILE, "idle") : undefined });
    const t = scripted(["owner/model-9b  Q4_K_M", "Cancel", undefined]);
    await localScreen(t.kit(link));
    expect(link.commands("local.cancel")).toHaveLength(1);
  });
  test("the screen of a file keeps up with it: a download that finishes turns into Run and Remove with no key pressed", async () => {
    const link = hub({ held: heldOf("downloading", { bytes: 5, total: 10 }) });
    const t = scripted([
      "owner/model-9b  Q4_K_M",
      { label: undefined, before: () => link.emit(fileEvent(FILE, "done")) },
      undefined,
    ]);
    await localScreen(t.kit(link));
    const screen = t.shown.find((s) => s.title === "owner/model-9b")!;
    expect(screen.items.map((i) => i.label)).toEqual(["Run", "Remove"]);
    expect(link.commands("local.pause")).toEqual([]);
  });
  test("a failed download shows its reason in words", () => {
    const s = state(heldOf("failed", { error: "The connection was lost." }));
    expect(localRows(s).at(-1)!.hint).toBe("The connection was lost.");
  });
});

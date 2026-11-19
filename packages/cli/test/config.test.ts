import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointsDir, configPath, loadConfig, resolveModel, sessionsDir, type ConfigFile } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "navvied-cfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: unknown) => { const p = join(dir, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };

describe("paths", () => {
  test("flag > NAVVIED_CONFIG > XDG > home", () => {
    expect(configPath({ HOME: "/h" }, "/flag.json", "linux")).toBe("/flag.json");
    expect(configPath({ HOME: "/h", NAVVIED_CONFIG: "/env.json" }, undefined, "linux")).toBe("/env.json");
    expect(configPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, undefined, "linux")).toBe("/x/navvied/config.json");
    expect(configPath({ HOME: "/h" }, undefined, "linux")).toBe("/h/.config/navvied/config.json");
  });
  test("sessions live in the state directory", () => {
    expect(sessionsDir({ HOME: "/h" }, "linux")).toBe("/h/.local/state/navvied/sessions");
    expect(sessionsDir({ HOME: "/h", XDG_STATE_HOME: "/s" }, "linux")).toBe("/s/navvied/sessions");
  });
});

describe("paths on each platform", () => {
  test("Windows uses APPDATA for the configuration and LOCALAPPDATA for state, with backslashes", () => {
    const env = { USERPROFILE: "C:\\Users\\ana", APPDATA: "C:\\Users\\ana\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" };
    expect(configPath(env, undefined, "win32")).toBe("C:\\Users\\ana\\AppData\\Roaming\\navvied\\config.json");
    expect(sessionsDir(env, "win32")).toBe("C:\\Users\\ana\\AppData\\Local\\navvied\\sessions");
    expect(checkpointsDir(env, "win32")).toBe("C:\\Users\\ana\\AppData\\Local\\navvied\\checkpoints");
  });
  test("Windows without APPDATA falls back to the profile folder", () => {
    expect(configPath({ USERPROFILE: "C:\\Users\\ana" }, undefined, "win32")).toBe("C:\\Users\\ana\\AppData\\Roaming\\navvied\\config.json");
  });
  test("an explicit setting still wins on every platform", () => {
    expect(configPath({ NAVVIED_CONFIG: "D:\\n.json" }, undefined, "win32")).toBe("D:\\n.json");
    expect(configPath({ HOME: "/h" }, "/flag.json", "linux")).toBe("/flag.json");
  });
});

describe("loadConfig", () => {
  test("a missing file is fine", () => expect(loadConfig(join(dir, "nope.json"))).toEqual({ ok: true, value: null }));

  test("a valid file keeps only known, well-typed fields", () => {
    const p = write("ok.json", { default: "a", models: { a: { baseUrl: "http://h/v1", model: "m", window: 4000, reasoning: "none", apiKeyEnv: "K", extra: "dropped", headers: { "x-a": "b", "x-n": 3 } } } });
    const r = loadConfig(p);
    expect(r.ok && r.value).toEqual({ default: "a", models: { a: { baseUrl: "http://h/v1", model: "m", window: 4000, reasoning: "none", apiKeyEnv: "K", headers: { "x-a": "b" } } } });
  });

  test.each([
    ["broken JSON", "{nope", /config\.json|bad\.json/],
    ["no models", { x: 1 }, /expected \{ "models"/],
    ["models is an array", { models: [] }, /expected \{ "models"/],
    ["entry not an object", { models: { a: 3 } }, /model "a" must be an object/],
    ["bad baseUrl", { models: { a: { baseUrl: "ftp://x", model: "m" } } }, /baseUrl must start with http/],
    ["missing model", { models: { a: { baseUrl: "http://h" } } }, /model is required/],
    ["bad window", { models: { a: { baseUrl: "http://h", model: "m", window: -1 } } }, /window must be a positive number/],
    ["bad reasoning", { models: { a: { baseUrl: "http://h", model: "m", reasoning: "sometimes" } } }, /reasoning must be/],
    ["command and baseUrl together", { models: { a: { command: "agent", baseUrl: "http://h" } } }, /either command or baseUrl/],
    ["empty command", { models: { a: { command: "" } } }, /command must be a non-empty string/],
    ["args not strings", { models: { a: { command: "agent", args: [1] } } }, /args must be an array of strings/],
  ])("rejects: %s", (_n, body, why) => {
    const r = loadConfig(write("bad.json", body as unknown));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(why as RegExp);
  });
});

describe("the kind of API", () => {
  test("chat, messages and ollama are accepted and kept; anything else is refused", () => {
    for (const api of ["chat", "messages", "ollama"] as const) {
      const r = loadConfig(write(`${api}.json`, { models: { a: { baseUrl: "http://h", model: "m", api } } }));
      expect(r.ok && r.value?.models.a?.api).toBe(api);
    }
    const bad = loadConfig(write("bad.json", { models: { a: { baseUrl: "http://h", model: "m", api: "x" } } }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('"ollama"');
  });
});

describe("permission rules in the file", () => {
  test("allow, ask and deny lists are read", () => {
    const r = loadConfig(write("p.json", { models: {}, permissions: { allow: ["Bash(npm run *)", "Edit(src/**)"], ask: ["Bash(git push *)"], deny: ["Edit(**/.env)"] } }));
    expect(r.ok && r.value?.permissions).toEqual({ allow: ["Bash(npm run *)", "Edit(src/**)"], ask: ["Bash(git push *)"], deny: ["Edit(**/.env)"] });
  });
  test("a wrong shape is refused in plain words", () => {
    for (const bad of [["Bash"], { allow: "Bash" }, { allow: ["not a rule("] }, { allow: [1] }, { block: ["Bash"] }]) {
      const r = loadConfig(write("p2.json", { models: {}, permissions: bad }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("permissions");
    }
  });
});

describe("hooks in the file", () => {
  test("commands per event, with a matcher and a timeout kept; unknown fields dropped", () => {
    const r = loadConfig(write("h.json", { models: {}, hooks: { PreToolUse: [{ matcher: "Bash", command: "./check.sh", timeout: 5, extra: 1 }], Stop: [{ command: "notify-done" }] } }));
    expect(r.ok && r.value?.hooks).toEqual({ PreToolUse: [{ command: "./check.sh", matcher: "Bash", timeout: 5 }], Stop: [{ command: "notify-done" }] });
  });
  test("an unknown event, a list that is not commands, or a bad shape is refused with the event's name", () => {
    for (const bad of [{ Nope: [{ command: "x" }] }, { PreToolUse: "x" }, { PreToolUse: [{}] }, { PreToolUse: [{ command: "" }] }]) {
      const r = loadConfig(write("h2.json", { models: {}, hooks: bad }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("hooks");
    }
    expect(loadConfig(write("h3.json", { models: {}, hooks: [] })).ok).toBe(false);
    const none = loadConfig(write("h4.json", { models: {}, hooks: {} }));
    expect(none.ok && none.value?.hooks).toBeUndefined();
  });
});

describe("connected programs in the file", () => {
  test("each needs a command; arguments, environment and folder are kept", () => {
    const r = loadConfig(write("mcp.json", { models: {}, mcp: { notes: { command: "notes-server", args: ["--quiet"], env: { A: "1", B: 2 }, cwd: "/work", extra: true }, files: { command: "files-server" } } }));
    expect(r.ok && r.value?.mcp).toEqual({ notes: { command: "notes-server", args: ["--quiet"], env: { A: "1" }, cwd: "/work" }, files: { command: "files-server" } });
  });
  test("an empty list is the same as none, and a damaged one is refused with the program's name", () => {
    const none = loadConfig(write("mcp0.json", { models: {}, mcp: {} }));
    expect(none.ok && none.value?.mcp).toBeUndefined();
    for (const bad of [{ notes: {} }, { notes: { command: "" } }, { notes: { command: "x", args: [1] } }, { notes: "x" }]) {
      const r = loadConfig(write("mcp1.json", { models: {}, mcp: bad }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('"notes"');
    }
    expect(loadConfig(write("mcp2.json", { models: {}, mcp: [] })).ok).toBe(false);
  });
});

describe("models inside a program, and effort levels", () => {
  test("a program lists the models it can be told to use, and a model lists the effort levels it accepts", () => {
    const r = loadConfig(write("m.json", { models: {
      p: { command: "prog", models: [{ id: "opus", name: "Opus", badge: "MAX", blurb: "Most capable", extra: 1 }, { id: "default", name: "Let it choose" }], efforts: ["low", "max"] },
      h: { baseUrl: "http://h", model: "m", reasoning: "effort" },
    } }));
    expect(r.ok && r.value?.models.p).toEqual({ command: "prog", models: [{ id: "opus", name: "Opus", badge: "MAX", blurb: "Most capable" }, { id: "default", name: "Let it choose" }], efforts: ["low", "max"] });
  });
  test("they are handed on when the model is resolved; reasoning: effort alone means low, medium, high; none means no effort", () => {
    const file = { models: { p: { command: "prog", models: [{ id: "a", name: "A" }], efforts: ["low"] as const }, h: { baseUrl: "http://h", model: "m", reasoning: "effort" as const }, n: { baseUrl: "http://h", model: "m" } } };
    const p = resolveModel("p", file as never, {}, "/x");
    expect(p.ok && p.value.cli?.models).toEqual([{ id: "a", name: "A" }]);
    expect(p.ok && p.value.efforts).toEqual(["low"]);
    const h = resolveModel("h", file as never, {}, "/x");
    expect(h.ok && h.value.efforts).toEqual(["low", "medium", "high"]);
    const n = resolveModel("n", file as never, {}, "/x");
    expect(n.ok && n.value.efforts).toBeUndefined();
  });
  test("a damaged list is refused with the model's name", () => {
    for (const bad of [{ efforts: ["ludicrous"] }, { efforts: "high" }, { models: [{ id: "x" }] }, { models: "opus" }]) {
      const r = loadConfig(write("bad2.json", { models: { a: { command: "p", ...bad } } }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('model "a"');
    }
  });
});

describe("external commands in the file", () => {
  test("a command entry needs no baseUrl, and resolves to a program to run", () => {
    const p = write("cmd.json", { models: { sub: { command: "agent", args: ["--a"], model: "big", env: { TOKEN: "x", n: 1 }, window: 9000 } } });
    const file = loadConfig(p);
    expect(file.ok && file.value?.models.sub).toEqual({ command: "agent", args: ["--a"], model: "big", env: { TOKEN: "x" }, window: 9000 });
    const r = resolveModel(undefined, file.ok ? file.value : null, {}, p);
    expect(r.ok && r.value).toEqual({ name: "sub", window: 9000, cli: { command: "agent", args: ["--a"], model: "big", env: { TOKEN: "x" } } });
  });
});

describe("resolveModel", () => {
  const file: ConfigFile = {
    default: "big",
    models: {
      big: { baseUrl: "http://h/v1", model: "big-1", window: 200_000, apiKey: "from-file", apiKeyEnv: "BIG_KEY" },
      small: { baseUrl: "http://h/v1", model: "small-1" },
    },
  };
  const R = (choice: string | undefined, f: ConfigFile | null, env: Record<string, string> = {}) => resolveModel(choice, f, env, "/cfg.json");

  test("--model wins, then the file default", () => {
    const small = R("small", file);
    expect(small.ok && small.value).toMatchObject({ name: "small", window: 128_000, provider: { model: "small-1" } });
    const big = R(undefined, file);
    expect(big.ok && big.value).toMatchObject({ name: "big", window: 200_000 });
  });
  test("the key comes from the environment variable first, then the file", () => {
    expect(R("big", file, { BIG_KEY: "from-env" }).ok && (R("big", file, { BIG_KEY: "from-env" }) as any).value.provider.apiKey).toBe("from-env");
    expect((R("big", file) as any).value.provider.apiKey).toBe("from-file");
  });
  test("a single configured model needs no default", () => {
    const one: ConfigFile = { models: { only: { baseUrl: "http://h", model: "m" } } };
    expect(R(undefined, one).ok && (R(undefined, one) as any).value.name).toBe("only");
  });
  test("several models without a default ask the user to choose", () => {
    const r = R(undefined, { models: file.models });
    expect(!r.ok && r.error).toMatch(/several models are configured \(big, small\)/);
  });
  test("an unknown name lists what exists", () => {
    const r = R("nope", file);
    expect(!r.ok && r.error).toMatch(/unknown model "nope" \(configured: big, small\)/);
  });
  test("with no file, the NAVVIED_* environment is enough", () => {
    const r = R(undefined, null, { NAVVIED_BASE_URL: "http://local/v1", NAVVIED_MODEL: "qwen", NAVVIED_API_KEY: "k", NAVVIED_WINDOW: "32768" });
    expect(r.ok && r.value).toMatchObject({ name: "qwen", window: 32768, provider: { baseUrl: "http://local/v1", model: "qwen", apiKey: "k" } });
  });
  test("nothing configured: a message that says how to fix it", () => {
    const r = R(undefined, null);
    expect(!r.ok && r.error).toMatch(/no model is configured\. Create \/cfg\.json .*NAVVIED_BASE_URL/);
  });
});

describe("how a model is shown", () => {
  test("a name, a family, a badge, a line and a lock are kept; the rest is dropped", () => {
    const r = loadConfig(write("d.json", { models: { a: { baseUrl: "http://h/v1", model: "real-id", display: { name: "Raphael Sage", brand: "raphael", badge: "FREE", blurb: "Everyday", locked: true, extra: 1 } } } }));
    expect(r.ok && r.value?.models.a?.display).toEqual({ name: "Raphael Sage", brand: "raphael", badge: "FREE", blurb: "Everyday", locked: true });
    expect(loadConfig(write("d2.json", { models: { a: { baseUrl: "http://h/v1", model: "m", display: "x" } } })).ok).toBe(false);
  });
});

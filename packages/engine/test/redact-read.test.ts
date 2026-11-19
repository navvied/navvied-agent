import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/redact.ts";
import { cleanupAll, prompt, rig, until } from "./helpers.ts";
import type { ModelRequest } from "../src/types.ts";

afterAll(cleanupAll);
const KEY = "k9Zq-3vXw_7LmPa2Rt8Yc4";
const LIVE = "sk-liveabcdefghijklmnop1234";
const PASS = "hunter2hunter2";
const ENV_FILE = `API_KEY=${LIVE}\nDB_PASSWORD="${PASS}"\nNOTE=the key is ${KEY} here\nPORT=3000\nAPI_URL=https://example.com/v1\n`;
const SECRETS = [KEY, LIVE, PASS];

const everything = (r: { events: unknown[]; provider: { requests: ModelRequest[] } }): string => JSON.stringify(r.events) + JSON.stringify(r.provider.requests);
const withKey = async <T>(run: () => Promise<T>): Promise<T> => { process.env.NAVVIED_FAKE_API_KEY = KEY; try { return await run(); } finally { delete process.env.NAVVIED_FAKE_API_KEY; } };

/** One tool call, then the answer; the call is chosen by the person's words. */
const one = (name: string, args: (dir: string) => Record<string, unknown>) => (req: ModelRequest, _n: number, dir: string) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name, args: args(dir) }] });

describe("the secrets of a file are marks to the model", () => {
  test("Read of a .env: known keys, key shapes and what the name says are hidden, ordinary values are not, and the model is told once", async () => {
    await withKey(async () => {
      const r = rig(one("Read", (d) => ({ file_path: join(d, ".env") })));
      writeFileSync(join(r.dir, ".env"), ENV_FILE);
      await r.turn(prompt("read it", { mode: "auto" }));
      for (const s of SECRETS) expect(everything(r)).not.toContain(s);
      const shown = r.of("tool").find((e) => e.status === "done")!.output!;
      expect(shown).toContain("API_KEY=[hidden:");
      expect(shown).toContain('DB_PASSWORD="[hidden:');
      expect(shown).toContain("PORT=3000");
      expect(shown).toContain("API_URL=https://example.com/v1");
      expect(shown.match(/hidden as \[hidden:N\] marks/g)).toHaveLength(1);
      expect(shown).toContain("3 secret values are hidden");
      r.cleanup();
    });
  });

  test("Grep shows the same marks", async () => {
    await withKey(async () => {
      const r = rig(one("Grep", () => ({ pattern: "KEY|PASSWORD|NOTE", path: "." })));
      writeFileSync(join(r.dir, ".env"), ENV_FILE);
      await r.turn(prompt("find them", { mode: "auto" }));
      for (const s of SECRETS) expect(everything(r)).not.toContain(s);
      expect(r.of("tool").find((e) => e.status === "done")!.output).toContain("[hidden:");
      r.cleanup();
    });
  });

  test("the same secret is the same mark, a different one is another, and the marks are the only thing saved in the conversation", () => {
    const v = new Vault();
    const a = v.hide(`A=${KEY} B=${KEY} C=${PASS}`, [KEY, PASS]).text;
    expect(a).toMatch(/^A=\[hidden:1\] B=\[hidden:1\] C=\[hidden:2\]$/);
    expect(v.restore(a)).toEqual({ text: `A=${KEY} B=${KEY} C=${PASS}`, unknown: [] });
    expect(v.restore("x [hidden:7] [hidden] y").unknown).toEqual(["[hidden:7]", "[hidden]"]);
  });

  test("a private key block and a value that looks like code are handled: the block is one mark, an identifier or a call is left alone", () => {
    const v = new Vault();
    const text = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\nconst apiKey = getApiKey(env);\nTOKEN_FIELD=token_field_name\nauth_header="Bearer ${"a".repeat(30)}"`;
    const out = v.hide(text, []).text;
    expect(out).not.toContain("MIIEvQ");
    expect(out).toContain("getApiKey(env)");
    expect(out).toContain("TOKEN_FIELD=token_field_name");
    expect(out).not.toContain("a".repeat(30));
  });
});

describe("Edit and Write work on a file around its secrets", () => {
  test("Edit with the marks from Read keeps the real values in the file and writes nothing of the placeholder", async () => {
    await withKey(async () => {
      let mark = "";
      const r = rig((req, n, dir) => {
        if (n === 0) return { calls: [{ name: "Read", args: { file_path: join(dir, ".env") } }] };
        if (n === 1) {
          const seen = JSON.stringify(req.messages);
          mark = /API_KEY=(\[hidden:\d+\])/.exec(seen.replace(/\\"/g, '"'))![1]!;
          return { calls: [{ name: "Edit", args: { file_path: join(dir, ".env"), old_string: `API_KEY=${mark}\n`, new_string: `API_KEY=${mark}\nREGION=eu\n` } }] };
        }
        return { text: "done" };
      });
      writeFileSync(join(r.dir, ".env"), ENV_FILE);
      await r.turn(prompt("add a region", { mode: "auto" }));
      expect(readFileSync(join(r.dir, ".env"), "utf8")).toBe(ENV_FILE.replace(`API_KEY=${LIVE}\n`, `API_KEY=${LIVE}\nREGION=eu\n`));
      for (const s of SECRETS) expect(everything(r)).not.toContain(s);
      expect(JSON.stringify(r.events)).toContain(`"old_string":"API_KEY=${mark}`);
      r.cleanup();
    });
  });

  test("Write of the whole file with the marks puts the values back; a mark that is not known, and a plain [hidden], are refused and the file is left as it was", async () => {
    await withKey(async () => {
      let content = "";
      const r = rig((req, n, dir) => {
        if (n === 0) return { calls: [{ name: "Read", args: { file_path: join(dir, ".env") } }] };
        if (req.messages.at(-1)?.role === "tool" && n >= 2) return { text: "done" };
        const seen = JSON.stringify(req.messages).replace(/\\"/g, '"').replace(/\\n/g, "\n");
        content = content || seen.slice(seen.indexOf("API_KEY=")).split("[").length ? "" : "";
        return { calls: [{ name: "Write", args: { file_path: join(dir, ".env"), content: n === 1 ? "API_KEY=[hidden:99]\n" : "API_KEY=[hidden]\n" } }] };
      });
      writeFileSync(join(r.dir, ".env"), ENV_FILE);
      await r.turn(prompt("rewrite", { mode: "auto" }));
      expect(readFileSync(join(r.dir, ".env"), "utf8")).toBe(ENV_FILE);
      const errors = r.of("tool").filter((e) => e.status === "error").map((e) => e.output);
      expect(errors[0]).toContain("[hidden:99] is not a value you can write");
      r.cleanup();
    });
  });

  test("Write with the real marks restores every value", async () => {
    await withKey(async () => {
      const r = rig((req, n, dir) => {
        if (n === 0) return { calls: [{ name: "Read", args: { file_path: join(dir, ".env") } }] };
        if (n === 1) {
          const seen = JSON.stringify(req.messages).replace(/\\"/g, '"').replace(/\\n/g, "\n");
          const copy = ENV_FILE.replace(LIVE, /API_KEY=(\[hidden:\d+\])/.exec(seen)![1]!).replace(PASS, /DB_PASSWORD="(\[hidden:\d+\])"/.exec(seen)![1]!).replace(KEY, /the key is (\[hidden:\d+\])/.exec(seen)![1]!);
          return { calls: [{ name: "Write", args: { file_path: join(dir, ".env"), content: `${copy}EXTRA=1\n` } }] };
        }
        return { text: "done" };
      });
      writeFileSync(join(r.dir, ".env"), ENV_FILE);
      await r.turn(prompt("rewrite", { mode: "auto" }));
      expect(readFileSync(join(r.dir, ".env"), "utf8")).toBe(`${ENV_FILE}EXTRA=1\n`);
      for (const s of SECRETS) expect(everything(r)).not.toContain(s);
      r.cleanup();
    });
  });
});

describe("a command line the model wrote", () => {
  test("a secret in it is a mark on the screen, in the approval, in its editable text and in the step's event; what runs is the command as written", async () => {
    await withKey(async () => {
      const r = rig(one("Bash", () => ({ command: `echo ${KEY} > shown.txt` })));
      r.send(prompt("save it", { mode: "ask" }));
      await until(() => r.of("approval").length === 1);
      const card = r.of("approval")[0]!;
      expect(JSON.stringify(card)).not.toContain(KEY);
      expect(card.title).toMatch(/^Run command: echo \[hidden:1\] > shown\.txt$/);
      expect(card.options.find((o) => o.editable)!.editable!.value).toBe("echo [hidden:1] > shown.txt");
      expect(JSON.stringify(card.change)).not.toContain(KEY);
      r.send({ cmd: "approve", id: card.id, optionId: "allow" });
      await r.engine.idle();
      expect(readFileSync(join(r.dir, "shown.txt"), "utf8").trim()).toBe(KEY);
      expect(everything(r).split(KEY).length - 1).toBe(JSON.stringify(r.provider.requests).split(KEY).length - 1);
      expect(JSON.stringify(r.events)).not.toContain(KEY);
      r.cleanup();
    });
  });

  test("the person edits the command with the mark in it: the real value runs", async () => {
    await withKey(async () => {
      const r = rig(one("Bash", () => ({ command: `echo ${KEY} > first.txt` })));
      r.send(prompt("save it", { mode: "ask" }));
      await until(() => r.of("approval").length === 1);
      r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "edit", input: "echo [hidden:1] > second.txt" });
      await r.engine.idle();
      expect(existsSync(join(r.dir, "first.txt"))).toBe(false);
      expect(readFileSync(join(r.dir, "second.txt"), "utf8").trim()).toBe(KEY);
      expect(JSON.stringify(r.events)).not.toContain(KEY);
      r.cleanup();
    });
  });

  test("a mark the conversation does not know is not run", async () => {
    const r = rig(one("Bash", () => ({ command: "echo hi > a.txt" })));
    r.send(prompt("go", { mode: "ask" }));
    await until(() => r.of("approval").length === 1);
    r.send({ cmd: "approve", id: r.of("approval")[0]!.id, optionId: "edit", input: "echo [hidden:42] > b.txt" });
    await r.engine.idle();
    expect(existsSync(join(r.dir, "b.txt"))).toBe(false);
    expect(r.of("tool").some((e) => /\[hidden:42\] stands for a secret/.test(e.output ?? ""))).toBe(true);
    r.cleanup();
  });
});

describe("a file the person attaches", () => {
  test("the text the model is given has its secrets as marks; the saved file is the person's own", async () => {
    await withKey(async () => {
      const attachments = mkdtempSync(join(tmpdir(), "navvied-redact-read-"));
      const r = rig(() => ({ text: "ok" }), { attachments });
      await r.turn(prompt("what is in it", { qid: "q", files: [{ name: "config.env", mime: "text/plain", data: Buffer.from(ENV_FILE).toString("base64") }] }));
      for (const s of SECRETS) expect(everything(r)).not.toContain(s);
      expect(JSON.stringify(r.provider.requests.at(-1)!.messages)).toContain("[hidden:");
      expect(readFileSync(join(attachments, r.engine.sessionId, "config.env"), "utf8")).toBe(ENV_FILE);
      r.cleanup();
    });
  });
});

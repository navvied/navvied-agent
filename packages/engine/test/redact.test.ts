import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Jobs, defaultTools } from "../src/index.ts";
import { Redactor, redact, registerSecrets, secretsNow } from "../src/redact.ts";
import type { ToolContext } from "../src/types.ts";
import { HOOK_MS, cleanupAll, prompt, rig } from "./helpers.ts";

afterAll(cleanupAll, HOOK_MS);
const bash = defaultTools().find((t) => t.name === "Bash")!;
const KEY = "k9Zq-3vXw_7LmPa2Rt8Yc4";

describe("what counts as a secret", () => {
  test("the value of a variable that is named like one, not a short value, not a path, not an ordinary variable", () => {
    const env = { PROVIDER_API_KEY: KEY, MY_TOKEN: "tok-1234567890", DB_PASSWORD: "p@ss w0rd long", SSH_AUTH_SOCK: "/tmp/ssh-abc/agent.1", MONKEY_COUNT: "12345678901", FLAG_SECRET: "1", HOME: "/home/me", PATH: "/usr/bin" };
    const found = secretsNow(env);
    expect(found).toContain(KEY);
    expect(found).toContain("tok-1234567890");
    expect(found).not.toContain("1");
    expect(found).not.toContain("/tmp/ssh-abc/agent.1");
    expect(found).not.toContain("/home/me");
    // "MONKEY" has KEY in its name, so its value counts: a name that merely contains the word is hidden, which errs on the side of safety.
    expect(found).toContain("12345678901");
  });
  test("the keys of the configuration, as the engine registers them", () => {
    registerSecrets(["cfg-key-abcdefgh12345", undefined, "short"]);
    expect(redact("the key is cfg-key-abcdefgh12345 ok")).toBe("the key is [hidden] ok");
    expect(redact("short stays")).toBe("short stays");
  });
});

describe("what a key looks like, whatever it is called", () => {
  test("the common shapes become [hidden], and ordinary text is left alone", () => {
    const shapes = ["sk-abcdefghijklmnopqrstuvwx", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github_pat_11ABCDEFG0abcdefghijklmnop", "AKIAABCDEFGHIJKLMNOP", "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345", "xoxb-1234567890-abcdefghij", "Bearer abcdefghijklmnopqrstuvwxyz0123456789"];
    for (const s of shapes) expect(redact(`value: ${s} end`, []), s).toBe("value: [hidden] end");
    for (const ordinary of ["risk-assessment-framework-2026-plan", "the task-runner is up", "disk-usage-report-for-the-month", "ask me anything", "sk-short", "list of AKIA things"]) expect(redact(ordinary, []), ordinary).toBe(ordinary);
  });
  test("a private key block is hidden whole, with its body", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQgAAAAtzc2gtZWQyNTUx\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`before\n${pem}\nafter`, [])).toBe("before\n[hidden]\nafter");
    expect(redact(`before\n-----BEGIN PRIVATE KEY-----\nMIIEvQ`, [])).toBe("before\n[hidden]");
  });
});

describe("a secret that arrives in pieces", () => {
  test("is found across the pieces, and ordinary text is not held back", () => {
    const r = new Redactor([KEY]);
    const out = [r.push("ready on port 3000\nthe key "), r.push(KEY.slice(0, 9)), r.push(KEY.slice(9)), r.push(" and more\n"), r.end()].join("");
    expect(out).toBe("ready on port 3000\nthe key [hidden] and more\n");
    const quick = new Redactor([KEY]);
    expect(quick.push("listening on http://localhost:3000\n")).toBe("listening on http://localhost:3000\n");
  });
  test("a shape begun in one piece and finished in the next is hidden; a private key over several pieces leaks none of its body", () => {
    const r = new Redactor([]);
    expect(r.push("token sk-abcdefghij") + r.push("klmnopqrstuvwxyz done")).toBe("token [hidden] done");
    const k = new Redactor([]);
    const parts = ["pre ", "-----BEGIN RSA PRIV", "ATE KEY-----\nMIIEowIBAAKCAQEA", "7x9sECRETBODY\n-----END RSA PRIVATE KEY-----\n", "post"];
    const out = parts.map((p) => k.push(p)).join("") + k.end();
    expect(out).toBe("pre [hidden]\npost");
    expect(out).not.toContain("SECRETBODY");
  });
  test("what is held is given at the end: a text that only ends like the start of a key is still shown", () => {
    const r = new Redactor([KEY]);
    expect(r.push("it ends with sk-")).toBe("it ends with ");
    expect(r.end()).toBe("sk-");
  });
});

/** The stream as a person's window would see it: everything the redactor let through, whole. */
const streamed = (secrets: string[], pieces: string[]): string => { const r = new Redactor(secrets); return pieces.map((p) => r.push(p)).join("") + r.end(); };
const LONG = "4-another-secret-value-that-starts-with-the-last-letter-of-KEY";
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
const SAMPLE = `before\nenv: ${KEY}\nshape: sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123456789\n${PEM}\nBearer abcdefghijklmnopqrstuvwxyz0123\nafter ${KEY}`;
const LEAKS = [KEY, "sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "abcdefghijklmnopqrstuvwxyz0123"];

describe("a secret split between two pieces, wherever the cut falls", () => {
  const colliding = [[KEY], [KEY, LONG], [LONG, KEY], [KEY, "9Zq-something-else", "k-x-secret-starting-like-the-end", "sk-abcdefghijklmnopqrstuvwxYZ-longer-than-the-shape"]];
  test.each(colliding)("every single cut of the text hides every secret (secrets: %p)", (...secrets) => {
    for (let i = 0; i <= SAMPLE.length; i++) {
      const out = streamed(secrets, [SAMPLE.slice(0, i), SAMPLE.slice(i)]);
      for (const leak of LEAKS) expect(out).not.toContain(leak);
      expect(out).toContain("before");
      expect(out).toContain("after [hidden]");
    }
  });
  test("every pair of cuts, and a piece of one character at a time", () => {
    const secrets = [KEY, LONG];
    for (let i = 0; i < SAMPLE.length; i += 3) for (let j = i; j <= SAMPLE.length; j += 7) {
      const out = streamed(secrets, [SAMPLE.slice(0, i), SAMPLE.slice(i, j), SAMPLE.slice(j)]);
      for (const leak of LEAKS) expect(out).not.toContain(leak);
    }
    const out = streamed(secrets, [...SAMPLE]);
    for (const leak of LEAKS) expect(out).not.toContain(leak);
    expect(out).toBe(streamed(secrets, [SAMPLE]));
  });
  test("a text that ends with the whole key, and another secret that starts like its last letter, is hidden at the end of the stream and in one piece", () => {
    expect(redact(`mine\n${KEY}`, [KEY, LONG])).toBe("mine\n[hidden]");
    expect(streamed([KEY, LONG], [`mine\n${KEY}`])).toBe("mine\n[hidden]");
    // And when the rest of the longer secret does arrive, it is hidden as one.
    expect(streamed([`${KEY}-and-more-after-it`, KEY], [`x ${KEY}`, "-and-more-after-it y"])).toBe("x [hidden] y");
  });
  test("the text between is not lost: the same characters come out, only the secrets changed", () => {
    for (let i = 0; i <= SAMPLE.length; i++) expect(streamed([KEY, LONG], [SAMPLE.slice(0, i), SAMPLE.slice(i)])).toBe(streamed([KEY, LONG], [SAMPLE]));
  });
});

describe("through Bash", () => {
  const ctx = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal, emit: () => undefined, allowPrivateNetwork: false, jobs: new Jobs(() => undefined) });
  test("env, echo and a file that holds a key never give it away; a key of a shape nobody registered is hidden too", async () => {
    process.env.NAVVIED_FAKE_API_KEY = KEY;
    // Another secret that starts like the key ends: it must not make the key look unfinished at the end of the output.
    process.env.NAVVIED_OTHER_TOKEN = LONG;
    try {
      const out = await bash.run({ command: `env; echo "$NAVVIED_FAKE_API_KEY"; echo "mine: sk-abcdefghijklmnopqrstuvwx"; printf '%s' "$NAVVIED_FAKE_API_KEY" | rev | rev` }, ctx());
      expect(out).not.toContain(KEY);
      expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwx");
      expect(out).toContain("NAVVIED_FAKE_API_KEY=[hidden]");
      expect(out).toContain("mine: [hidden]");
    } finally { delete process.env.NAVVIED_FAKE_API_KEY; delete process.env.NAVVIED_OTHER_TOKEN; }
  });
  test("what is saved to a file because it was long is hidden too", async () => {
    process.env.NAVVIED_FAKE_TOKEN = KEY;
    process.env.NAVVIED_OTHER_TOKEN = LONG;
    try {
      const out = await bash.run({ command: `echo "$NAVVIED_FAKE_TOKEN"; head -c 60000 /dev/zero | tr '\\0' 'x'; printf '%s' "$NAVVIED_FAKE_TOKEN"`, }, { ...ctx(), window: 8_000 });
      const saved = /saved in (\S+):/.exec(out)?.[1];
      expect(saved).toBeDefined();
      expect(readFileSync(saved!, "utf8")).not.toContain(KEY);
      expect(readFileSync(saved!, "utf8")).toContain("[hidden]");
      expect(out).not.toContain(KEY);
      rmSync(dirname(saved!), { recursive: true, force: true });
    } finally { delete process.env.NAVVIED_FAKE_TOKEN; delete process.env.NAVVIED_OTHER_TOKEN; }
  });
  test("a command in the background whose last write is the key, with another secret that starts like its end: BashOutput never has it", async () => {
    process.env.NAVVIED_FAKE_SECRET = KEY;
    process.env.NAVVIED_OTHER_TOKEN = LONG;
    try {
      const c = ctx();
      await bash.run({ command: `printf '%s' "\${NAVVIED_FAKE_SECRET:0:11}"; sleep 0.4; printf '%s' "\${NAVVIED_FAKE_SECRET:11}"`, run_in_background: true }, c);
      const output = defaultTools().find((t) => t.name === "BashOutput")!;
      await output.run({ job_id: "job1", wait: 10 }, c);
      await Bun.sleep(600);
      const seen = (await output.run({ job_id: "job1" }, c)) + JSON.stringify(c.jobs.list());
      expect(seen).not.toContain(KEY.slice(11));
      expect(seen).not.toContain(KEY.slice(0, 11));
      c.jobs.close();
    } finally { delete process.env.NAVVIED_FAKE_SECRET; delete process.env.NAVVIED_OTHER_TOKEN; }
  });
  test("a command in the background that prints a key in two writes: BashOutput never has it", async () => {
    process.env.NAVVIED_FAKE_SECRET = KEY;
    try {
      const c = ctx();
      await bash.run({ command: `printf '%s' "\${NAVVIED_FAKE_SECRET:0:8}"; sleep 0.4; printf '%s\\n' "\${NAVVIED_FAKE_SECRET:8}"; echo done-printing`, run_in_background: true }, c);
      const output = defaultTools().find((t) => t.name === "BashOutput")!;
      const seen = (await output.run({ job_id: "job1", wait: 10, until: "done-printing" }, c)) + (await output.run({ job_id: "job1" }, c));
      expect(seen).not.toContain(KEY);
      expect(seen).not.toContain(KEY.slice(0, 8));
      expect(seen).toContain("[hidden]");
      c.jobs.close();
    } finally { delete process.env.NAVVIED_FAKE_SECRET; }
  });
});

describe("through the engine: events", () => {
  test("nothing the engine says (the live output, the step's output, the job's last line) holds the key", async () => {
    process.env.NAVVIED_FAKE_PASSWORD = KEY;
    process.env.NAVVIED_OTHER_TOKEN = LONG;
    try {
      const r = rig((req) => (req.messages.at(-1)?.role === "tool" ? { text: "done" } : { calls: [{ name: "Bash", args: { command: `echo start; sleep 0.3; echo "$NAVVIED_FAKE_PASSWORD"; sleep 0.3; echo end` } }, { name: "Bash", args: { command: `echo "$NAVVIED_FAKE_PASSWORD"`, run_in_background: true } }] }));
      await r.turn(prompt("go", { mode: "auto" }));
      await Bun.sleep(300);
      const all = JSON.stringify(r.events) + JSON.stringify(r.provider.requests);
      expect(all).not.toContain(KEY);
      expect(all).toContain("[hidden]");
      expect(r.of("tool").some((e) => e.live !== undefined)).toBe(true);
      r.cleanup();
    } finally { delete process.env.NAVVIED_FAKE_PASSWORD; delete process.env.NAVVIED_OTHER_TOKEN; }
  }, 30_000);
});

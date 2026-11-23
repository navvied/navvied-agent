import { afterAll, describe, expect, test } from "bun:test";
import { ChatCompletionsProvider } from "@navvied/engine";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { adcCredentials, checkCredentialFile, findCredentialFile, type AdcPlaces, type AdcSpec } from "../src/adc.ts";
import { remove, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const dir = (): string => { const d = tempDir(); dirs.push(d); return d; };
afterAll(() => { dirs.forEach(remove); });

const TOKEN_URI = "https://token.test/exchange";
const SCOPE = "https://scope.test/all";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const USER = { type: "authorized_user", client_id: "cid-1", client_secret: "csecret-1", refresh_token: "refresh-1" };
const SERVICE = { type: "service_account", client_email: "robot@project.test", private_key: PRIVATE_PEM, token_uri: "https://token.test/service" };

/** A token service that records what it was asked and answers like the real one: a token with a lifetime, or an error. */
function service(answer: () => Response | Promise<Response> = () => Response.json({ access_token: `tok-${calls.length}`, expires_in: 3600 })) {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => { calls.push({ url, form: new URLSearchParams(String(init.body)) }); return answer(); }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const calls: unknown[] = [];

function fileOf(content: unknown): AdcSpec {
  const file = join(dir(), "credentials.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return { file, tokenUri: TOKEN_URI, scope: SCOPE };
}
const bearer = async (c: ReturnType<typeof adcCredentials>): Promise<string> => (await c.headers(new Headers()))["authorization"]!;

describe("a user's credential file (refresh-token grant)", () => {
  test("is traded for a token with the refresh-token grant, and the token is the bearer of the request", async () => {
    const s = service(() => Response.json({ access_token: "tok-user", expires_in: 3600 }));
    const c = adcCredentials(fileOf(USER), s.fetchFn);
    expect(await bearer(c)).toBe("Bearer tok-user");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(TOKEN_URI);
    expect(Object.fromEntries(s.calls[0]!.form)).toEqual({ grant_type: "refresh_token", client_id: "cid-1", client_secret: "csecret-1", refresh_token: "refresh-1" });
  });

  test("is kept until shortly before it ends, then replaced once, early", async () => {
    let t = 1_000_000;
    let n = 0;
    const s = service(() => Response.json({ access_token: `tok-${++n}`, expires_in: 3600 }));
    const c = adcCredentials(fileOf(USER), s.fetchFn, () => t);
    expect(await bearer(c)).toBe("Bearer tok-1");
    t += 3000 * 1000;
    expect(await bearer(c)).toBe("Bearer tok-1");
    expect(s.calls).toHaveLength(1);
    t += 400 * 1000;
    expect(await bearer(c)).toBe("Bearer tok-2");
    expect(s.calls).toHaveLength(2);
  });

  test("a lifetime shorter than the margin is still used for half of it", async () => {
    let t = 0;
    let n = 0;
    const s = service(() => Response.json({ access_token: `tok-${++n}`, expires_in: 100 }));
    const c = adcCredentials(fileOf(USER), s.fetchFn, () => t);
    await bearer(c);
    t += 40 * 1000;
    expect(await bearer(c)).toBe("Bearer tok-1");
    t += 20 * 1000;
    expect(await bearer(c)).toBe("Bearer tok-2");
  });

  test("calls that wait together make one request to the service", async () => {
    const s = service(async () => { await new Promise((r) => setTimeout(r, 20)); return Response.json({ access_token: "tok-once", expires_in: 3600 }); });
    const c = adcCredentials(fileOf(USER), s.fetchFn);
    const got = await Promise.all([bearer(c), bearer(c), bearer(c)]);
    expect(got).toEqual(["Bearer tok-once", "Bearer tok-once", "Bearer tok-once"]);
    expect(s.calls).toHaveLength(1);
  });
});

describe("a service account's credential file (signed assertion)", () => {
  test("is traded for a token with an RS256 assertion that the public key verifies, for one hour, to the file's own token address", async () => {
    let t = 1_700_000_000_000;
    const s = service(() => Response.json({ access_token: "tok-svc", expires_in: 3600 }));
    const c = adcCredentials(fileOf(SERVICE), s.fetchFn, () => t);
    expect(await bearer(c)).toBe("Bearer tok-svc");
    expect(s.calls[0]!.url).toBe("https://token.test/service");
    expect(s.calls[0]!.form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [head, claims, sig] = s.calls[0]!.form.get("assertion")!.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "robot@project.test", scope: SCOPE, aud: "https://token.test/service", iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });

  test("a file without its own token address uses the one it is given", async () => {
    const s = service();
    const { token_uri: _t, ...bare } = SERVICE;
    await bearer(adcCredentials(fileOf(bare), s.fetchFn));
    expect(s.calls[0]!.url).toBe(TOKEN_URI);
    expect(JSON.parse(Buffer.from(s.calls[0]!.form.get("assertion")!.split(".")[1]!, "base64url").toString()).aud).toBe(TOKEN_URI);
  });
});

describe("when it cannot give a token it says why, and says nothing that is secret", () => {
  const secrets = ["csecret-1", "refresh-1", "cid-1", "PRIVATE KEY", "tok-leak"];
  const noneOf = (message: string): void => { for (const w of secrets) expect(message).not.toContain(w); };

  test("a refusal names the code the service gave, and the next call tries again", async () => {
    let refuse = true;
    const s = service(() => (refuse ? Response.json({ error: "invalid_grant", error_description: "Token has been revoked: refresh-1 csecret-1" }, { status: 400 }) : Response.json({ access_token: "tok-later", expires_in: 3600 })));
    const c = adcCredentials(fileOf(USER), s.fetchFn);
    const failed = await bearer(c).catch((e: Error) => e.message);
    expect(failed).toBe("The sign-in service refused the credential file (invalid_grant).");
    noneOf(failed);
    refuse = false;
    expect(await bearer(c)).toBe("Bearer tok-later");
  });

  test("a service that cannot be reached, a missing file, a file that is not JSON and a kind that is not read", async () => {
    const down = adcCredentials(fileOf(USER), (async () => { throw new Error("connect refused to refresh-1"); }) as unknown as typeof fetch);
    const m1 = await bearer(down).catch((e: Error) => e.message);
    expect(m1).toBe("The sign-in service could not be reached.");
    noneOf(m1);
    expect(await bearer(adcCredentials({ file: join(dir(), "none.json"), tokenUri: TOKEN_URI, scope: SCOPE }, service().fetchFn)).catch((e: Error) => e.message)).toBe("The credential file could not be read.");
    expect(await bearer(adcCredentials(fileOf("not json refresh-1"), service().fetchFn)).catch((e: Error) => e.message)).toBe("The credential file is not readable as JSON.");
    expect(await bearer(adcCredentials(fileOf({ type: "external_account", audience: "x" }), service().fetchFn)).catch((e: Error) => e.message)).toBe("The credential file is of a kind this program does not read (external_account).");
  });

  test("an answer without a token is a refusal, and a token never reaches a message", async () => {
    const s = service(() => Response.json({ token: "tok-leak" }));
    const m = await bearer(adcCredentials(fileOf(USER), s.fetchFn)).catch((e: Error) => e.message);
    expect(m).toBe("The sign-in service refused the credential file.");
    noneOf(m);
  });
});

describe("finding and checking the credential file", () => {
  const places: AdcPlaces = { env: "CRED_FILE", wellKnown: { posix: ".config/tool/adc.json", windows: "tool\\adc.json" }, tokenUri: TOKEN_URI, scope: SCOPE };
  const only = (...paths: string[]) => (p: string): boolean => paths.includes(p);

  test("the file the environment names comes first and must exist; else the well-known place of the system", () => {
    expect(findCredentialFile(places, { CRED_FILE: "/a/b.json", HOME: "/home/u" }, "linux", only("/a/b.json", "/home/u/.config/tool/adc.json"))).toEqual({ file: "/a/b.json" });
    expect(findCredentialFile(places, { CRED_FILE: "/a/gone.json", HOME: "/home/u" }, "linux", only("/home/u/.config/tool/adc.json"))).toEqual({ error: "The file named by CRED_FILE was not found." });
    expect(findCredentialFile(places, { HOME: "/home/u" }, "linux", only("/home/u/.config/tool/adc.json"))).toEqual({ file: "/home/u/.config/tool/adc.json" });
    expect(findCredentialFile(places, { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", only("C:\\Users\\u\\AppData\\Roaming\\tool\\adc.json"))).toEqual({ file: "C:\\Users\\u\\AppData\\Roaming\\tool\\adc.json" });
    expect(findCredentialFile(places, { HOME: "/home/u" }, "linux", only())).toEqual({ error: "No credential file was found on this computer." });
    expect(findCredentialFile(places, {}, "linux", only())).toEqual({ error: "No credential file was found on this computer." });
  });

  test("a file is checked before anything depends on it, without saying what is in it", () => {
    expect(checkCredentialFile(fileOf(USER).file)).toEqual({ ok: true });
    expect(checkCredentialFile(fileOf(SERVICE).file)).toEqual({ ok: true });
    expect(checkCredentialFile(fileOf({ type: "authorized_user", client_id: "x" }).file)).toEqual({ error: "The credential file lacks a client id, a client secret or a refresh token." });
    expect(checkCredentialFile(fileOf({ type: "service_account", client_email: "x" }).file)).toEqual({ error: "The credential file lacks a client email or a private key." });
    expect(checkCredentialFile(join(dir(), "none.json"))).toEqual({ error: "The credential file could not be read." });
  });
});

describe("the model's requests carry the token", () => {
  test("every request of a model endpoint is signed with the current token, and a token replaced between two requests is the one the second carries", async () => {
    const seen: (string | null)[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { seen.push(req.headers.get("authorization")); return Response.json({ choices: [{ message: { content: "ok" } }] }); } });
    try {
      let t = 0, n = 0;
      const s = service(() => Response.json({ access_token: `tok-${++n}`, expires_in: 600 }));
      const provider = new ChatCompletionsProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, model: "m" }, adcCredentials(fileOf(USER), s.fetchFn, () => t));
      const ask = () => provider.complete("s", "u", new AbortController().signal);
      await ask();
      await ask();
      t += 400 * 1000;
      await ask();
      expect(seen).toEqual(["Bearer tok-1", "Bearer tok-1", "Bearer tok-2"]);
    } finally { server.stop(true); }
  });
});

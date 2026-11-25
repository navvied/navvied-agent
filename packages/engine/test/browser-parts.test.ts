import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { secretsIn } from "../src/redact.ts";
import { browser } from "../src/tools/browser.ts";
import { readTree } from "../src/tools/browser/ax.ts";
import { hideSecrets, holdsSecret, originOf, originsIn, whyNotHere } from "../src/tools/browser/credentials.ts";
import { startGuardProxy, type GuardProxy } from "../src/tools/browser/guard-proxy.ts";
import { web } from "../src/tools/web-guard.ts";
import { tree } from "./fake-cdp.ts";

describe("the accessibility tree as text", () => {
  test("what can be used is numbered in reading order with its state, and the rest is read plainly", () => {
    const { lines, refs } = readTree(tree([
      ["banner", "", {}, [["link", "Home", { node: 10, url: "https://a.test/" }]]],
      ["main", "", {}, [
        ["heading", "Sign up", { level: 2 }],
        ["list", "", {}, [["listitem", "", {}, [["StaticText", "Free for ever"]]]]],
        ["textbox", "Email", { node: 11, value: "ann@x.test" }],
        ["checkbox", "Terms", { node: 12, checked: "true" }],
        ["checkbox", "News", { node: 13, checked: false, disabled: true }],
        ["combobox", "Plan", { node: 14, value: "Free" }, [["option", "Free"], ["option", "Pro"]]],
        ["button", "Join", { node: 15 }],
        ["img", "A lamp"],
      ]],
    ]));
    expect(lines).toEqual([
      '[1] link "Home" -> https://a.test/',
      "heading 2: Sign up",
      "- Free for ever",
      '[2] textbox "Email" value="ann@x.test"',
      '[3] checkbox "Terms" (checked)',
      '[4] checkbox "News" (unchecked, disabled)',
      '[5] combobox "Plan" value="Free" options: Free | Pro',
      '[6] button "Join"',
      "image: A lamp",
    ]);
    expect([...refs.values()].map((r) => r.node)).toEqual([10, 11, 12, 13, 14, 15]);
  });

  test("ignored nodes say nothing but their content is kept, and a control the browser gave no id for is named but not numbered", () => {
    const { lines, refs } = readTree(tree([["generic", "", { ignored: true }, [["StaticText", "kept"]]], ["button", "No id"]]));
    expect(lines).toEqual(["kept", "button: No id"]);
    expect(refs.size).toBe(0);
  });

  test("a clickable element the page made focusable and named is a control too", () => {
    const { lines } = readTree(tree([["generic", "Menu", { node: 5, focusable: true }], ["generic", "", { node: 6, focusable: true }]]));
    expect(lines).toEqual(['[1] generic "Menu"']);
  });

  test("a very long name is cut, and a tree with nothing in it gives no lines", () => {
    const { lines } = readTree(tree([["button", "x".repeat(500), { node: 1 }]]));
    expect(lines[0]!.length).toBeLessThan(260);
    expect(readTree([]).lines).toEqual([]);
  });
});

describe("the sites a person named", () => {
  test("addresses give their origin, domain names the secure site of that name, and file names are not sites", () => {
    expect(originsIn("sign in at https://bank.test/login?next=1, then http://127.0.0.1:8080/x.")).toEqual(["https://bank.test", "http://127.0.0.1:8080"]);
    expect(originsIn("log in to github.com and read README.md and main.py")).toEqual(["https://github.com"]);
    expect(originsIn("use accounts.example.co.id:8443 please")).toEqual(["https://accounts.example.co.id:8443"]);
    expect(originsIn("no site here, only notes.txt")).toEqual([]);
    expect(originOf("about:blank")).toBeUndefined();
    expect(originOf("https://a.test:443/x")).toBe("https://a.test");
  });

  test("a page is the named one only by scheme, host and port together", () => {
    const c = { secrets: ["s3cretValue"], origins: ["https://bank.test"] };
    expect(whyNotHere("https://bank.test", c)).toBeUndefined();
    for (const other of ["http://bank.test", "https://bank.test:8443", "https://evil.test", "https://bank.test.evil.test", undefined]) expect(whyNotHere(other, c), String(other)).toContain("Not typed");
    expect(whyNotHere("https://bank.test", { secrets: [], origins: [] })).toContain("has not named the site");
    expect(whyNotHere("https://bank.test", undefined)).toContain("has not named the site");
  });

  test("a secret is found in a text, and hidden in what the model reads, longest first", () => {
    const c = { secrets: ["abcdef", "abcdefgh1"], origins: [] };
    expect(holdsSecret("x abcdef y", c)).toBe(true);
    expect(holdsSecret("nothing", c)).toBe(false);
    expect(holdsSecret("abc", { secrets: ["abc"], origins: [] })).toBe(false);
    expect(hideSecrets("pw abcdefgh1 and abcdef", c)).toBe("pw [hidden] and [hidden]");
    expect(hideSecrets("plain", undefined)).toBe("plain");
  });
});

describe("the proxy every connection of the browser goes through", () => {
  const was = { addresses: web.addresses, dial: web.dial };
  const hits: string[] = [];
  const echo = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { data(s, d) { hits.push(Buffer.from(d).toString("latin1")); const t = Buffer.from(d).toString("latin1"); s.write(t.startsWith("GET") ? "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok" : `echo:${t}`); if (t.startsWith("GET")) s.end(); } } });
  const dialed: string[] = [];
  let proxy: GuardProxy;
  let allow = false;
  const refusals: string[] = [];
  beforeAll(() => {
    web.addresses = async (host) => { if (host === "public.test") return ["93.184.216.34"]; if (host === "rebind.test") return ["93.184.216.34", "10.0.0.5"]; throw new Error("no such name"); };
    web.dial = (address, _port, socket, data) => { dialed.push(address); return was.dial("127.0.0.1", echo.port, socket, data); };
    proxy = startGuardProxy(() => allow, (why) => refusals.push(why));
  });
  afterEach(() => { allow = false; hits.length = 0; dialed.length = 0; refusals.length = 0; });
  afterAll(() => { proxy.close(); echo.stop(true); web.addresses = was.addresses; web.dial = was.dial; });

  /** Sends bytes to the proxy and collects what comes back until it hangs up (or until `until` has been seen). */
  const talk = (...parts: string[]): Promise<string> => new Promise((resolve) => {
    let got = "";
    const queue = [...parts];
    void Bun.connect({ hostname: "127.0.0.1", port: proxy.port, socket: {
      open(s) { s.write(queue.shift()!); },
      data(s, d) { got += Buffer.from(d).toString("latin1"); if (queue.length && got.includes("200 Connection Established")) s.write(queue.shift()!); },
      close() { resolve(got); },
      error() { resolve(got); },
    } });
    setTimeout(() => resolve(got), 3_000);
  });

  test("a tunnel to a public name is made to the address that was checked, and bytes go across both ways", async () => {
    const got = await talk("CONNECT public.test:443 HTTP/1.1\r\nHost: public.test:443\r\n\r\n", "hello");
    expect(got).toContain("HTTP/1.1 200 Connection Established");
    expect(got).toContain("echo:hello");
    expect(dialed).toEqual(["93.184.216.34"]);
  });

  test("a name with one private address among its answers, a literal private address, and a name that cannot be looked up get nothing", async () => {
    for (const host of ["rebind.test:443", "127.0.0.1:80", "10.1.2.3:443", "169.254.169.254:80", "nope.test:443"]) {
      const got = await talk(`CONNECT ${host} HTTP/1.1\r\n\r\n`);
      expect(got, host).toContain("HTTP/1.1 403");
    }
    expect(dialed).toEqual([]);
    expect(refusals.length).toBe(5);
  });

  test("where the host allows private addresses a local one is let through", async () => {
    allow = true;
    expect(await talk("CONNECT 127.0.0.1:80 HTTP/1.1\r\n\r\n", "x")).toContain("echo:x");
  });

  test("a plain request is sent on as one request on its own connection, to the checked address, with the browser's proxy headers taken off", async () => {
    const got = await talk("GET http://public.test/page?q=1 HTTP/1.1\r\nHost: public.test\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n");
    expect(got).toContain("200 OK");
    expect(got.endsWith("ok")).toBe(true);
    const sent = hits.join("");
    expect(sent.startsWith("GET /page?q=1 HTTP/1.1\r\n")).toBe(true);
    expect(sent.toLowerCase()).toContain("connection: close");
    expect(sent.toLowerCase()).not.toContain("proxy-connection");
    expect(sent).toContain("Host: public.test");
    expect(dialed).toEqual(["93.184.216.34"]);
  });

  test("a plain request to a private address is refused before anything is sent", async () => {
    expect(await talk("GET http://10.0.0.1/admin HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n")).toContain("HTTP/1.1 403");
    expect(hits).toEqual([]);
  });

  test("a request that cannot be read, or is too large, is refused", async () => {
    expect(await talk("nonsense\r\n\r\n")).toContain("HTTP/1.1 403");
    expect(await talk(`CONNECT ${"a".repeat(40_000)} HTTP/1.1\r\n`)).toContain("HTTP/1.1 403");
  });

  test("a request that arrives in pieces is put together, and bytes sent while it is checked are not lost", async () => {
    const got = await new Promise<string>((resolve) => {
      let text = "";
      void Bun.connect({ hostname: "127.0.0.1", port: proxy.port, socket: {
        open(s) { s.write("CONNECT public.test:4"); setTimeout(() => s.write("43 HTTP/1.1\r\n\r\nearly"), 100); },
        data(_s, d) { text += Buffer.from(d).toString("latin1"); if (text.includes("echo:early")) resolve(text); },
        close() { resolve(text); },
      } });
      setTimeout(() => resolve(text), 3_000);
    });
    expect(got).toContain("200 Connection Established");
    expect(got).toContain("echo:early");
  });
});

describe("what the person typed at the end of a sentence", () => {
  test("a password followed by a full stop is known both with and without it, so the value that was typed is hidden either way", () => {
    expect(secretsIn("Sign in. The password is Zx9!kQ7mPw. Then go on.").sort()).toEqual(["Zx9!kQ7mPw", "Zx9!kQ7mPw."]);
    expect(secretsIn("password is Zx9!kQ7mPw, then")).toEqual(["Zx9!kQ7mPw"]);
  });

  test("numbers a small model writes as text are taken as numbers, and words stay words", () => {
    expect(browser.fixArgs!({ action: "click", ref: "3", tab: " 2 ", text: "7", seconds: "x" })).toEqual({ action: "click", ref: 3, tab: 2, text: "7", seconds: "x" });
  });
});

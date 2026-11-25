import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultTools } from "../src/index.ts";
import { charsetOf, decodeBody } from "../src/tools/web-charset.ts";
import { pages } from "../src/tools/web-cache.ts";
import { web } from "../src/tools/web-guard.ts";
import type { ToolContext } from "../src/types.ts";

const latin1 = (s: string): Uint8Array => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
const TEXT = "Crème brûlée, 3 €, naïve café";

describe("the characters a page is written in", () => {
  test("the header says first, and it wins over the page's own word", () => {
    expect(decodeBody(latin1("Crème brûlée"), "text/html; charset=ISO-8859-1")).toBe("Crème brûlée");
    expect(decodeBody(latin1("Crème"), 'text/html; charset="windows-1252"')).toBe("Crème");
    expect(decodeBody(Buffer.from("日本語"), "text/html; charset=utf-8")).toBe("日本語");
    expect(decodeBody(new TextEncoder().encode("<meta charset=utf-8>é"), "text/html; charset=iso-8859-1")).toBe("<meta charset=utf-8>Ã©");
  });
  test("a page with no header charset says it itself: meta charset, or the http-equiv form", () => {
    expect(decodeBody(latin1('<html><head><meta charset="iso-8859-1"></head><body>Crème</body></html>'))).toContain("Crème");
    expect(decodeBody(latin1('<head><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252"><body>3 \x80'))).toContain("3 €");
    expect(decodeBody(Buffer.from('<meta charset="shift_jis">日本語'), "")).not.toContain("日本語");
    expect(decodeBody(Uint8Array.from([...Buffer.from('<meta charset="shift_jis">'), 0x93, 0xfa, 0x96, 0x7b]))).toContain("日本");
  });
  test("a byte-order mark, UTF-8 with no word on it, and an old Western page with none either", () => {
    expect(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from("héllo")]))).toBe("héllo");
    expect(decodeBody(Uint8Array.from([0xff, 0xfe, ...Buffer.from("hi", "utf16le")]))).toBe("hi");
    expect(decodeBody(Buffer.from(TEXT))).toBe(TEXT);
    expect(decodeBody(latin1(TEXT.replace("€", "e")))).toBe(TEXT.replace("€", "e"));
  });
  test("a character cut at the end of a page read only up to a limit is not mistaken for a wrong encoding", () => {
    const cut = Buffer.from("日本語").subarray(0, 7);
    expect(decodeBody(cut).startsWith("日本")).toBe(true);
  });
  test("a name the platform does not know is ignored, not an error", () => {
    expect(charsetOf("text/html; charset=klingon-9")).toBeUndefined();
    expect(charsetOf("text/html")).toBeUndefined();
    expect(decodeBody(Buffer.from("fine"), "text/html; charset=klingon-9")).toBe("fine");
  });
});

describe("WebFetch reads a page in its own characters", () => {
  const real = { fetch: web.fetch, addresses: web.addresses };
  let reply: Response;
  beforeEach(() => { pages.clear(); web.addresses = async () => ["93.184.216.34"]; web.fetch = async () => reply.clone() as unknown as Response; });
  afterEach(() => { web.fetch = real.fetch; web.addresses = real.addresses; pages.clear(); });
  const read = (url: string) => defaultTools().find((t) => t.name === "WebFetch")!.run({ url }, { cwd: "/", signal: new AbortController().signal, emit: () => {}, allowPrivateNetwork: false, window: 32_000 } as unknown as ToolContext);
  const page = (body: Uint8Array): string => `<html><head><title>Menu</title></head><body><main><h1>Menu</h1><p>${Buffer.from(body).toString("latin1")}</p></main></body></html>`;

  test("by the header", async () => {
    reply = new Response(latin1(page(latin1(TEXT.replace("€", "e")))), { headers: { "content-type": "text/html; charset=iso-8859-1" } });
    expect(await read("https://menu.example.com/a")).toContain(TEXT.replace("€", "e"));
  });
  test("by the page's own meta tag, with a header that says nothing of it", async () => {
    reply = new Response(latin1(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Menu</title></head><body><main><h1>Menu</h1><p>${TEXT.replace("€", "e")} and some more words to read.</p></main></body></html>`), { headers: { "content-type": "text/html" } });
    expect(await read("https://menu.example.com/b")).toContain(TEXT.replace("€", "e"));
  });
});

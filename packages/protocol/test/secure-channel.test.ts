import { describe, expect, test } from "bun:test";
import { Opener, Sealer, fromBase64Url, hashProof, newSecret, pairingCode, pairingFrom, pairingLink, secretFromLink, toBase64Url } from "../src/secure-channel.ts";

const ends = async (secret = newSecret()) => {
  const pairing = await pairingFrom(secret);
  return { pairing, engine: new Sealer(pairing, "engine"), client: new Sealer(pairing, "client"), atClient: new Opener(pairing, "engine"), atEngine: new Opener(pairing, "client") };
};

describe("what both ends derive from the one secret", () => {
  test("the same secret gives the same channel, proof and key; another secret shares nothing", async () => {
    const secret = newSecret();
    const a = await pairingFrom(secret), b = await pairingFrom(secret), c = await pairingFrom(newSecret());
    expect([a.channel, a.proof, a.proofHash]).toEqual([b.channel, b.proof, b.proofHash]);
    expect(a.channel).not.toBe(c.channel);
    expect(a.proof).not.toBe(c.proof);
    expect(a.proofHash).toBe(await hashProof(a.proof));
    expect(a.proofHash).not.toBe(a.proof);
    expect(a.channel).not.toContain(toBase64Url(secret));
  });
  test("a secret of the wrong length is refused", async () => {
    await expect(pairingFrom(new Uint8Array(5))).rejects.toThrow("wrong length");
  });
});

describe("sealed messages", () => {
  test("go both ways, whatever the text", async () => {
    const e = await ends();
    for (const text of ["", "hello", "naïve — 日本語 😀", JSON.stringify({ cmd: "prompt", text: "x".repeat(200_000) }), "line\nbreak\u0000nul"]) {
      expect(await e.atClient.open(await e.engine.seal(text))).toBe(text);
      expect(await e.atEngine.open(await e.client.seal(text))).toBe(text);
    }
  });
  test("the same text never seals the same way twice, and the text is not visible", async () => {
    const e = await ends();
    const [a, b] = [await e.engine.seal("secret words"), await e.engine.seal("secret words")];
    expect(a).not.toBe(b);
    expect(atob(a.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("secret");
  });
  test("a message with any bit changed is refused", async () => {
    const e = await ends();
    const sealed = fromBase64Url(await e.engine.seal("pay attention"));
    for (const at of [0, 11, 12, 20, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[at]! ^= 1;
      await expect(e.atClient.open(toBase64Url(bad))).rejects.toThrow();
    }
  });
  test("garbage and short input are refused without a crash", async () => {
    const e = await ends();
    for (const junk of ["", "!!!", "abc", toBase64Url(new Uint8Array(10)), toBase64Url(new Uint8Array(200))]) await expect(e.atClient.open(junk)).rejects.toThrow();
  });
  test("a message from another pairing is refused", async () => {
    const a = await ends(), b = await ends();
    await expect(b.atClient.open(await a.engine.seal("hi"))).rejects.toThrow();
  });
  test("a message cannot be sent back to its own sender, or passed off as from the other end", async () => {
    const e = await ends();
    const fromEngine = await e.engine.seal("hi");
    await expect(new Opener(e.pairing, "client").open(fromEngine)).rejects.toThrow();
    await expect(e.atEngine.open(fromEngine)).rejects.toThrow();
  });
});

describe("replays and order", () => {
  test("a repeated message is refused, and so is an older one", async () => {
    const e = await ends();
    const first = await e.engine.seal("one"), second = await e.engine.seal("two");
    expect(await e.atClient.open(second)).toBe("two");
    await expect(e.atClient.open(second)).rejects.toThrow("repeated");
    await expect(e.atClient.open(first)).rejects.toThrow("repeated");
    expect(await e.atClient.open(await e.engine.seal("three"))).toBe("three");
  });
  test("a reconnect starts a new session, so its counter does not clash with the old one", async () => {
    const e = await ends();
    expect(await e.atClient.open(await e.engine.seal("a"))).toBe("a");
    const again = new Sealer(e.pairing, "engine");
    expect(await e.atClient.open(await again.seal("b"))).toBe("b");
    expect(await e.atClient.open(await again.seal("c"))).toBe("c");
  });
  test("many sessions are remembered up to a limit without growing forever", async () => {
    const e = await ends();
    for (let i = 0; i < 100; i++) expect(await e.atClient.open(await new Sealer(e.pairing, "engine").seal(String(i)))).toBe(String(i));
  });
});

describe("the pairing code", () => {
  test("is the same from the same secret, differs between secrets, and uses only letters people do not mix up", async () => {
    const secret = newSecret();
    expect(await pairingCode(secret)).toBe(await pairingCode(secret));
    expect(await pairingCode(newSecret())).not.toBe(await pairingCode(secret));
    for (let i = 0; i < 50; i++) expect(await pairingCode(newSecret())).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });
});

describe("the pairing link", () => {
  test("keeps the secret after the #, and reads it back", () => {
    const secret = newSecret();
    const link = pairingLink("https://navvied.com/", secret);
    expect(link.startsWith("https://navvied.com/#relay=")).toBe(true);
    expect(link.split("#")[0]).not.toContain(toBase64Url(secret));
    expect(secretFromLink(new URL(link).hash)).toEqual(secret);
  });
  test("a damaged or foreign link gives nothing", () => {
    for (const hash of ["", "#", "#relay=", "#relay=abc", "#relay=!!!", "#other=1", `#relay=${toBase64Url(new Uint8Array(31))}`]) expect(secretFromLink(hash)).toBeUndefined();
  });
});

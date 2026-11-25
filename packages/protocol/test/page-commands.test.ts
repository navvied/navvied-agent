import { describe, expect, test } from "bun:test";
import { parseCommand } from "../src/index.ts";

const ok = (v: object) => ({ ok: true as const, value: v as never });
const parse = (o: object) => parseCommand(JSON.stringify(o));
const bad = (o: object): boolean => !parse(o).ok;

describe("media.read", () => {
  test("names a file by its id and takes an optional place and length; a path is not an id", () => {
    expect(parse({ cmd: "media.read", id: "0123456789abcdef01234567" })).toEqual(ok({ cmd: "media.read", id: "0123456789abcdef01234567" }));
    expect(parse({ cmd: "media.read", id: "0123456789abcdef01234567", offset: 262144, length: 100, x: 1 })).toEqual(ok({ cmd: "media.read", id: "0123456789abcdef01234567", offset: 262144, length: 100 }));
    expect(bad({ cmd: "media.read", id: "/etc/passwd" })).toBe(true);
    expect(bad({ cmd: "media.read", id: "../../x" })).toBe(true);
    expect(bad({ cmd: "media.read" })).toBe(true);
    expect(bad({ cmd: "media.read", id: "0123456789abcdef01234567", offset: -1 })).toBe(true);
    expect(bad({ cmd: "media.read", id: "0123456789abcdef01234567", length: 0 })).toBe(true);
    expect(bad({ cmd: "media.read", id: "0123456789abcdef01234567", length: 1.5 })).toBe(true);
  });
});

describe("agent-to-agent settings", () => {
  test("a list takes nothing; a name is letters, digits, dots, dashes and underscores", () => {
    expect(parse({ cmd: "a2a.list" })).toEqual(ok({ cmd: "a2a.list" }));
    for (const cmd of ["a2a.peer.remove", "a2a.token.add", "a2a.token.revoke"]) {
      expect(parse({ cmd, name: "build-bot", x: 1 })).toEqual(ok({ cmd, name: "build-bot" }));
      expect(bad({ cmd, name: "bad name" })).toBe(true);
      expect(bad({ cmd, name: "../x" })).toBe(true);
      expect(bad({ cmd })).toBe(true);
    }
  });
  test("a peer has an address without a name or password, and at most one way to say where its token is", () => {
    expect(parse({ cmd: "a2a.peer.add", name: "bot", url: "https://agent.example.com", token: "  navvied-a2a-abc  ", timeoutSeconds: 60 })).toEqual(ok({ cmd: "a2a.peer.add", name: "bot", url: "https://agent.example.com", token: "navvied-a2a-abc", timeoutSeconds: 60 }));
    expect(parse({ cmd: "a2a.peer.add", name: "bot", url: "http://127.0.0.1:9900", tokenEnv: "BOT_TOKEN" })).toEqual(ok({ cmd: "a2a.peer.add", name: "bot", url: "http://127.0.0.1:9900", tokenEnv: "BOT_TOKEN" }));
    expect(bad({ cmd: "a2a.peer.add", name: "bot", url: "https://user:pw@agent.example.com" })).toBe(true);
    expect(bad({ cmd: "a2a.peer.add", name: "bot", url: "ftp://x" })).toBe(true);
    expect(bad({ cmd: "a2a.peer.add", name: "bot", url: "https://a.example", token: "t", tokenEnv: "T" })).toBe(true);
    expect(bad({ cmd: "a2a.peer.add", name: "bot", url: "https://a.example", token: "two words" })).toBe(true);
    expect(bad({ cmd: "a2a.peer.add", name: "bot", url: "https://a.example", tokenEnv: "not a name" })).toBe(true);
    expect(bad({ cmd: "a2a.peer.add", name: "bot", url: "https://a.example", timeoutSeconds: 0 })).toBe(true);
  });
});

describe("notes the agent kept", () => {
  test("list takes a place; edit and forget name a note by id and a place; the switch takes off, rules or model", () => {
    expect(parse({ cmd: "memory.list" })).toEqual(ok({ cmd: "memory.list" }));
    expect(parse({ cmd: "memory.list", scope: "user" })).toEqual(ok({ cmd: "memory.list", scope: "user" }));
    expect(bad({ cmd: "memory.list", scope: "everywhere" })).toBe(true);
    expect(parse({ cmd: "memory.edit", id: "ab12cd", scope: "project", text: "Use spaces" })).toEqual(ok({ cmd: "memory.edit", id: "ab12cd", scope: "project", text: "Use spaces" }));
    expect(bad({ cmd: "memory.edit", id: "ab12cd", scope: "project", text: "  " })).toBe(true);
    expect(bad({ cmd: "memory.edit", id: "ab12cd", text: "x" })).toBe(true);
    expect(parse({ cmd: "memory.forget", id: "ab12cd", scope: "user", text: "ignored" })).toEqual(ok({ cmd: "memory.forget", id: "ab12cd", scope: "user" }));
    expect(bad({ cmd: "memory.forget", scope: "user" })).toBe(true);
    expect(parse({ cmd: "memory.extract" })).toEqual(ok({ cmd: "memory.extract" }));
    for (const mode of ["off", "rules", "model"]) expect(parse({ cmd: "memory.extract", mode })).toEqual(ok({ cmd: "memory.extract", mode }));
    expect(bad({ cmd: "memory.extract", mode: "always" })).toBe(true);
  });
});

describe("connected programs", () => {
  test("documents: a program is optional for the list, a document needs the program and its address", () => {
    expect(parse({ cmd: "mcp.resources" })).toEqual(ok({ cmd: "mcp.resources" }));
    expect(parse({ cmd: "mcp.resources", server: "docs" })).toEqual(ok({ cmd: "mcp.resources", server: "docs" }));
    expect(parse({ cmd: "mcp.resource", server: "docs", uri: "note://a" })).toEqual(ok({ cmd: "mcp.resource", server: "docs", uri: "note://a" }));
    expect(bad({ cmd: "mcp.resource", server: "docs" })).toBe(true);
    expect(bad({ cmd: "mcp.resource", uri: "note://a" })).toBe(true);
  });
  test("tools: words are optional and short", () => {
    expect(parse({ cmd: "mcp.tools" })).toEqual(ok({ cmd: "mcp.tools" }));
    expect(parse({ cmd: "mcp.tools", query: "send mail", server: "mail" })).toEqual(ok({ cmd: "mcp.tools", query: "send mail", server: "mail" }));
    expect(bad({ cmd: "mcp.tools", query: "x".repeat(201) })).toBe(true);
  });
});

describe("plugins and the screen", () => {
  test("an installation names a source, and the fingerprint is at least twelve hex digits", () => {
    expect(parse({ cmd: "plugin.install", from: " /home/me/style-plugin " })).toEqual(ok({ cmd: "plugin.install", from: "/home/me/style-plugin" }));
    expect(parse({ cmd: "plugin.install", from: "https://x.example/p.zip", fingerprint: "0123456789ABCDEF" })).toEqual(ok({ cmd: "plugin.install", from: "https://x.example/p.zip", fingerprint: "0123456789ABCDEF" }));
    expect(bad({ cmd: "plugin.install", from: "" })).toBe(true);
    expect(bad({ cmd: "plugin.install", from: "a\nb" })).toBe(true);
    expect(bad({ cmd: "plugin.install", from: "p", fingerprint: "abc" })).toBe(true);
    expect(bad({ cmd: "plugin.install", from: "p", fingerprint: "not hex not hex" })).toBe(true);
  });
  test("taking the screen and giving it back take nothing", () => {
    expect(parse({ cmd: "computer.takeover", x: 1 })).toEqual(ok({ cmd: "computer.takeover" }));
    expect(parse({ cmd: "computer.giveback" })).toEqual(ok({ cmd: "computer.giveback" }));
  });
});

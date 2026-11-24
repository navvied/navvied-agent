import { describe, expect, test } from "bun:test";
import type { AccountInfo, EngineEvent } from "@navvied/protocol";
import { ACCOUNT_PROGRAMS } from "../src/presets.ts";
import { accountRows, accountsScreen } from "../src/providers/accounts.ts";
import { FakeLink, scripted } from "./providers-helpers.ts";

const [P1, P2] = ACCOUNT_PROGRAMS as [(typeof ACCOUNT_PROGRAMS)[number], (typeof ACCOUNT_PROGRAMS)[number]];
const accounts = (items: AccountInfo[]): EngineEvent => ({ ev: "accounts", items });
const OUT: AccountInfo[] = [{ id: "navvied", signedIn: false }, { id: P1.id }, { id: P2.id }];
const IN: AccountInfo[] = [{ id: "navvied", signedIn: true, email: "sam@example.com" }, { id: P1.id, installed: true, signedIn: true, email: "sam@example.com", plan: "Pro" }, { id: P2.id, installed: true, signedIn: false }];

describe("the list of accounts", () => {
  test("the navvied account, then each program: Not installed, Not connected, or who it is", () => {
    expect(accountRows(OUT).map((r) => [r.label, r.hint])).toEqual([["Navvied Account", "Not signed in"], [P1.name, "Not installed"], [P2.name, "Not installed"]]);
    expect(accountRows(IN).map((r) => [r.label, r.hint])).toEqual([["Navvied Account", "sam@example.com"], [P1.name, "sam@example.com, Pro"], [P2.name, "Not connected"]]);
    expect(accountRows([{ id: "navvied", signedIn: true }, { id: P1.id, installed: true, signedIn: true }, { id: P2.id }])[1]!.hint).toBe("Connected");
  });
  test("in a cloud session the hub refuses and the sentence is said", async () => {
    const link = new FakeLink(() => "This is only available on a computer, not in Navvied Cloud.");
    const t = scripted([]);
    const kit = t.kit(link);
    expect(await accountsScreen(kit)).toBe("back");
    expect(kit.note).toEqual(["This is only available on a computer, not in Navvied Cloud."]);
  });
});

describe("the navvied account", () => {
  const hub = (more: (c: Record<string, unknown>) => EngineEvent | string | undefined, items = OUT): FakeLink => new FakeLink((c) => c.cmd === "accounts" ? accounts(items) : more(c));
  test("signed out: Sign in shows where to go on and the code, and Cancel stops the wait", async () => {
    const link = hub((c) => c.cmd === "account.login" ? { ev: "account.login", state: "waiting", url: "https://navvied.com/device", code: "QKMR-3T7X", expires: 1 } : undefined);
    const t = scripted(["Navvied Account", "Sign in", "Cancel", undefined]);
    await accountsScreen(t.kit(link));
    const waiting = t.shown.find((s) => s.title === "Navvied Account" && s.frame.body?.[0] === "Waiting")!;
    expect(waiting.frame.body).toEqual(["Waiting", "Continue on navvied.com: https://navvied.com/device", "Code: QKMR-3T7X"]);
    expect(link.commands("account.login.cancel")).toHaveLength(1);
  });
  test("approved on the site while waiting: the screen closes by itself and the list shows the email", async () => {
    let items = OUT;
    const link = hub((c) => c.cmd === "account.login" ? { ev: "account.login", state: "waiting", url: "https://navvied.com/device", code: "A-B" } : undefined, OUT);
    const t = scripted(["Navvied Account", "Sign in", { label: undefined, before: () => { items = IN; link.emit({ ev: "account.login", state: "done", email: "sam@example.com" }); } }, undefined]);
    void items;
    await accountsScreen(t.kit(link));
    expect(link.commands("account.login.cancel")).toEqual([]);
    expect(t.shown.at(-1)!.title).toBe("Accounts");
  });
  test("a sign-in that ends badly says why, in the page's words or the engine's own", async () => {
    for (const [event, said] of [[{ state: "failed", error: "The server could not be reached." }, "The server could not be reached."], [{ state: "failed" }, "The sign-in failed."], [{ state: "expired" }, "The link expired."], [{ state: "denied" }, "The sign-in was declined."]] as const) {
      const link = hub((c) => c.cmd === "account.login" ? { ev: "account.login", state: "waiting", url: "u" } : undefined);
      const t = scripted(["Navvied Account", "Sign in", { label: undefined, before: () => link.emit({ ev: "account.login", ...event } as EngineEvent) }, undefined]);
      await accountsScreen(t.kit(link));
      expect(t.shown.at(-1)!.frame.notice, said).toEqual([said]);
    }
  });
  test("a sign-in the hub refuses to start is said", async () => {
    const link = hub((c) => c.cmd === "account.login" ? "You are already signed in." : undefined);
    const t = scripted(["Navvied Account", "Sign in", undefined]);
    await accountsScreen(t.kit(link));
    expect(t.shown.at(-1)!.frame.notice).toEqual(["You are already signed in."]);
  });
  test("signed in: Sign out asks first; Keep sends nothing, Sign out signs this computer out", async () => {
    const link = hub((c) => c.cmd === "account.logout" ? accounts(OUT) : undefined, IN);
    const t = scripted(["Navvied Account", "Sign out", "Keep", "Navvied Account", "Sign out", "Sign out", undefined]);
    await accountsScreen(t.kit(link));
    const ask = t.shown.find((s) => s.title === "Sign out of Navvied Account?")!;
    expect(ask.items.map((i) => i.label)).toEqual(["Sign out", "Keep"]);
    expect(link.commands("account.logout")).toHaveLength(1);
  });
});

describe("a program", () => {
  const hub = (more: (c: Record<string, unknown>) => EngineEvent | string | undefined, items = OUT): FakeLink => new FakeLink((c) => c.cmd === "accounts" ? accounts(items) : more(c));
  test("not installed: Install runs the installer, and says so while it does", async () => {
    const link = hub((c) => c.cmd === "account.install" ? { ev: "account.install", id: P1.id, state: "done" } : undefined);
    const t = scripted([P1.name, `Install ${P1.program}`, undefined]);
    await accountsScreen(t.kit(link));
    expect(link.commands("account.install")).toEqual([{ cmd: "account.install", id: P1.id }]);
    expect(t.shown.find((s) => s.title === P1.name)!.frame.body).toEqual(["Not installed"]);
    expect(t.shown.some((s) => s.title === "Installing")).toBe(true);
  });
  test("an install that fails says why with the engine's own words, and the next try is offered as Try again", async () => {
    const link = hub((c) => c.cmd === "account.install" ? { ev: "account.install", id: P2.id, state: "failed", error: "npm was not found on this computer." } : undefined);
    const t = scripted([P2.name, `Install ${P2.program}`, P2.name, "Try again", undefined]);
    await accountsScreen(t.kit(link));
    expect(t.shown.filter((s) => s.title === "Accounts").at(-1)!.frame.notice).toEqual(["npm was not found on this computer."]);
    expect(t.shown.filter((s) => s.title === P2.name).at(-1)!.items.map((i) => i.label)).toEqual(["Try again"]);
    expect(link.commands("account.install")).toHaveLength(2);
  });
  test("installed, not connected: Sign in starts the program's own sign-in and shows where to go on, and the code if there is one", async () => {
    const link = hub((c) => c.cmd === "account.signin" ? { ev: "account.signin", id: P1.id, state: "waiting", url: "https://example.com/oauth", code: "7H2K-9PQ4" } : undefined, IN.map((a) => a.id === P1.id ? { id: P1.id, installed: true, signedIn: false } : a));
    const t = scripted([P1.name, "Sign in", "Cancel", undefined]);
    await accountsScreen(t.kit(link));
    expect(link.commands("account.signin")).toEqual([{ cmd: "account.signin", id: P1.id }]);
    const waiting = t.shown.find((s) => s.frame.body?.[0] === "Waiting")!;
    expect(waiting.frame.body).toEqual(["Waiting", "Continue in your browser: https://example.com/oauth", "Code: 7H2K-9PQ4"]);
    expect(link.commands("account.signin.cancel")).toEqual([{ cmd: "account.signin.cancel", id: P1.id }]);
  });
  test("a program's sign-in that fails says the engine's words; another program's events are not taken for it", async () => {
    const link = hub((c) => c.cmd === "account.signin" ? { ev: "account.signin", id: P1.id, state: "waiting" } : undefined, [{ id: "navvied" }, { id: P1.id, installed: true, signedIn: false }, { id: P2.id }]);
    const t = scripted([P1.name, "Sign in", { label: undefined, before: () => { link.emit({ ev: "account.signin", id: P2.id, state: "done" }); link.emit({ ev: "account.signin", id: P1.id, state: "failed", error: "The program gave no address." }); } }, undefined]);
    await accountsScreen(t.kit(link));
    expect(t.shown.at(-1)!.frame.notice).toEqual(["The program gave no address."]);
  });
  test("connected: who it is and Sign out, which asks first in the page's words", async () => {
    const link = hub((c) => c.cmd === "account.signout" ? accounts(OUT) : undefined, IN);
    const t = scripted([P1.name, "Sign out", "Keep", P1.name, "Sign out", "Sign out", undefined]);
    await accountsScreen(t.kit(link));
    expect(t.shown.find((s) => s.title === P1.name)!.frame.body).toEqual(["sam@example.com, Pro"]);
    expect(t.shown.find((s) => s.title === `Sign out of ${P1.name}?`)!.items.map((i) => i.label)).toEqual(["Sign out", "Keep"]);
    expect(link.commands("account.signout")).toEqual([{ cmd: "account.signout", id: P1.id }]);
  });
});

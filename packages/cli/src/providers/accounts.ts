import type { AccountInfo, EngineEvent } from "@navvied/protocol";
import type { Choice } from "../io.ts";
import { ACCOUNT_PROGRAMS } from "../presets.ts";
import type { Kit, Live, Result } from "./kit.ts";

type Program = (typeof ACCOUNT_PROGRAMS)[number];
type LoginEvent = Extract<EngineEvent, { ev: "account.login" }>;
type SigninEvent = Extract<EngineEvent, { ev: "account.signin" }>;

/** Who a connected program is signed in as: the email and the plan the program says, or just that it is connected. */
const who = (a: AccountInfo): string => [a.email, a.plan].filter(Boolean).join(", ") || "Connected";
const statusOf = (a: AccountInfo | undefined): string => (!a?.installed ? "Not installed" : !a.signedIn ? "Not connected" : who(a));

/** The navvied account of this computer, then each program that signs in with its own plan. */
export function accountRows(items: readonly AccountInfo[]): (Choice & { id: string })[] {
  const mine = items.find((a) => a.id === "navvied");
  return [
    { id: "navvied", label: "Navvied Account", hint: mine?.signedIn ? (mine.email ?? "Signed in") : "Not signed in" },
    ...ACCOUNT_PROGRAMS.map((p) => ({ id: p.id, label: p.name, hint: statusOf(items.find((a) => a.id === p.id)) })),
  ];
}

/** Accounts: the site's sign-in and the programs that sign in on their own. navvied never takes their login: the person signs in on the page the program or the site opens. */
export async function accountsScreen(k: Kit): Promise<Result> {
  let at = 0;
  const installFailed = new Set<string>();
  for (;;) {
    const got = await k.link.call("accounts", { cmd: "accounts" });
    if (typeof got === "string") { k.note = [got]; return "back"; }
    const rows = accountRows(got.items);
    const picked = await k.choose("Accounts", "Accounts", rows, { at });
    if (picked === undefined) return "back";
    at = picked;
    const id = rows[picked]!.id;
    if (id === "navvied") await navvied(k, got.items.find((a) => a.id === "navvied"));
    else await program(k, ACCOUNT_PROGRAMS.find((p) => p.id === id)!, got.items.find((a) => a.id === id), installFailed);
  }
}

/** Sign out asks first, in the page's words; the first choice is the safe one. */
async function signOut(k: Kit, name: string, send: () => Promise<unknown>): Promise<void> {
  const picked = await k.choose(`Sign out of ${name}?`, "Accounts", [{ label: "Sign out" }, { label: "Keep" }], { at: 1 });
  if (picked !== 0) return;
  const got = await send();
  if (typeof got === "string") k.note = [got];
}

async function navvied(k: Kit, mine: AccountInfo | undefined): Promise<void> {
  if (mine?.signedIn) {
    const picked = await k.choose("Navvied Account", "Accounts", [{ label: "Sign out" }], { body: [mine.email ?? "Signed in"] });
    if (picked === 0) await signOut(k, "Navvied Account", () => k.link.call("accounts", { cmd: "account.logout" }));
    return;
  }
  const picked = await k.choose("Navvied Account", "Accounts", [{ label: "Sign in" }], { body: ["Not signed in"] });
  if (picked !== 0) return;
  await wait(k, {
    title: "Navvied Account",
    start: () => k.link.call("account.login", { cmd: "account.login" }),
    cancel: { cmd: "account.login.cancel" },
    listen: (e): LoginEvent | undefined => (e.ev === "account.login" ? e : undefined),
    where: "Continue on navvied.com",
    failed: (e) => (e.state === "failed" ? (e.error ?? "The sign-in failed.") : e.state === "expired" ? "The link expired." : e.state === "denied" ? "The sign-in was declined." : ""),
  });
}

/** A program: installing it, signing in on the page it opens, and signing out of navvied's use of it. */
async function program(k: Kit, p: Program, info: AccountInfo | undefined, installFailed: Set<string>): Promise<void> {
  if (!info?.installed) {
    const picked = await k.choose(p.name, "Accounts", [{ label: installFailed.has(p.id) ? "Try again" : `Install ${p.program}` }], { body: ["Not installed"] });
    if (picked !== 0) return;
    const done = k.io.work
      ? await k.io.work("Installing", { heading: k.heading("Accounts"), body: [p.name] }, () => k.link.call("account.install", { cmd: "account.install", id: p.id }))
      : await k.link.call("account.install", { cmd: "account.install", id: p.id });
    if (done === "back" || done === undefined) return;
    if (typeof done === "string") { installFailed.add(p.id); k.note = [done]; }
    else if (done.state === "failed") { installFailed.add(p.id); k.note = [done.error ?? "The install failed."]; }
    else installFailed.delete(p.id);
    return;
  }
  if (info.signedIn) {
    const picked = await k.choose(p.name, "Accounts", [{ label: "Sign out" }], { body: [who(info)] });
    if (picked === 0) await signOut(k, p.name, () => k.link.call("accounts", { cmd: "account.signout", id: p.id }));
    return;
  }
  const picked = await k.choose(p.name, "Accounts", [{ label: "Sign in" }], { body: ["Not connected"] });
  if (picked !== 0) return;
  await wait(k, {
    title: p.name,
    start: () => k.link.call("account.signin", { cmd: "account.signin", id: p.id }),
    cancel: { cmd: "account.signin.cancel", id: p.id },
    listen: (e): SigninEvent | undefined => (e.ev === "account.signin" && e.id === p.id ? e : undefined),
    where: "Continue in your browser",
    failed: (e) => (e.state === "failed" ? (e.error ?? "The sign-in failed.") : ""),
  });
}

interface Wait<E extends LoginEvent | SigninEvent> {
  title: string;
  start(): Promise<E | string>;
  cancel: object;
  listen(e: EngineEvent): E | undefined;
  /** What the address is called: where the person goes on to. */
  where: string;
  /** The line to say when it ended badly (nothing when it ended well or was stopped). */
  failed(e: E): string;
}

/** A sign-in that waits for the person on another page: the address and the code to use, until it is done, refused or cancelled. */
async function wait<E extends LoginEvent | SigninEvent>(k: Kit, w: Wait<E>): Promise<void> {
  const first = await w.start();
  if (typeof first === "string") { k.note = [first]; return; }
  let now: E = first;
  const off = k.link.watch((e) => { const got = w.listen(e); if (got) now = got; });
  try {
    const lines = (): string[] => ["Waiting", ...(now.url ? [`${w.where}: ${now.url}`] : []), ...(now.code ? [`Code: ${now.code}`] : [])];
    const rows: Choice[] = [{ label: "Cancel" }];
    while (now.state === "waiting") {
      const live = (): Live => (now.state === "waiting" ? { rows, body: lines() } : { rows, auto: -1 });
      const picked = await k.choose(w.title, "Accounts", rows, { body: lines(), live });
      if (now.state === "waiting" && picked !== -1) { k.link.send(w.cancel); k.note = []; return; }
    }
    const said = w.failed(now);
    if (said) k.note = [said];
  } finally { off(); }
}

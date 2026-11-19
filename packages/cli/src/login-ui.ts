import { AccountError, createAccount, fetchModels, pollDevice, signIn, signOut, startDevice } from "./account-client.ts";
import { clearAccount, forgetHostedModels, writeAccount, writeHostedModels, type Account, type HostedModels } from "./account.ts";
import type { Choice, Frame, IO } from "./io.ts";
import { paint } from "./render.ts";

export interface LoginPaths {
  account: string;
  models: string;
  /** Called once an account is saved on this computer (it joins the account), and just before it is signed out (it leaves). A failure never stops either. */
  onSignedIn?(account: Account): Promise<void>;
  onSignOut?(account: Account): Promise<void>;
}
export type LoginOutcome =
  | { kind: "signed-in"; email: string; models: string[] }
  | { kind: "signed-out" }
  | { kind: "choose-model" }
  | { kind: "cancelled" };

const MIN_PASSWORD = 8;
const looksLikeEmail = (text: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());

const heading = (io: IO, title: string, line: string): string[] => [paint(io.color, "cyan", paint(io.color, "bold", title)), paint(io.color, "dim", line)];

/** Asks one thing at a time; going back (Left) or cancelling (Esc) leaves the question. */
async function email(io: IO, frame: Frame, initial = ""): Promise<string | "back" | undefined> {
  for (let notice: string[] | undefined;;) {
    const got = await io.text?.("Your email address", initial, { ...frame, ...(notice ? { notice } : {}) });
    if (got === undefined || got === "back") return got;
    if (looksLikeEmail(got)) return got.trim().toLowerCase();
    initial = got;
    notice = ["That does not look like an email address. For example: you@example.com"];
  }
}

async function newPassword(io: IO, frame: Frame): Promise<string | "back" | undefined> {
  for (let notice: string[] | undefined;;) {
    const first = await io.secret?.(`Choose a password (at least ${MIN_PASSWORD} characters)`, { ...frame, ...(notice ? { notice } : {}) });
    if (first === undefined || first === "back") return first;
    if (first.length < MIN_PASSWORD) { notice = [`Use at least ${MIN_PASSWORD} characters.`]; continue; }
    const again = await io.secret?.("Type the password again", frame);
    if (again === undefined || again === "back") return again;
    if (again === first) return first;
    notice = ["The two passwords were not the same. Try again."];
  }
}

const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((done) => { const t = setTimeout(done, ms); signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true }); });

/** Signing in through the browser: a page opens, the person approves it there, and this screen waits. Nothing to type. */
async function throughBrowser(io: IO, paths: LoginPaths, server: string, wait: typeof pause): Promise<LoginOutcome | { kind: "retry"; notice: string } | undefined> {
  let request;
  try { request = await startDevice(io.fetch, server, "this computer"); }
  catch (e) { return { kind: "retry", notice: e instanceof AccountError ? e.message : "Something went wrong. Try again in a moment." }; }
  io.system.open(request.verificationUrl);
  let say: (line: string) => void = () => {};
  const frame: Frame = {
    actions: [
      { key: "o", label: "open the page again", run: () => { io.system.open(request.verificationUrl); say("Opened the page again."); } },
      { key: "c", label: "copy the link", run: () => { void io.system.copy(request.verificationUrl).then((ok) => { say(ok ? "Link copied. Paste it into any browser." : "Could not copy here. Type the link in your browser, or press O."); }); } },
    ],
    heading: heading(io, "Sign in to navvied", "Approve this computer in your browser."),
    body: ["A page is open in your browser. Check that it shows this code, then press Approve:", "", `   ${paint(io.color, "bold", request.userCode)}`, "", `Page did not open? Press O to open it again, or C to copy the link:`, request.verificationUrl],
    status: "Waiting for you to approve in the browser",
  };
  const result = await io.work?.<{ state: "approved"; account: Account; listing: HostedModels } | { state: "denied" | "expired" } | AccountError>("Approve in your browser", frame, async (context) => {
    say = context.log;
    const until = Date.now() + request.expiresIn * 1000;
    try {
      while (!context.signal.aborted && Date.now() < until) {
        await wait(request.interval * 1000, context.signal);
        if (context.signal.aborted) break;
        const polled = await pollDevice(io.fetch, server, request.deviceCode);
        if (polled.state === "pending") continue;
        if (polled.state !== "approved") return { state: polled.state };
        const listing = await fetchModels(io.fetch, polled.account);
        writeAccount(paths.account, polled.account);
        writeHostedModels(paths.models, listing);
        await paths.onSignedIn?.(polled.account).catch(() => undefined);
        return { state: "approved" as const, account: polled.account, listing };
      }
      return { state: "expired" as const };
    } catch (e) { return e instanceof AccountError ? e : new AccountError("Something went wrong. Try again in a moment."); }
  });
  if (result === undefined || result === "back") return undefined;
  if (result instanceof AccountError) return { kind: "retry", notice: result.message };
  if (result.state === "approved") return { kind: "signed-in", email: result.account.email, models: result.listing.models.filter((m) => !m.locked).map((m) => m.name) };
  return { kind: "retry", notice: result.state === "denied" ? "You turned this down in the browser." : "The code ran out. Choose Sign in to get a new one." };
}

/** The signed-out screen: sign in, or make an account. A wrong password or an unreachable server comes back to the menu with the reason. */
async function signedOut(io: IO, paths: LoginPaths, server: string, wait: typeof pause): Promise<LoginOutcome> {
  const intro = heading(io, "Sign in to navvied", "Use the models we host. Your files stay on this computer.");
  let notice: string[] | undefined;
  for (;;) {
    const items: Choice[] = [
      { label: "Sign in with my browser", hint: "Easiest. A page opens, you press Approve, and you are done. Nothing to type." },
      { label: "Sign in with email and password", hint: "Type them here. Use this when there is no browser on this computer." },
      { label: "Create a free account", hint: "It takes a moment. No card needed." },
      { label: "Not now" },
    ];
    const picked = await io.choose?.("What would you like to do?", items, 0, { heading: intro, ...(notice ? { notice } : {}) });
    notice = undefined;
    if (picked === 0) {
      const outcome = await throughBrowser(io, paths, server, wait);
      if (!outcome) return { kind: "cancelled" };
      if (outcome.kind === "retry") { notice = [outcome.notice]; continue; }
      return outcome;
    }
    if (picked !== 1 && picked !== 2) return { kind: "cancelled" };
    const making = picked === 2;
    const frame: Frame = { heading: heading(io, making ? "Create your navvied account" : "Sign in to navvied", making ? "Free. You can use it on every computer and in the browser." : "The same account you use at navvied.com.") };

    const address = await email(io, frame);
    if (address === undefined) return { kind: "cancelled" };
    if (address === "back") continue;
    const secret = making ? await newPassword(io, frame) : await io.secret?.("Your password", frame);
    if (secret === undefined) return { kind: "cancelled" };
    if (secret === "back") continue;

    const result = await io.work?.<{ account: Account; listing: HostedModels } | AccountError>(making ? "Creating your account…" : "Signing in…", { ...frame, status: making ? "Making your account" : "Checking your details" }, async () => {
      try {
        if (making) await createAccount(io.fetch, server, address, secret);
        const account = await signIn(io.fetch, server, address, secret, "this computer");
        const models = await fetchModels(io.fetch, account);
        writeAccount(paths.account, account);
        writeHostedModels(paths.models, models);
        await paths.onSignedIn?.(account).catch(() => undefined);
        return { account, listing: models };
      } catch (e) { return e instanceof AccountError ? e : new AccountError("Something went wrong. Try again in a moment."); }
    });
    if (result === undefined || result === "back") { if (result === "back") continue; return { kind: "cancelled" }; }
    if (result instanceof AccountError) { notice = [result.message]; continue; }
    return { kind: "signed-in", email: result.account.email, models: result.listing.models.filter((m) => !m.locked).map((m) => m.name) };
  }
}

/** The signed-in screen: what to do with the account. */
async function signedIn(io: IO, account: Account, paths: LoginPaths): Promise<LoginOutcome> {
  const picked = await io.choose?.("Your navvied account", [
    { label: "Choose a model", hint: "Switch to one of the models we host, or one of your own." },
    { label: "Sign out", hint: "This computer stops using your account. Your files stay as they are." },
    { label: "Stay signed in" },
  ], 0, { heading: heading(io, "Signed in", account.email) });
  if (picked === 0) return { kind: "choose-model" };
  if (picked !== 1) return { kind: "cancelled" };
  return signOutScreen(io, account, paths);
}

/** Asks once, then signs this computer out: the token is cancelled on the server and forgotten here. */
export async function signOutScreen(io: IO, account: Account, paths: LoginPaths): Promise<LoginOutcome> {
  const sure = await io.choose?.("Sign out of navvied?", [{ label: "Yes, sign out" }, { label: "No, stay signed in" }], 1, { heading: heading(io, "Sign out", `${account.email} on this computer`) });
  if (sure !== 0) return { kind: "cancelled" };
  await paths.onSignOut?.(account).catch(() => undefined);
  await signOut(io.fetch, account);
  clearAccount(paths.account);
  forgetHostedModels(paths.models);
  return { kind: "signed-out" };
}

/** `/login`: signed out it signs in or makes an account; signed in it offers the account's own choices. */
export function login(io: IO, paths: LoginPaths, account: Account | undefined, server: string, wait: typeof pause = pause): Promise<LoginOutcome> {
  return account ? signedIn(io, account, paths) : signedOut(io, paths, server, wait);
}

import type { AccountInfo, Command, EngineEvent } from "@navvied/protocol";
import { AccountError, startDevice } from "./account-client.ts";
import { awaitApproval, leaveAccount, pause, type AccountPaths } from "./account-session.ts";
import type { Account } from "./account.ts";
import type { IO } from "./io.ts";
import type { ModelEntry } from "./config.ts";
import { ACCOUNT_PROGRAMS, programEntry } from "./presets.ts";
import { ProgramSignIn, entryEnvOf, type ProgramEntries, installPlan, programLoginReadable, programStatus, programVersion } from "./programs.ts";

export interface AccountsDeps {
  io: IO;
  inCloud(): boolean;
  account(): Account | undefined;
  tell(e: EngineEvent): void;
  models: { save(name: string, entry: ModelEntry): void; remove(name: string): void; entries(): ProgramEntries };
  session: { paths(): AccountPaths; server(): string; label(): string; changed(): void; wait?: (ms: number, signal: AbortSignal) => Promise<void> };
}

const REFUSED = "The programs of this computer are used only on a computer, never in Navvied Cloud.";

export async function readAccounts(io: IO, account: Account | undefined, entries: ProgramEntries): Promise<AccountInfo[]> {
  const program = async ({ id, command }: { id: string; command: string }): Promise<AccountInfo> => {
    const path = io.system.which(command);
    if (!path) return { id, installed: false };
    const [version, status] = await Promise.all([programVersion(io.system, path), programStatus(id, io.system, path, entryEnvOf(entries, id))]);
    return { id, installed: true, ...(version ? { version } : {}), signedIn: status.loggedIn, ...(status.loggedIn && status.account ? { email: status.account } : {}), ...(status.loggedIn && status.plan ? { plan: status.plan } : {}) };
  };
  return [{ id: "navvied", signedIn: !!account, ...(account ? { email: account.email } : {}) }, ...(await Promise.all(ACCOUNT_PROGRAMS.map(program)))];
}

export function accounts(d: AccountsDeps): { command(cmd: Command): boolean } {
  const installing = new Set<string>();
  const tellAll = async (): Promise<void> => { d.tell({ ev: "accounts", items: await readAccounts(d.io, d.account(), d.models.entries()) }); };

  const install = async (id: string): Promise<void> => {
    if (installing.has(id)) return;
    const plan = installPlan(id, process.platform, d.io.env, d.io.system.which);
    if ("error" in plan) { d.tell({ ev: "account.install", id, state: "failed", error: plan.error }); return; }
    installing.add(id);
    d.tell({ ev: "account.install", id, state: "installing" });
    try {
      const done = await d.io.system.run(plan.argv, { timeoutMs: 600_000 });
      const found = done.code === 0 && d.io.system.which(plan.command) !== undefined;
      d.tell(found ? { ev: "account.install", id, state: "done" } : { ev: "account.install", id, state: "failed", error: "The installer did not finish, or the program was not found afterwards. Open a new terminal and try again, or install it yourself." });
    } catch { d.tell({ ev: "account.install", id, state: "failed", error: "The installer could not be run." }); }
    finally { installing.delete(id); }
    await tellAll();
  };

  const wait = d.session.wait ?? pause;
  const signins = new Map<string, ProgramSignIn>();
  const SIGNIN_MS = 10 * 60_000;
  const failed = (id: string, error: string): void => { d.tell({ ev: "account.signin", id, state: "failed", error }); };

  const signin = async (id: string, device: boolean): Promise<void> => {
    const program = ACCOUNT_PROGRAMS.find((p) => p.id === id);
    if (!program) { failed(id, "That program is not known."); return; }
    const path = d.io.system.which(program.command);
    if (!path) { failed(id, "That program is not installed on this computer."); return; }
    signins.get(id)?.stop();
    const run = new ProgramSignIn(id, d.io.system, path, { device }, entryEnvOf(d.models.entries(), id));
    signins.set(id, run);
    const mine = (): boolean => signins.get(id) === run;
    const never = new AbortController();
    for (let n = 0; n < 100 && (!run.url || (device && !run.code)) && !run.finished && mine(); n++) await wait(100, never.signal);
    if (!mine()) return;
    if (!run.url) { signins.delete(id); run.stop(); failed(id, "The program did not give a sign-in address. Check your internet connection and try again."); return; }
    d.tell({ ev: "account.signin", id, state: "waiting", url: run.url, ...(run.code ? { code: run.code } : {}) });
    const until = Date.now() + SIGNIN_MS;
    let done = false;
    while (mine() && Date.now() < until) {
      if (await run.signedIn()) { done = true; break; }
      if (run.finished) break;
      await wait(1500, never.signal);
    }
    if (!mine()) return;
    signins.delete(id);
    run.stop();
    if (!done) { failed(id, "The sign-in was not finished. It may have been cancelled, or the window was closed."); return; }
    const named = programEntry(id, path, programLoginReadable(id, d.io.env));
    d.models.save(named.name, named.entry);
    d.session.changed();
    d.tell({ ev: "account.signin", id, state: "done" });
    await tellAll();
  };

  let approving: AbortController | undefined;
  const login = async (): Promise<void> => {
    approving?.abort();
    const mine = (approving = new AbortController());
    const server = d.session.server();
    let request;
    try { request = await startDevice(d.io.fetch, server, d.session.label()); }
    catch (e) { if (approving === mine) approving = undefined; d.tell({ ev: "account.login", state: "failed", error: e instanceof AccountError ? e.message : "Something went wrong. Try again in a moment." }); return; }
    d.tell({ ev: "account.login", state: "waiting", url: request.verificationUrl, code: request.userCode, expires: Date.now() + request.expiresIn * 1000 });
    const got = await awaitApproval(d.io.fetch, server, request, d.session.paths(), mine.signal, d.session.wait);
    if (approving !== mine) return;
    approving = undefined;
    if (got instanceof AccountError) { d.tell({ ev: "account.login", state: "failed", error: got.message }); return; }
    if (got.state !== "approved") { d.tell({ ev: "account.login", state: got.state }); return; }
    d.session.changed();
    d.tell({ ev: "account.login", state: "done", email: got.account.email });
    await tellAll();
  };
  const logout = async (): Promise<void> => {
    const account = d.account();
    if (!account) { d.tell({ ev: "error", msg: "You are not signed in." }); return; }
    approving?.abort();
    await leaveAccount(d.io.fetch, account, d.session.paths());
    d.session.changed();
    await tellAll();
  };

  return {
    command(cmd) {
      if (cmd.cmd === "account.login" || cmd.cmd === "account.login.cancel" || cmd.cmd === "account.logout") {
        if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
        if (cmd.cmd === "account.login") void login();
        else if (cmd.cmd === "account.logout") void logout();
        else approving?.abort();
        return true;
      }
      if (cmd.cmd === "account.signin" || cmd.cmd === "account.signin.code" || cmd.cmd === "account.signin.cancel" || cmd.cmd === "account.signout") {
        if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
        if (cmd.cmd === "account.signin") void signin(cmd.id, cmd.device === true);
        else if (cmd.cmd === "account.signin.code") signins.get(cmd.id)?.type(cmd.code);
        else if (cmd.cmd === "account.signin.cancel") { const run = signins.get(cmd.id); if (run) { signins.delete(cmd.id); run.stop(); d.tell({ ev: "account.signin", id: cmd.id, state: "stopped" }); } }
        else {
          const run = signins.get(cmd.id);
          if (run) { signins.delete(cmd.id); run.stop(); }
          if (!ACCOUNT_PROGRAMS.some((p) => p.id === cmd.id)) d.tell({ ev: "error", msg: "That program is not known." });
          else { d.models.remove(programEntry(cmd.id, "", false).name); d.session.changed(); void tellAll(); }
        }
        return true;
      }
      if (cmd.cmd !== "accounts" && cmd.cmd !== "account.install") return false;
      if (d.inCloud()) { d.tell({ ev: "error", msg: REFUSED }); return true; }
      if (cmd.cmd === "accounts") void tellAll();
      else void install(cmd.id);
      return true;
    },
  };
}

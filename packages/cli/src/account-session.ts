import { AccountError, fetchModels, pollDevice, signOut, type DeviceRequest } from "./account-client.ts";
import { clearAccount, forgetHostedModels, writeAccount, writeHostedModels, type Account, type HostedModels } from "./account.ts";

/** Where an account is kept on this computer, and what joining and leaving it does besides (the computer joins the account's computers, or leaves them). */
export interface AccountPaths {
  account: string;
  models: string;
  /** Called once an account is saved on this computer, and just before it is signed out. A failure never stops either. */
  onSignedIn?(account: Account): Promise<void>;
  onSignOut?(account: Account): Promise<void>;
}

export const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((done) => { const t = setTimeout(done, ms); signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true }); });

export type Approval = { state: "approved"; account: Account; listing: HostedModels } | { state: "denied" | "expired" | "stopped" } | AccountError;

/**
 * Waits for the person to approve a code in their browser (the password never comes here), and then keeps the account the way every sign-in does: the account file,
 * the list of hosted models, and what joining the account does. One shared way, for the terminal's `/login` and for the pages.
 */
export async function awaitApproval(send: typeof fetch, server: string, request: DeviceRequest, paths: AccountPaths, signal: AbortSignal, wait: typeof pause = pause, now: () => number = Date.now): Promise<Approval> {
  const until = now() + request.expiresIn * 1000;
  try {
    while (!signal.aborted && now() < until) {
      await wait(request.interval * 1000, signal);
      if (signal.aborted) break;
      const polled = await pollDevice(send, server, request.deviceCode);
      if (polled.state === "pending") continue;
      if (polled.state !== "approved") return { state: polled.state };
      const listing = await fetchModels(send, polled.account);
      writeAccount(paths.account, polled.account);
      writeHostedModels(paths.models, listing);
      await paths.onSignedIn?.(polled.account).catch(() => undefined);
      return { state: "approved", account: polled.account, listing };
    }
    return { state: signal.aborted ? "stopped" : "expired" };
  } catch (e) { return e instanceof AccountError ? e : new AccountError("Something went wrong. Try again in a moment."); }
}

/** Signs this computer out: it leaves the account's computers, the token is cancelled on the server, and everything of the account is forgotten here. */
export async function leaveAccount(send: typeof fetch, account: Account, paths: AccountPaths): Promise<void> {
  await paths.onSignOut?.(account).catch(() => undefined);
  await signOut(send, account);
  clearAccount(paths.account);
  forgetHostedModels(paths.models);
}

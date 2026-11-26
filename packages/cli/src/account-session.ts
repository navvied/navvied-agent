import { AccountError, awaitDevice, fetchModels, signOut, type DeviceRequest } from "./account-client.ts";
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

const RECONNECT_AFTER_MS = [1_000, 2_000, 5_000, 10_000];
const MOST_LOST_CONNECTIONS = 8;

export async function awaitApproval(send: typeof fetch, server: string, request: DeviceRequest, paths: AccountPaths, signal: AbortSignal, wait: typeof pause = pause): Promise<Approval> {
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(request.expiresIn * 1000)]);
  const over = (): Approval => ({ state: signal.aborted ? "stopped" : "expired" });
  try {
    for (let lost = 0; !waiting.aborted;) {
      const told = await awaitDevice(send, server, request.deviceCode, waiting);
      if (waiting.aborted) break;
      if (told.state === "lost") {
        if (++lost > MOST_LOST_CONNECTIONS) return new AccountError("The connection to the server kept closing. Try again in a moment.");
        await wait(RECONNECT_AFTER_MS[Math.min(lost, RECONNECT_AFTER_MS.length) - 1]!, waiting);
        continue;
      }
      if (told.state !== "approved") return { state: told.state };
      const listing = await fetchModels(send, told.account);
      writeAccount(paths.account, told.account);
      writeHostedModels(paths.models, listing);
      await paths.onSignedIn?.(told.account).catch(() => undefined);
      return { state: "approved", account: told.account, listing };
    }
    return over();
  } catch (e) {
    if (waiting.aborted) return over();
    return e instanceof AccountError ? e : new AccountError("Something went wrong. Try again in a moment.");
  }
}

/** Signs this computer out: it leaves the account's computers, the token is cancelled on the server, and everything of the account is forgotten here. */
export async function leaveAccount(send: typeof fetch, account: Account, paths: AccountPaths): Promise<void> {
  await paths.onSignOut?.(account).catch(() => undefined);
  await signOut(send, account);
  clearAccount(paths.account);
  forgetHostedModels(paths.models);
}

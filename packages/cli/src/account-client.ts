import type { Account, HostedModels } from "./account.ts";

/** Something the person can act on, in plain words. */
export class AccountError extends Error {}

const hostOf = (server: string): string => { try { return new URL(server).host; } catch { return server; } };
const base = (server: string): string => server.replace(/\/+$/, "");

async function ask(send: typeof fetch, server: string, path: string, init: RequestInit): Promise<Response> {
  try { return await send(`${base(server)}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) }); }
  catch { throw new AccountError(`Could not reach ${hostOf(server)}. Check your internet connection and try again.`); }
}

async function problem(res: Response): Promise<AccountError> {
  const body = await res.json().catch(() => undefined) as { error?: { message?: unknown } } | undefined;
  const message = typeof body?.error?.message === "string" ? body.error.message : undefined;
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    return new AccountError(`Too many tries. Wait ${wait > 60 ? `${Math.ceil(wait / 60)} minutes` : "a minute"} and try again.`);
  }
  return new AccountError(message ?? `The server answered ${res.status}. Try again in a moment.`);
}

const json = { "content-type": "application/json" };

/** Signs in with an email and password and gives back the token for this computer. The password is not kept. */
export async function signIn(send: typeof fetch, server: string, email: string, password: string, label: string): Promise<Account> {
  const res = await ask(send, server, "/api/account/token", { method: "POST", headers: json, body: JSON.stringify({ email, password, name: label }) });
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { user?: { email?: string }; token?: string };
  if (typeof body.token !== "string") throw new AccountError("The server did not give a sign-in. Try again in a moment.");
  return { server: base(server), token: body.token, email: body.user?.email ?? email };
}

/** Makes a new account. It does not sign in: the caller does that next with the same details. */
export async function createAccount(send: typeof fetch, server: string, email: string, password: string): Promise<void> {
  const res = await ask(send, server, "/api/account/register", { method: "POST", headers: json, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw await problem(res);
}

/** Cancels the token on the server. Best effort: a computer that cannot reach it still signs out locally. */
export async function signOut(send: typeof fetch, account: Account): Promise<void> {
  await ask(send, account.server, "/api/account/token", { method: "DELETE", headers: { authorization: `Bearer ${account.token}` } }).catch(() => undefined);
}

export async function fetchModels(send: typeof fetch, account: Account, signal?: AbortSignal): Promise<HostedModels> {
  const res = await ask(send, account.server, "/v1/models", { headers: { authorization: `Bearer ${account.token}` }, ...(signal ? { signal } : {}) });
  if (res.status === 401) throw new AccountError("You were signed out of your navvied account. Type /login to sign in again.");
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { default?: unknown; data?: unknown };
  const models = Array.isArray(body.data) ? body.data as HostedModels["models"] : [];
  return { ...(typeof body.default === "string" ? { default: body.default } : {}), models };
}

/** The free models a computer without an account may use, as the server lists them (`GET /v1/models` with no sign-in). */
export async function fetchGuestModels(send: typeof fetch, server: string, signal?: AbortSignal): Promise<HostedModels & { tokensPerDay?: number }> {
  const res = await ask(send, server, "/v1/models", { ...(signal ? { signal } : {}) });
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { default?: unknown; data?: unknown; guest?: unknown; tokensPerDay?: unknown };
  if (body.guest !== true) throw new AccountError("That server does not offer free models.");
  const models = Array.isArray(body.data) ? body.data as HostedModels["models"] : [];
  return { ...(typeof body.default === "string" ? { default: body.default } : {}), models, ...(typeof body.tokensPerDay === "number" ? { tokensPerDay: body.tokensPerDay } : {}) };
}

export interface DeviceRequest { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }
export type DevicePoll = { state: "pending" } | { state: "approved"; account: Account } | { state: "denied" } | { state: "expired" };

/** Asks the server for a code the person can approve in the browser. */
export async function startDevice(send: typeof fetch, server: string, label: string): Promise<DeviceRequest> {
  const res = await ask(send, server, "/api/account/device", { method: "POST", headers: json, body: JSON.stringify({ name: label }) });
  if (!res.ok) throw await problem(res);
  const body = await res.json() as Partial<DeviceRequest>;
  if (typeof body.deviceCode !== "string" || typeof body.userCode !== "string" || typeof body.verificationUrl !== "string") throw new AccountError("The server did not give a code. Try again in a moment.");
  return { deviceCode: body.deviceCode, userCode: body.userCode, verificationUrl: body.verificationUrl, expiresIn: Number(body.expiresIn) || 600, interval: Math.max(1, Number(body.interval) || 2) };
}

/** Asks whether the person has approved yet. A server that says "too often" is simply asked again later. */
export async function pollDevice(send: typeof fetch, server: string, deviceCode: string): Promise<DevicePoll> {
  const res = await ask(send, server, "/api/account/device/token", { method: "POST", headers: json, body: JSON.stringify({ deviceCode }) });
  if (res.status === 400 || res.status === 429) return { state: "pending" };
  if (res.status === 403) return { state: "denied" };
  if (res.status === 410) return { state: "expired" };
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { user?: { email?: string }; token?: string };
  if (typeof body.token !== "string") throw new AccountError("The server did not give a sign-in. Try again in a moment.");
  return { state: "approved", account: { server: base(server), token: body.token, email: body.user?.email ?? "your account" } };
}

/** Tells the account this computer is one of its computers, with the secret a signed-in page needs to reach it through the relay. */
export async function connectComputer(send: typeof fetch, account: Account, name: string, secret: string, id?: string): Promise<string> {
  const res = await ask(send, account.server, "/api/account/computers", { method: "POST", headers: { ...json, authorization: `Bearer ${account.token}` }, body: JSON.stringify({ name, secret, ...(id ? { id } : {}) }) });
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { id?: unknown };
  if (typeof body.id !== "string") throw new AccountError("The server did not answer as expected. Try again in a moment.");
  return body.id;
}

/** Takes this computer off the account. Best effort, like signing out. */
export async function disconnectComputer(send: typeof fetch, account: Account, id: string): Promise<void> {
  await ask(send, account.server, `/api/account/computers/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${account.token}` } }).catch(() => undefined);
}

export interface RemoteConversation { id: string; title: string; updated: number; source: string; messages: number; project?: string; /** Absent: an agent conversation. */ kind?: "chat" }

/** The conversations the account holds, newest first. */
export async function listConversations(send: typeof fetch, account: Account): Promise<RemoteConversation[]> {
  const res = await ask(send, account.server, "/api/account/conversations", { headers: { authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { conversations?: unknown };
  return Array.isArray(body.conversations) ? body.conversations as RemoteConversation[] : [];
}

export async function getConversation(send: typeof fetch, account: Account, id: string): Promise<{ items: { k: "user" | "assistant" | "tool"; text: string }[] } | undefined> {
  const res = await ask(send, account.server, `/api/account/conversations/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { items?: unknown };
  return Array.isArray(body.items) ? { items: body.items as { k: "user" | "assistant" | "tool"; text: string }[] } : undefined;
}

export interface AccountComputer { id: string; name: string; secret: string }

/** The computers of the account, with the secret a signed-in program needs to reach each through the relay. */
export async function listComputers(send: typeof fetch, account: Account): Promise<AccountComputer[]> {
  const res = await ask(send, account.server, "/api/account/computers", { headers: { authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw await problem(res);
  const body = await res.json() as { computers?: unknown };
  return Array.isArray(body.computers) ? (body.computers as Record<string, unknown>[]).filter((c) => typeof c.id === "string" && typeof c.name === "string" && typeof c.secret === "string").map((c) => ({ id: c.id as string, name: c.name as string, secret: c.secret as string })) : [];
}

/** Deletes a conversation from the account. Best effort. */
export async function deleteConversation(send: typeof fetch, account: Account, id: string): Promise<void> {
  await ask(send, account.server, `/api/account/conversations/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${account.token}` } }).catch(() => undefined);
}

/** Gives the computer a new name on the account. Best effort. */
export async function renameComputer(send: typeof fetch, account: Account, id: string, name: string): Promise<void> {
  await ask(send, account.server, `/api/account/computers/${id}`, { method: "PATCH", headers: { ...json, authorization: `Bearer ${account.token}` }, body: JSON.stringify({ name }) }).catch(() => undefined);
}

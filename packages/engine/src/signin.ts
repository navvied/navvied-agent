import { spawnSync } from "./process-start.ts";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { SIGN_IN_PROVIDERS } from "./signin-program.ts";

/** What a sign-in gives a request to a model: the key part, as headers, and a change to the body when the service insists on one. */
export interface Credentials {
  /** The headers that carry the sign-in. May refresh it first. Rejects when it cannot. */
  headers(incoming: Headers): Promise<Record<string, string>>;
  body(body: Record<string, unknown>): Record<string, unknown>;
  /** False once the service has turned the saved login down, until a new one is saved. */
  usable?(): boolean;
}

export interface Tokens { access: string; refresh: string; expiresAt: number }

/** One service that people sign in to from a program on a computer: how its saved login is read, refreshed and used. */
export interface SignInProvider {
  /** The API the model is reached with when this sign-in is used. */
  kind: "messages" | "responses";
  read(text: string): Tokens | undefined;
  write(text: string, tokens: Tokens): string;
  /** The new tokens; `"rejected"` when the service says the login is no longer good; nothing when it could not be asked. */
  refresh(refresh: string, send: typeof fetch, now: number): Promise<Tokens | "rejected" | undefined>;
  headers(access: string, incoming: Headers): Record<string, string>;
  body(body: Record<string, unknown>): Record<string, unknown>;
}

export const signInProvider = (id: string): SignInProvider | undefined => SIGN_IN_PROVIDERS[id];
export const signInProviderIds = (): string[] => Object.keys(SIGN_IN_PROVIDERS);

const SOON_MS = 5 * 60_000;

/** Where a saved login lives. A file only its owner can read, or (on a Mac) the keychain, where some programs keep theirs. */
export interface LoginStore {
  read(): string | undefined;
  write(text: string): void;
}

export function fileStore(file: string): LoginStore {
  return {
    read() { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    write(text) {
      writeFileSync(`${file}.new`, text, { mode: 0o600 });
      chmodSync(`${file}.new`, 0o600);
      renameSync(`${file}.new`, file);
    },
  };
}

/** The macOS keychain item a program saved its login in. Reading asks the system, which may ask the person once. */
export function keychainStore(service: string, account: string, run: (args: string[]) => { status: number | null; stdout: string } = (args) => { const r = spawnSync("security", args, { encoding: "utf8", timeout: 20_000 }); return { status: r.status, stdout: r.stdout ?? "" }; }): LoginStore {
  return {
    read() { const r = run(["find-generic-password", "-s", service, "-w"]); return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined; },
    write(text) { const r = run(["add-generic-password", "-U", "-s", service, "-a", account, "-w", text]); if (r.status !== 0) throw new Error("the keychain did not accept the new login"); },
  };
}

/** A saved login. It is refreshed shortly before it runs out, by one caller at a time, and written back at once. */
export interface LoginWords {
  /** Said when the service has turned the login down: what to do about it. */
  again?: string;
  /** Said when nothing is saved: where it was looked for. */
  missing?: string;
}

export class StoreCredentials implements Credentials {
  #tokens: Tokens;
  #refreshing?: Promise<void>;
  /** The refresh token the service turned down. Nothing is asked of it again until the store holds another. */
  #turnedDown?: string;

  constructor(private readonly store: LoginStore, private readonly provider: SignInProvider, private readonly send: typeof fetch = fetch, private readonly now: () => number = Date.now, private readonly words: LoginWords = {}) {
    const text = store.read();
    const tokens = text === undefined ? undefined : provider.read(text);
    if (!tokens) throw new Error(words.missing ?? "no saved sign-in was found");
    this.#tokens = tokens;
  }

  usable(): boolean { return this.#turnedDown === undefined || this.#saved()?.refresh !== this.#turnedDown; }

  async headers(incoming: Headers): Promise<Record<string, string>> {
    if (this.#turnedDown !== undefined) {
      const fresh = this.#saved();
      if (!fresh || fresh.refresh === this.#turnedDown) throw new Error(`the saved sign-in was turned down: ${this.words.again ?? "sign in again on the server"}`);
      this.#tokens = fresh;
      this.#turnedDown = undefined;
    }
    if (this.#tokens.expiresAt - this.now() < SOON_MS) await this.#refresh();
    return this.provider.headers(this.#tokens.access, incoming);
  }

  body(body: Record<string, unknown>): Record<string, unknown> { return this.provider.body(body); }

  #saved(): Tokens | undefined { const text = this.store.read(); return text === undefined ? undefined : this.provider.read(text); }

  #refresh(): Promise<void> {
    return this.#refreshing ??= (async () => {
      try {
        // Another program using the same login may have refreshed it meanwhile: its newer tokens are used instead of asking again.
        const other = this.#saved();
        if (other && other.refresh !== this.#tokens.refresh && other.expiresAt - this.now() >= SOON_MS) { this.#tokens = other; return; }
        const fresh = await this.provider.refresh(this.#tokens.refresh, this.send, this.now());
        if (fresh === "rejected") { this.#turnedDown = this.#tokens.refresh; throw new Error(`the saved sign-in was turned down: ${this.words.again ?? "sign in again on the server"}`); }
        if (!fresh) throw new Error("the sign-in could not be refreshed");
        this.#tokens = fresh;
        const text = this.store.read();
        if (text !== undefined) this.store.write(this.provider.write(text, fresh));
      } finally { this.#refreshing = undefined; }
    })();
  }
}

/** A saved login in a file. */
export class FileCredentials extends StoreCredentials {
  constructor(file: string, provider: SignInProvider, send: typeof fetch = fetch, now: () => number = Date.now, words: LoginWords = {}) {
    super(fileStore(file), provider, send, now, { missing: `${file} holds no saved sign-in`, ...words });
  }
}

/** A saved login that may not be there yet: it is read the first time it can be, so a login saved while the program runs is used from the next message. */
export class LazyCredentials implements Credentials {
  #inner?: StoreCredentials;

  constructor(private readonly store: LoginStore | string, private readonly provider: SignInProvider, private readonly send: typeof fetch = fetch, private readonly now: () => number = Date.now, private readonly words: LoginWords = {}) {}

  #open(): StoreCredentials | undefined {
    if (!this.#inner) { try { this.#inner = new StoreCredentials(typeof this.store === "string" ? fileStore(this.store) : this.store, this.provider, this.send, this.now, this.words); } catch { return undefined; } }
    return this.#inner;
  }

  usable(): boolean { return this.#open()?.usable() ?? false; }

  async headers(incoming: Headers): Promise<Record<string, string>> {
    const inner = this.#open();
    if (!inner) throw new Error(this.words.missing ?? "there is no saved sign-in: sign in on the server");
    return inner.headers(incoming);
  }

  body(body: Record<string, unknown>): Record<string, unknown> { return this.provider.body(body); }
}

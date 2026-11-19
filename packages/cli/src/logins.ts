import { homedir } from "node:os";
import { join } from "node:path";
import { LazyCredentials, fileStore, keychainStore, signInProvider, type Credentials, type LoginStore } from "@navvied/engine";

/** A saved login that may be in more than one place: the first one that holds a login is read, and a refreshed login is written back to the same one. */
export function chainStore(stores: readonly LoginStore[], usable: (text: string) => boolean): LoginStore {
  let used: LoginStore | undefined;
  return {
    read() { for (const s of stores) { const text = s.read(); if (text !== undefined && usable(text)) { used = s; return text; } } return undefined; },
    write(text) { (used ?? stores[0]!).write(text); },
  };
}

type Env = Record<string, string | undefined>;

/** Where the program that made a login keeps it. A Mac keeps Claude's in the keychain, with the file as a second place to look. */
export function loginStoreFor(provider: string, file: string | undefined, env: Env, platform: NodeJS.Platform = process.platform): LoginStore {
  if (file) return fileStore(file);
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const known = signInProvider(provider);
  const usable = (text: string): boolean => known?.read(text) !== undefined;
  if (provider === "claude") {
    const own = fileStore(join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"));
    return platform === "darwin" ? chainStore([keychainStore("Claude Code-credentials", env.USER ?? "user"), own], usable) : own;
  }
  return fileStore(join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json"));
}

/** The sign-in of a model entry: read when first needed, so a login made after navvied started is used from the next message. */
export function credentialsFor(signIn: { provider: string; file?: string }, env: Env, platform: NodeJS.Platform = process.platform): Credentials | undefined {
  const known = signInProvider(signIn.provider);
  if (!known) return undefined;
  const program = signIn.provider === "claude" ? "Claude Code" : "Codex";
  return new LazyCredentials(loginStoreFor(signIn.provider, signIn.file, env, platform), known, fetch, Date.now, {
    missing: `No ${program} sign-in was found on this computer. Open ${program} once and sign in, then try again.`,
    again: `open ${program} and sign in again`,
  });
}

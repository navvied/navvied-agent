import { execFile as nodeExecFile, spawn as nodeSpawn, spawnSync as nodeSpawnSync, type ChildProcess, type ChildProcessByStdio, type ExecFileException, type ExecFileOptions, type SpawnOptions, type SpawnOptionsWithStdioTuple, type SpawnSyncOptions, type SpawnSyncReturns, type StdioNull, type StdioPipe } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { childEnv, secretNames, type EnvPolicy } from "./child-env.ts";
import { secretsNow } from "./redact.ts";

export type { ChildProcess } from "node:child_process";

const SERVER_BASE = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "ALLUSERSPROFILE", "APPDATA", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "COMPUTERNAME", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "PATHEXT",
  "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PUBLIC", "SYSTEMDRIVE", "SYSTEMROOT", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
]);
const SERVER_BASE_PREFIX = "XDG_";
const PROXY_ADDRESS = /^(HTTPS?|ALL)_PROXY$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function withoutCredentials(address: string): string | undefined {
  if (!address.includes("@")) return address;
  try {
    const url = new URL(HAS_SCHEME.test(address) ? address : `http://${address}`);
    url.username = "";
    url.password = "";
    const bare = url.toString().replace(/\/$/, "");
    if (bare.includes("@")) return undefined;
    return HAS_SCHEME.test(address) ? bare : bare.replace(HAS_SCHEME, "");
  } catch { return undefined; }
}

const present = (vars: Record<string, string | undefined>): Record<string, string> => Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => e[1] !== undefined));

export class ChildEnv {
  private constructor(readonly vars: Readonly<Record<string, string>>) {}

  static scrubbed(from: NodeJS.ProcessEnv = process.env, policy: EnvPolicy = {}): ChildEnv {
    return new ChildEnv(present(childEnv(from, { ...policy, drop: [...secretNames(from), ...(policy.drop ?? [])] }, secretsNow(from))));
  }

  static forServer(from: NodeJS.ProcessEnv = process.env): ChildEnv {
    const base = Object.entries(from).filter(([name]) => SERVER_BASE.has(name.toUpperCase()) || name.startsWith(SERVER_BASE_PREFIX));
    return new ChildEnv(present(Object.fromEntries(base.map(([name, value]) => [name, value !== undefined && PROXY_ADDRESS.test(name) ? withoutCredentials(value) : value]))));
  }

  static forNavvied(from: NodeJS.ProcessEnv = process.env): ChildEnv { return new ChildEnv(present(from)); }

  with(added: Readonly<Record<string, string>> = {}): ChildEnv { return new ChildEnv({ ...this.vars, ...added }); }
}

type Given<Options> = Omit<Options, "env"> & { env?: ChildEnv };

const handed = <Options extends object>(o: Given<Options>): Omit<Options, "env"> & { env: Record<string, string> } => ({ ...(o as Omit<Options, "env">), env: { ...(o.env ?? ChildEnv.scrubbed()).vars } });

type Piped<Stdio, Stream> = Stdio extends StdioPipe ? Stream : null;

export function spawn<In extends StdioNull | StdioPipe, Out extends StdioNull | StdioPipe, Err extends StdioNull | StdioPipe>(file: string, args: readonly string[], options: Given<SpawnOptionsWithStdioTuple<In, Out, Err>>): ChildProcessByStdio<Piped<In, Writable>, Piped<Out, Readable>, Piped<Err, Readable>>;
export function spawn(file: string, args: readonly string[], options?: Given<SpawnOptions>): ChildProcess;
export function spawn(file: string, args: readonly string[], options: Given<SpawnOptions> = {}): ChildProcess { return nodeSpawn(file, args, handed<SpawnOptions>(options)); }

export function spawnSync(file: string, args: readonly string[], options: Given<SpawnSyncOptions> & { encoding: BufferEncoding }): SpawnSyncReturns<string>;
export function spawnSync(file: string, args: readonly string[], options?: Given<SpawnSyncOptions>): SpawnSyncReturns<Buffer>;
export function spawnSync(file: string, args: readonly string[], options: Given<SpawnSyncOptions> = {}): SpawnSyncReturns<string | Buffer> { return nodeSpawnSync(file, args, handed<SpawnSyncOptions>(options)); }

export const execFile = (file: string, args: readonly string[], options: Given<ExecFileOptions>, done: (error: ExecFileException | null, stdout: string, stderr: string) => void): ChildProcess =>
  nodeExecFile(file, args, { ...handed<ExecFileOptions>(options), encoding: "utf8" }, done);

export function bunSpawn<const In extends Bun.Spawn.Writable = "ignore", const Out extends Bun.Spawn.Readable = "pipe", const Err extends Bun.Spawn.Readable = "inherit">(argv: string[], options: Omit<Bun.Spawn.SpawnOptions<In, Out, Err>, "env"> & { env?: ChildEnv } = {}): Bun.Subprocess<In, Out, Err> {
  return Bun.spawn(argv, { ...options, env: { ...(options.env ?? ChildEnv.scrubbed()).vars } } as Bun.Spawn.SpawnOptions<In, Out, Err>);
}

export function bunSpawnSync<const In extends Bun.Spawn.Writable = "ignore", const Out extends Bun.Spawn.Readable = "pipe", const Err extends Bun.Spawn.Readable = "pipe">(argv: string[], options: Omit<Bun.Spawn.SpawnSyncOptions<In, Out, Err>, "env"> & { env?: ChildEnv } = {}): Bun.SyncSubprocess<Out, Err> {
  return Bun.spawnSync(argv, { ...options, env: { ...(options.env ?? ChildEnv.scrubbed()).vars } } as Bun.Spawn.SpawnSyncOptions<In, Out, Err>);
}

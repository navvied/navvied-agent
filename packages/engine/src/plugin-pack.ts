/**
 * Plugin packages: a folder with `navvied-plugin.json` that brings skills, helpers (agents), commands, hooks and tool servers.
 *
 *   my-plugin/
 *     navvied-plugin.json   name, version, description, and everything it brings
 *     skills/<name>/SKILL.md
 *     agents/<name>.md
 *     commands/<name>.md    a custom slash command; `$ARGUMENTS` and `$1`..`$9` are filled in
 *
 * Installing copies the folder into the person's plugin folder and records a fingerprint of its files (sha-256) in a lock file;
 * nothing in it is run. The fingerprint is checked again every time the plugin is loaded. A plugin is read as hostile text:
 * sizes are limited, links and paths that leave the folder are refused, and what the manifest says it brings must be exactly what is in the folder.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { forbidden, scanCommand } from "./command-scan.ts";
import { isZip, unzipTo } from "./zip-unpack.ts";
import { gitEnv } from "./git-env.ts";
import { HOOK_EVENTS, type HookCommand, type HookConfig, type HookEvent } from "./hooks.ts";
import type { McpServerConfig } from "./mcp.ts";
import { parseFrontmatter } from "./skills.ts";
import { scanText } from "./text-scan.ts";

export const MANIFEST = "navvied-plugin.json";
export const LIMITS = { manifest: 64 * 1024, file: 5 * 1024 * 1024, total: 20 * 1024 * 1024, files: 2000, depth: 12, archive: 20 * 1024 * 1024, unpacked: 64 * 1024 * 1024, listed: 100, command: 30_000 } as const;

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface Run {
  /** What runs: `PreToolUse (Bash)`, or `tool server files`. */
  what: string;
  /** The command line or the address. */
  command: string;
  /** Where it comes from: `plugin:name`. */
  source: string;
  /** What reading the command found (deletes, sends, secret reads, administrator rights, run without looking), in words; missing when nothing. */
  findings?: string[];
}

export interface Pack {
  name: string;
  version: string;
  description: string;
  dir: string;
  source: "user" | "project";
  /** sha-256 of the files, as recorded at install for the person's own plugins. */
  hash: string;
  /** Why it cannot be used, in words; a plugin with a problem brings nothing. */
  problem?: string;
  skills: string[];
  agents: string[];
  commands: string[];
  hooks: HookConfig;
  mcp: Record<string, McpServerConfig>;
  /** Every command it would run, each with its source. */
  runs: Run[];
  /** What the scan of the text it hands to the model found (instructions to ignore rules, hidden characters, secret-reading commands), in words, each with the file. */
  findings: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sha = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

function readLimited(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > max) throw new Error("too large");
    const buf = Buffer.alloc(stat.size);
    let at = 0;
    while (at < buf.length) { const n = readSync(fd, buf, at, buf.length - at, at); if (!n) break; at += n; }
    return buf.subarray(0, at);
  } finally { closeSync(fd); }
}

/** One regular file of a plugin: its path with forward slashes, and its text. */
export interface Entry { rel: string; data: Buffer; mode: number }

/** Reads a folder as a hostile tree: no links, nothing but regular files, within the limits. `.git` is not part of a plugin. */
export function readTree(root: string): { entries: Entry[] } | { error: string } {
  const entries: Entry[] = [];
  let total = 0;
  const walk = (dir: string, rel: string, depth: number): string | undefined => {
    if (depth > LIMITS.depth) return `it nests folders deeper than ${LIMITS.depth} levels`;
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return `a folder cannot be read (${rel || "."})`; }
    for (const name of names) {
      if (name === ".git") continue;
      const path = join(dir, name), shown = rel ? `${rel}/${name}` : name;
      let stat;
      try { stat = lstatSync(path); } catch { return `${shown} cannot be read`; }
      if (stat.isSymbolicLink()) return `it contains a link (${shown}), which a plugin may not have`;
      if (stat.isDirectory()) { const bad = walk(path, shown, depth + 1); if (bad) return bad; continue; }
      if (!stat.isFile()) return `${shown} is not an ordinary file`;
      if (stat.size > LIMITS.file) return `${shown} is larger than ${LIMITS.file / 1024 / 1024} MB`;
      total += stat.size;
      if (total > LIMITS.total) return `it is larger than ${LIMITS.total / 1024 / 1024} MB`;
      if (entries.length >= LIMITS.files) return `it has more than ${LIMITS.files} files`;
      try { entries.push({ rel: shown, data: readLimited(path, LIMITS.file), mode: stat.mode & 0o777 }); } catch { return `${shown} cannot be read`; }
    }
    return undefined;
  };
  const error = walk(root, "", 0);
  return error ? { error } : { entries };
}

/** sha-256 over the sorted file paths and the sha-256 of each file's content. */
export const treeHash = (entries: readonly Entry[]): string => {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => (a.rel < b.rel ? -1 : 1))) h.update(`${e.rel}\0${sha(e.data)}\n`);
  return h.digest("hex");
};

const stems = (entries: readonly Entry[], folder: string): string[] =>
  entries.filter((e) => e.rel.startsWith(`${folder}/`) && e.rel.endsWith(".md") && e.rel.split("/").length === 2).map((e) => basename(e.rel, ".md")).sort();
const skillNames = (entries: readonly Entry[]): string[] =>
  entries.filter((e) => /^skills\/[^/]+\/SKILL\.md$/.test(e.rel)).map((e) => e.rel.split("/")[1]!).sort();

const nameList = (raw: unknown, what: string): string[] | string => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > LIMITS.listed || !raw.every((n) => typeof n === "string" && NAME.test(n))) return `"${what}" must be a list of simple names (letters, digits, - and _, at most ${LIMITS.listed})`;
  return [...new Set(raw as string[])].sort();
};

function parseHooks(raw: unknown, source: string, root: string): HookConfig | string {
  if (raw === undefined) return {};
  if (!isObject(raw)) return `"hooks" must be an object of events`;
  const out: HookConfig = {};
  for (const [event, list] of Object.entries(raw)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) return `"hooks": ${event} is not an event (${HOOK_EVENTS.join(", ")})`;
    if (!Array.isArray(list) || list.length > 20) return `"hooks": ${event} must be a list of at most 20 commands`;
    const commands: HookCommand[] = [];
    for (const h of list) {
      if (!isObject(h) || typeof h.command !== "string" || !h.command || h.command.length > 2000) return `"hooks": ${event} needs { "command": "…" } entries`;
      if (h.matcher !== undefined && (typeof h.matcher !== "string" || h.matcher.length > 200)) return `"hooks": a matcher must be short text`;
      if (h.timeout !== undefined && (typeof h.timeout !== "number" || !(h.timeout > 0) || h.timeout > 600)) return `"hooks": a timeout is a number of seconds, at most 600`;
      commands.push({ command: h.command, ...(typeof h.matcher === "string" ? { matcher: h.matcher } : {}), ...(typeof h.timeout === "number" ? { timeout: h.timeout } : {}), source, root });
    }
    if (commands.length) out[event as HookEvent] = commands;
  }
  return out;
}

const here = (text: string, root: string): string => text.replaceAll("${NAVVIED_PLUGIN_ROOT}", root);

function parseMcp(raw: unknown, root: string): Record<string, McpServerConfig> | string {
  if (raw === undefined) return {};
  if (!isObject(raw) || Object.keys(raw).length > 20) return `"mcp" must be an object of at most 20 tool servers`;
  const out: Record<string, McpServerConfig> = {};
  const strings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 500);
  for (const [name, v] of Object.entries(raw)) {
    if (!NAME.test(name) || !isObject(v)) return `"mcp": ${name} must be an object with a simple name`;
    const url = typeof v.url === "string" && v.url, command = typeof v.command === "string" && v.command;
    if (!url === !command) return `"mcp": ${name} needs a command or a url, not both`;
    if (url) {
      if (!/^https?:\/\//.test(url) || url.length > 500) return `"mcp": ${name}: url must start with http:// or https://`;
      out[name] = { url, ...(isObject(v.headers) ? { headers: Object.fromEntries(Object.entries(v.headers).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}) };
      continue;
    }
    if (v.args !== undefined && !strings(v.args, 50)) return `"mcp": ${name}: args must be a short list of text`;
    if ((command as string).length > 500) return `"mcp": ${name}: command is too long`;
    out[name] = { command: here(command as string, root), ...(Array.isArray(v.args) ? { args: (v.args as string[]).map((a) => here(a, root)) } : {}), ...(isObject(v.env) ? { env: Object.fromEntries(Object.entries(v.env).filter((e): e is [string, string] => typeof e[1] === "string")) } : {}), cwd: typeof v.cwd === "string" ? here(v.cwd, root) : root };
  }
  return out;
}

const runsOf = (name: string, hooks: HookConfig, mcp: Record<string, McpServerConfig>): Run[] => {
  const run = (what: string, command: string, shell: boolean): Run => {
    const findings = shell ? scanCommand(command) : [];
    return { what, command, source: `plugin:${name}`, ...(findings.length ? { findings } : {}) };
  };
  return [
    ...Object.entries(hooks).flatMap(([event, list]) => (list ?? []).map((h) => run(`${event}${h.matcher ? ` (${h.matcher})` : ""}`, h.command, true))),
    ...Object.entries(mcp).map(([server, e]) => run(`tool server ${server}`, e.url ?? [e.command, ...(e.args ?? [])].filter(Boolean).join(" "), !e.url)),
  ];
};

/** Reads and checks a plugin that is on disk. The folder is read once; what is checked is what is hashed. */
export function readPack(dir: string, source: Pack["source"]): Pack {
  const empty = (problem: string, name = basename(dir)): Pack => ({ name, version: "", description: "", dir, source, hash: "", problem, skills: [], agents: [], commands: [], hooks: {}, mcp: {}, runs: [], findings: [] });
  const tree = readTree(dir);
  if ("error" in tree) return empty(tree.error);
  const { entries } = tree;
  const manifestFile = entries.find((e) => e.rel === MANIFEST);
  if (!manifestFile) return empty(`it has no ${MANIFEST}`);
  if (manifestFile.data.length > LIMITS.manifest) return empty(`${MANIFEST} is larger than ${LIMITS.manifest / 1024} KB`);
  let raw: unknown;
  try { raw = JSON.parse(manifestFile.data.toString("utf8")); } catch { return empty(`${MANIFEST} is not valid JSON`); }
  if (!isObject(raw)) return empty(`${MANIFEST} must be an object`);
  const hash = treeHash(entries);
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) return empty(`${MANIFEST}: "name" must be a simple name (lower case letters, digits, - and _)`);
  const name = raw.name;
  const fail = (problem: string): Pack => ({ ...empty(problem, name), hash });
  if (typeof raw.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(raw.version)) return fail(`${MANIFEST}: "version" is missing or not a version such as 1.0.0`);
  if (typeof raw.description !== "string" || raw.description.length > 300) return fail(`${MANIFEST}: "description" is missing or longer than 300 characters`);
  const declared = { skills: nameList(raw.skills, "skills"), agents: nameList(raw.agents, "agents"), commands: nameList(raw.commands, "commands") };
  for (const [k, v] of Object.entries(declared)) if (typeof v === "string") return fail(`${MANIFEST}: ${v}`);
  const found = { skills: skillNames(entries), agents: stems(entries, "agents"), commands: stems(entries, "commands") };
  for (const kind of ["skills", "agents", "commands"] as const) {
    const have = declared[kind] as string[], real = found[kind];
    const extra = real.filter((n) => !have.includes(n)), missing = have.filter((n) => !real.includes(n));
    if (extra.length) return fail(`it brings ${kind} that ${MANIFEST} does not list: ${extra.slice(0, 5).join(", ")}`);
    if (missing.length) return fail(`${MANIFEST} lists ${kind} that are not in the folder: ${missing.slice(0, 5).join(", ")}`);
  }
  const hooks = parseHooks(raw.hooks, `plugin:${name}`, dir);
  if (typeof hooks === "string") return fail(`${MANIFEST}: ${hooks}`);
  const mcp = parseMcp(raw.mcp, dir);
  if (typeof mcp === "string") return fail(`${MANIFEST}: ${mcp}`);
  const findings = entries.filter((e) => /^(skills\/[^/]+\/SKILL|agents\/[^/]+|commands\/[^/]+)\.md$/.test(e.rel)).flatMap((e) => scanText(e.data.toString("utf8")).map((f) => `${e.rel}: ${f}`)).slice(0, 20);
  const runs = runsOf(name, hooks, mcp);
  for (const r of runs) { const why = r.command.startsWith("http") ? undefined : forbidden(r.command); if (why) return fail(`${r.what} runs a command that may never run: ${r.command.slice(0, 80)} (${why})`); }
  return { name, version: raw.version, description: raw.description, dir, source, hash, ...found, hooks, mcp, runs, findings };
}

/** What was installed, and from where. Kept next to the person's own configuration. */
export class PluginLock {
  constructor(private readonly file: string) {}
  read(): Record<string, { hash: string; version: string; source: string; at: string }> {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { plugins?: unknown };
      if (!isObject(raw.plugins)) return {};
      const out: ReturnType<PluginLock["read"]> = {};
      for (const [name, v] of Object.entries(raw.plugins)) if (isObject(v) && typeof v.hash === "string" && typeof v.version === "string" && typeof v.source === "string" && typeof v.at === "string") out[name] = { hash: v.hash, version: v.version, source: v.source, at: v.at };
      return out;
    } catch { return {}; }
  }
  #write(plugins: ReturnType<PluginLock["read"]>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  set(name: string, entry: { hash: string; version: string; source: string }, now: Date = new Date()): void { this.#write({ ...this.read(), [name]: { ...entry, at: now.toISOString() } }); }
  delete(name: string): void { const all = this.read(); if (name in all) { delete all[name]; this.#write(all); } }
}

/** The plugins in the person's folder (each must match the lock) and in the project folders (each waits for the person's say-so). */
export function loadPacks(dirs: { user?: string; lock?: PluginLock; project?: string[] }): Pack[] {
  const byName = new Map<string, Pack>();
  const each = (root: string, source: Pack["source"], check?: (p: Pack) => string | undefined): void => {
    let names: string[];
    try { names = readdirSync(root).sort(); } catch { return; }
    for (const folder of names.slice(0, 200)) {
      const dir = join(root, folder);
      try { if (!lstatSync(dir).isDirectory()) continue; } catch { continue; }
      let pack = readPack(dir, source);
      if (!pack.problem && pack.name !== folder) pack = { ...pack, problem: `its folder is called ${folder} but its name is ${pack.name}` };
      const bad = pack.problem ? undefined : check?.(pack);
      if (bad) pack = { ...pack, problem: bad };
      byName.set(pack.name === basename(dir) || !pack.problem ? pack.name : folder, pack);
    }
  };
  if (dirs.user) {
    const lock = dirs.lock?.read() ?? {};
    each(dirs.user, "user", (p) => (!lock[p.name] ? "it was not installed with navvied (it is not in the lock file)" : lock[p.name]!.hash !== p.hash ? "its files changed since it was installed" : undefined));
  }
  for (const root of dirs.project ?? []) each(root, "project");
  return [...byName.values()];
}

export const packDirs = (cwdDirs: readonly string[]): string[] => cwdDirs.map((d) => join(d, ".navvied", "plugins"));

export interface PackCommand { name: string; description: string; hint: string; body: string; plugin: string }

/** The custom slash commands of the plugins given (the caller passes only those that are on and accepted). `name` is how it is typed: `/name`, and `/plugin:name` always works too. */
export function packCommands(packs: readonly Pack[]): PackCommand[] {
  const out: PackCommand[] = [];
  for (const pack of packs) {
    if (pack.problem) continue;
    for (const name of pack.commands) {
      try {
        const text = readLimited(join(pack.dir, "commands", `${name}.md`), LIMITS.command * 2).toString("utf8");
        const { meta, body } = parseFrontmatter(text);
        const one = (v: unknown): string => (typeof v === "string" ? v : "");
        out.push({ name, description: (one(meta.description) || body.trim().split(/\r?\n/)[0]?.replace(/^#+\s*/, "") || name).slice(0, 200), hint: one(meta["argument-hint"]).slice(0, 80), body: body.trim().slice(0, LIMITS.command), plugin: pack.name });
      } catch { /* a command that cannot be read is not offered */ }
    }
  }
  return out;
}

/** The text a command stands for, with the person's words filled in. The first plugin to bring a name owns the short form; every command can be reached as `plugin:name`. */
export function findCommand(commands: readonly PackCommand[], typed: string): PackCommand | undefined {
  return commands.find((c) => `${c.plugin}:${c.name}` === typed) ?? commands.find((c) => c.name === typed);
}

export function expandCommand(command: PackCommand, args: string): string {
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  const used = /\$(ARGUMENTS|[1-9])/.test(command.body);
  const filled = command.body.replace(/\$(ARGUMENTS|[1-9])/g, (_, k: string) => (k === "ARGUMENTS" ? args.trim() : words[Number(k) - 1] ?? ""));
  return !used && args.trim() ? `${filled}\n\nARGUMENTS: ${args.trim()}` : filled;
}

export interface InstallOptions {
  /** A folder, a `.tar.gz`/`.tgz`/`.tar`/`.zip` file or address, or a git address (`https://…/x.git`, `git@host:x.git`, with `#ref` for a branch or tag). */
  from: string;
  /** The folder the person's plugins are in. */
  root: string;
  lock: PluginLock;
  /** The sha-256 the person expects (at least 12 hex digits): a plugin with other files is refused. */
  expectHash?: string;
  /** Replace a plugin of the same name that is already installed. */
  replace?: boolean;
  fetch?: typeof fetch;
}

export type InstallResult = { ok: true; pack: Pack } | { ok: false; error: string };

const ARCHIVE = /\.(tar\.gz|tgz|tar|zip)$/i;
const GIT_ADDRESS = /^(https?:\/\/|ssh:\/\/|git:\/\/|git@|file:\/\/)/i;

const ADDRESS_WITH_HOST = /^[a-z][a-z0-9+.-]*:\/\//i;

export function plainSource(from: string): string {
  if (!ADDRESS_WITH_HOST.test(from)) return from;
  try { const u = new URL(from); u.username = ""; u.password = ""; return u.toString(); } catch { return from; }
}

const scratch = (parent: string): string => { const d = join(parent, `.incoming-${process.pid}-${randomBytes(4).toString("hex")}`); mkdirSync(d, { recursive: true }); return d; };

async function download(url: string, doFetch: typeof fetch): Promise<Buffer | string> {
  let res: Response;
  try { res = await doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) }); } catch (e) { return `the address could not be reached (${e instanceof Error ? e.message : String(e)})`; }
  if (!res.ok || !res.body) return `the address answered ${res.status}`;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > LIMITS.archive) return `the archive is larger than ${LIMITS.archive / 1024 / 1024} MB`;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const MOST_OF_TAR = 200;
const whatTarSaid = (ran: { status: number | null; stderr: string | Buffer | null; error?: Error }): string => (String(ran.stderr ?? "").split("\n").map((line) => line.trim()).find((line) => line !== "") ?? ran.error?.message ?? `tar ended with ${ran.status}`).slice(0, MOST_OF_TAR);

function unpack(archive: Buffer, into: string): string | undefined {
  if (archive.length > LIMITS.archive) return `the archive is larger than ${LIMITS.archive / 1024 / 1024} MB`;
  if (isZip(archive)) return unzipTo(archive, into, LIMITS);
  let tar = archive;
  if (archive[0] === 0x1f && archive[1] === 0x8b) {
    try { tar = gunzipSync(archive, { maxOutputLength: LIMITS.unpacked }); } catch { return `the archive is damaged or larger than ${LIMITS.unpacked / 1024 / 1024} MB when unpacked`; }
  }
  const listed = spawnSync("tar", ["-tf", "-"], { input: tar, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (listed.status !== 0) return `the archive cannot be read: ${whatTarSaid(listed)}`;
  const names = listed.stdout.split("\n").filter(Boolean);
  if (names.length > LIMITS.files * 2) return `the archive has more than ${LIMITS.files * 2} entries`;
  if (names.some((n) => n.startsWith("/") || n.startsWith("\\") || /^[A-Za-z]:/.test(n) || n.split(/[\\/]/).includes(".."))) return "the archive has a path that leaves its folder";
  const out = spawnSync("tar", ["-xf", "-", "-C", into, "--no-same-owner", "--no-same-permissions"], { input: tar, encoding: "utf8" });
  return out.status === 0 ? undefined : `the archive cannot be unpacked: ${whatTarSaid(out)}`;
}

function clone(address: string, into: string): Promise<string | undefined> {
  const at = address.lastIndexOf("#");
  const url = at > 0 ? address.slice(0, at) : address, ref = at > 0 ? address.slice(at + 1) : "";
  if (url.startsWith("-") || ref.startsWith("-")) return Promise.resolve("that is not an address");
  return new Promise((done) => {
    const child = spawn("git", ["clone", "--quiet", "--depth", "1", "--no-tags", ...(ref ? ["--branch", ref] : []), "--", url, into], { env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:ssh:git:file" }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    child.stderr?.on("data", (d: Buffer) => { err = (err + d).slice(-500); });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", () => { clearTimeout(timer); done("git could not be started"); });
    child.on("close", (code) => { clearTimeout(timer); done(code === 0 ? undefined : `git could not fetch it${err.trim() ? `: ${err.trim().split("\n").at(-1)}` : ""}`); });
  });
}

/** Writes the entries read from an untrusted tree into a fresh folder of ours, which is then what is checked and kept. */
function writeTree(entries: readonly Entry[], into: string): void {
  for (const e of entries) {
    const path = join(into, ...e.rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, e.data, { mode: e.mode & 0o755 });
  }
}

export type Staged = { ok: true; pack: Pack; staged: string; work: string } | { ok: false; error: string };

/** A source as the lock file keeps it: a local path is made absolute so it still means the same thing from another folder. */
export function recordedSource(from: string): string {
  const text = from.trim();
  return existsSync(text) ? resolve(text) : plainSource(text);
}

/**
 * Gets the files of a plugin from a folder, an archive or a git address (never running anything), reads them once as hostile input and
 * checks the manifest and the fingerprint the person expects. Nothing is put in the person's folder: the caller keeps `work` until it has
 * moved `staged` in with `swapIn` or has thrown it away with `discard`.
 */
export async function stagePlugin(o: { from: string; root: string; expectHash?: string; fetch?: typeof fetch }): Promise<Staged> {
  mkdirSync(o.root, { recursive: true });
  const work = scratch(o.root);
  const fail = (error: string): Staged => { rmSync(work, { recursive: true, force: true }); return { ok: false, error }; };
  const raw = join(work, "raw"), staged = join(work, "staged");
  mkdirSync(raw); mkdirSync(staged);
  const from = o.from.trim();
  if (!from) return fail("no source given");
  let problem: string | undefined;
  if (existsSync(from) && lstatSync(from).isDirectory()) {
    const tree = readTree(resolve(from));
    if ("error" in tree) problem = tree.error; else writeTree(tree.entries, raw);
  } else if (/^https?:\/\//i.test(from) && ARCHIVE.test(from.split(/[?#]/)[0]!)) {
    const got = await download(from, o.fetch ?? fetch);
    problem = typeof got === "string" ? got : unpack(got, raw);
  } else if (existsSync(from) && ARCHIVE.test(from)) {
    try { problem = unpack(readLimited(resolve(from), LIMITS.archive), raw); } catch { problem = "the archive cannot be read or is too large"; }
  } else if (GIT_ADDRESS.test(from) || /\.git(#.*)?$/.test(from)) {
    problem = await clone(from, raw);
  } else return fail("that is not a folder, an archive or a git address");
  if (problem) return fail(problem);
  // The tree may have a single top folder (an archive made from one): that folder is the plugin.
  let top = raw;
  const only = readdirSync(raw).filter((n) => n !== ".git");
  if (!existsSync(join(raw, MANIFEST)) && only.length === 1 && lstatSync(join(raw, only[0]!)).isDirectory()) top = join(raw, only[0]!);
  const tree = readTree(top);
  if ("error" in tree) return fail(tree.error);
  writeTree(tree.entries, staged);
  const pack = readPack(staged, "user");
  if (pack.problem) return fail(pack.problem);
  if (o.expectHash && !matchesFingerprint(pack.hash, o.expectHash)) return fail(`its files do not match the fingerprint given (they are ${pack.hash})`);
  return { ok: true, pack, staged, work };
}

/** Whether a fingerprint the person gave (at least 12 hex digits) is the start of the real one. */
export function matchesFingerprint(hash: string, given: string): boolean {
  const want = given.trim().toLowerCase();
  return want.length >= 12 && /^[0-9a-f]+$/.test(want) && hash.startsWith(want);
}

export const discard = (s: { work: string }): void => rmSync(s.work, { recursive: true, force: true });

/** Puts the staged folder in place of the one that is there; the old one is only removed with the scratch folder, and comes back if the move fails. */
export function swapIn(s: { staged: string; work: string }, target: string): void {
  const backup = join(s.work, "previous"), had = existsSync(target);
  if (had) renameSync(target, backup);
  try { renameSync(s.staged, target); } catch (e) { if (had) renameSync(backup, target); throw e; }
}

/** Installs a plugin: stages it, moves it in and records the fingerprint. It is off until the person switches it on. */
export async function installPlugin(o: InstallOptions): Promise<InstallResult> {
  const got = await stagePlugin(o);
  if (!got.ok) return got;
  const { pack } = got;
  const target = join(o.root, pack.name);
  if (existsSync(target) && !o.replace) { discard(got); return { ok: false, error: `${pack.name} is already installed` }; }
  swapIn(got, target);
  o.lock.set(pack.name, { hash: pack.hash, version: pack.version, source: recordedSource(o.from) });
  discard(got);
  return { ok: true, pack: { ...pack, dir: target } };
}

/** Removes an installed plugin and its lock entry. */
export function removePlugin(root: string, lock: PluginLock, name: string): boolean {
  if (!NAME.test(name)) return false;
  const dir = join(root, name);
  if (!resolve(dir).startsWith(resolve(root) + sep) || !existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  lock.delete(name);
  return true;
}

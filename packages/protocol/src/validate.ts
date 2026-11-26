/**
 * Hand-written validation (no dependencies). A parsed command is rebuilt from the known, checked fields only —
 * nothing the peer sent is ever forwarded verbatim.
 */
import { EFFORTS, PERM_MODES, SESSION_KINDS, type Command, type Effort, type FileInput, type ImageInput, type PermMode, type Result, type ScheduleWhen, type SessionKind } from "./types.ts";

export const LIMITS = {
  text: 1_000_000,
  images: 8,
  imageData: 20_000_000,
  /** Images and files together, per prompt. */
  attachments: 8,
  /** Base64 characters of one file: about 15 MB of content. */
  fileData: 20_000_000,
  fileName: 255,
  paths: 100,
  pathLength: 4096,
  id: 200,
} as const;

/** The largest a prompt command's own JSON can be: its text plus every attachment at the limit (images and files share one cap). */
export const MAX_PROMPT_BYTES = LIMITS.text + LIMITS.attachments * LIMITS.fileData;

/**
 * The largest a sealed prompt can be on the wire. Sealing (AES-GCM, then base64url) re-encodes the whole thing, about 4/3
 * its size; the extra 15,000,000 covers the envelope JSON around it and the small amount of JSON structure already inside
 * the prompt (field names, `cmd`, `qid`, each file's `name`/`mime`, …), which `MAX_PROMPT_BYTES` does not count.
 */
export const MAX_SEALED_FRAME = Math.ceil((MAX_PROMPT_BYTES * 4) / 3) + 15_000_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = <T>(error: string): Result<T> => ({ ok: false, error });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const isKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/\s/.test(v);
/** The address and the way of speaking that an endpoint form carries (shared by saving and by trying one). */
function endpointAddress(raw: Obj): { value: { baseUrl: string; api: "auto" | "chat" | "responses" | "messages" | "ollama" } } | { error: string } {
  if (typeof raw.baseUrl !== "string" || raw.baseUrl.length > 2000 || !/^https?:\/\/[^\s]+$/.test(raw.baseUrl)) return { error: "baseUrl must be a web address that starts with http:// or https://" };
  if (raw.api === undefined) return { value: { baseUrl: raw.baseUrl, api: "auto" } };
  if (raw.api !== "auto" && raw.api !== "chat" && raw.api !== "responses" && raw.api !== "messages" && raw.api !== "ollama") return { error: "api must be auto, chat, responses, messages or ollama" };
  return { value: { baseUrl: raw.baseUrl, api: raw.api } };
}
/** An address a provider may be reached at when the person sets one: https, or http for this computer only; no name or password in it, no fragment. */
export function isBaseAddress(v: string): boolean {
  if (v.length > 2048) return false;
  try {
    const u = new URL(v);
    if (u.username || u.password || u.hash) return false;
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return u.protocol === "https:" || (u.protocol === "http:" && loopback);
  } catch { return false; }
}

const isName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(v);
const isAgentName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= LIMITS.id;

function images(v: unknown): Result<ImageInput[]> {
  if (!Array.isArray(v)) return fail("images must be an array");
  if (v.length > LIMITS.images) return fail(`at most ${LIMITS.images} images per prompt`);
  const out: ImageInput[] = [];
  for (const [i, im] of v.entries()) {
    if (!isObj(im) || typeof im.mime !== "string" || typeof im.data !== "string") return fail(`images[${i}] needs mime and data`);
    if (!/^image\/[a-z0-9.+-]+$/i.test(im.mime)) return fail(`images[${i}].mime must be an image type`);
    if (im.data.length > LIMITS.imageData) return fail(`images[${i}] is too large`);
    out.push({ mime: im.mime, data: im.data });
  }
  return ok(out);
}

function files(v: unknown): Result<FileInput[]> {
  if (!Array.isArray(v)) return fail("files must be an array");
  if (v.length > LIMITS.attachments) return fail(`at most ${LIMITS.attachments} images and files per prompt`);
  const out: FileInput[] = [];
  for (const [i, f] of v.entries()) {
    if (!isObj(f) || typeof f.name !== "string" || typeof f.mime !== "string" || typeof f.data !== "string") return fail(`files[${i}] needs name, mime and data`);
    if (!f.name.trim() || f.name.length > LIMITS.fileName) return fail(`files[${i}].name must be a short name`);
    if (f.mime.length > 200) return fail(`files[${i}].mime is too long`);
    if (f.data.length > LIMITS.fileData) return fail(`files[${i}] is too large (15 MB at most)`);
    out.push({ name: f.name, mime: f.mime, data: f.data });
  }
  return ok(out);
}

export function validateCommand(raw: unknown): Result<Command> {
  const one = validateOne(raw);
  if (!one.ok || !isObj(raw) || raw.kind === undefined) return one;
  if (!SESSION_KINDS.includes(raw.kind as SessionKind)) return fail(`kind must be one of ${SESSION_KINDS.join(", ")}`);
  return ok({ ...one.value, kind: raw.kind as SessionKind });
}

function validateOne(raw: unknown): Result<Command> {
  if (!isObj(raw)) return fail("a command must be a JSON object");
  switch (raw.cmd) {
    case "prompt": {
      if (typeof raw.text !== "string") return fail("prompt.text must be a string");
      if (raw.text.length > LIMITS.text) return fail("prompt.text is too long");
      const cmd: Command = { cmd: "prompt", text: raw.text };
      if (raw.qid !== undefined) { if (!isId(raw.qid)) return fail("prompt.qid must be a short string"); cmd.qid = raw.qid; }
      if (raw.images !== undefined) { const r = images(raw.images); if (!r.ok) return r; if (r.value.length) cmd.images = r.value; }
      if (raw.files !== undefined) { const r = files(raw.files); if (!r.ok) return r; if (r.value.length) cmd.files = r.value; }
      if ((cmd.images?.length ?? 0) + (cmd.files?.length ?? 0) > LIMITS.attachments) return fail(`at most ${LIMITS.attachments} images and files per prompt`);
      if (raw.effort !== undefined) { if (!EFFORTS.includes(raw.effort as Effort)) return fail(`prompt.effort must be one of ${EFFORTS.join(", ")}`); cmd.effort = raw.effort as Effort; }
      if (raw.mode !== undefined) { if (!PERM_MODES.includes(raw.mode as PermMode)) return fail(`prompt.mode must be one of ${PERM_MODES.join(", ")}`); cmd.mode = raw.mode as PermMode; }
      if (raw.questions === true) cmd.questions = true;
      if (raw.paths !== undefined) {
        if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== "string" || p.length > LIMITS.pathLength)) return fail("prompt.paths must be an array of paths");
        cmd.paths = (raw.paths as string[]).slice(0, LIMITS.paths);
      }
      if (!cmd.text.trim() && !cmd.images?.length && !cmd.files?.length) return fail("a prompt needs text, an image or a file");
      return ok(cmd);
    }
    case "cancel": return ok({ cmd: "cancel" });
    case "window":
      if (typeof raw.questions !== "boolean") return fail("window.questions must be true or false");
      return ok({ cmd: "window", questions: raw.questions });
    case "job.stop":
      if (!isId(raw.id)) return fail("job.stop needs an id");
      return ok({ cmd: "job.stop", id: raw.id });
    case "compact": return ok({ cmd: "compact" });
    case "model":
      if (!isId(raw.id)) return fail("model needs an id");
      return ok({ cmd: "model", id: raw.id });
    case "effort":
      if (raw.level !== "auto" && !EFFORTS.includes(raw.level as Effort)) return fail(`effort.level must be auto or one of ${EFFORTS.join(", ")}`);
      return ok({ cmd: "effort", level: raw.level as Effort | "auto" });
    case "approve":
      if (!isId(raw.id) || !isId(raw.optionId)) return fail("approve needs id and optionId");
      if (raw.input !== undefined && (typeof raw.input !== "string" || raw.input.length > 20_000)) return fail("approve.input must be text of at most 20000 characters");
      return ok({ cmd: "approve", id: raw.id, optionId: raw.optionId, ...(typeof raw.input === "string" ? { input: raw.input } : {}), ...(raw.unasked === true ? { unasked: true } : {}) });
    case "answer": {
      if (!isId(raw.id)) return fail("answer needs an id");
      if (!Array.isArray(raw.answers) || raw.answers.length > 4) return fail("answer.answers must be a list of at most 4 lists of text");
      const answers: string[][] = [];
      for (const a of raw.answers) {
        if (!Array.isArray(a) || a.length > 8 || a.some((x) => typeof x !== "string" || x.length > 20_000)) return fail("each answer must be a list of at most 8 texts of at most 20000 characters");
        answers.push(a as string[]);
      }
      return ok({ cmd: "answer", id: raw.id, answers });
    }
    case "load":
      if (!isId(raw.id)) return fail("load needs an id");
      return ok({ cmd: "load", id: raw.id });
    case "sessions": return ok({ cmd: "sessions", ...(raw.archived === true ? { archived: true } : {}) });
    case "receive": {
      if (!isId(raw.id)) return fail("receive needs an id");
      if (typeof raw.title !== "string" || raw.title.length > 200) return fail("receive.title must be text");
      if (typeof raw.updated !== "number" || !Number.isFinite(raw.updated)) return fail("receive.updated must be a number");
      if (!Number.isInteger(raw.part) || !Number.isInteger(raw.parts) || (raw.parts as number) < 1 || (raw.parts as number) > 60 || (raw.part as number) < 0 || (raw.part as number) >= (raw.parts as number)) return fail("receive.part must be below receive.parts (at most 60)");
      if (!Array.isArray(raw.items) || raw.items.length > 150) return fail("receive.items must be a list of at most 150 items");
      const items: { k: "user" | "assistant" | "tool"; text: string }[] = [];
      for (const i of raw.items) {
        if (!isObj(i) || (i.k !== "user" && i.k !== "assistant" && i.k !== "tool") || typeof i.text !== "string" || i.text.length > 4000) return fail("a received item must be { k, text } with text of at most 4000 characters");
        items.push({ k: i.k, text: i.text });
      }
      return ok({ cmd: "receive", id: raw.id, title: raw.title, ...(typeof raw.project === "string" && raw.project ? { project: raw.project.slice(0, 80) } : {}), updated: raw.updated, part: raw.part as number, parts: raw.parts as number, items });
    }
    case "schedules": return ok({ cmd: "schedules" });
    case "plugins": return ok({ cmd: "plugins" });
    case "providers": return ok({ cmd: "providers" });
    case "machine": return ok({ cmd: "machine" });
    case "local.models": return ok({ cmd: "local.models" });
    case "local.stop": return ok({ cmd: "local.stop" });
    case "accounts": return ok({ cmd: "accounts" });
    case "account.login": case "account.login.cancel": case "account.logout": return ok({ cmd: raw.cmd });
    case "account.signin":
      if (!isName(raw.id)) return fail("account.signin.id must be the id of a program");
      if (raw.device !== undefined && typeof raw.device !== "boolean") return fail("account.signin.device must be true or false");
      return ok({ cmd: "account.signin", id: raw.id, ...(raw.device === true ? { device: true } : {}) });
    case "account.signin.code":
      if (!isName(raw.id)) return fail("account.signin.code.id must be the id of a program");
      if (typeof raw.code !== "string" || !raw.code.trim() || raw.code.length > 512 || /[\r\n\0]/.test(raw.code)) return fail("account.signin.code.code must be one line of at most 512 characters");
      return ok({ cmd: "account.signin.code", id: raw.id, code: raw.code.trim() });
    case "account.signin.cancel": case "account.signout":
      if (!isName(raw.id)) return fail(`${raw.cmd}.id must be the id of a program`);
      return ok({ cmd: raw.cmd, id: raw.id });
    case "mcp.signin": case "mcp.signin.cancel":
      if (!isId(raw.server)) return fail(`${raw.cmd}.server must be the name of a connected program`);
      return ok({ cmd: raw.cmd, server: raw.server });
    case "mcp.prompts": return ok({ cmd: "mcp.prompts" });
    case "mcp.prompt": {
      if (!isId(raw.server) || !isId(raw.name)) return fail("mcp.prompt needs the server and the name of a prompt");
      let args: Record<string, string> | undefined;
      if (raw.args !== undefined) {
        if (!raw.args || typeof raw.args !== "object" || Array.isArray(raw.args) || Object.keys(raw.args).length > 20) return fail("mcp.prompt.args must be an object of at most 20 texts");
        const given = Object.entries(raw.args as Record<string, unknown>);
        if (given.some(([k, v]) => k.length > 100 || typeof v !== "string" || v.length > 20_000)) return fail("mcp.prompt.args must be texts");
        args = Object.fromEntries(given as [string, string][]);
      }
      return ok({ cmd: "mcp.prompt", server: raw.server, name: raw.name, ...(args ? { args } : {}) });
    }
    case "account.install":
      if (!isName(raw.id)) return fail("account.install.id must be the id of a program");
      return ok({ cmd: "account.install", id: raw.id });
    case "local.ollama": return ok({ cmd: "local.ollama" });
    case "local.ollama.pull": case "local.ollama.cancel":
      if (typeof raw.model !== "string" || !/^[A-Za-z0-9][\w.\-/:]{0,119}$/.test(raw.model) || raw.model.includes("..")) return fail(`${raw.cmd}.model must be the name Ollama knows the model by, such as name:size`);
      return ok({ cmd: raw.cmd, model: raw.model });
    case "local.run": {
      if (typeof raw.repo !== "string" || !/^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(raw.repo)) return fail("local.run.repo must be the name of a repository, such as owner/name");
      if (typeof raw.file !== "string" || !raw.file || raw.file.length > 300 || !/\.gguf$/i.test(raw.file) || raw.file.split("/").some((b: string) => !b || b === "." || b === "..") || /[\\\0]/.test(raw.file)) return fail("local.run.file must be the path of a .gguf file in the repository");
      if (raw.window !== undefined && !(typeof raw.window === "number" && Number.isInteger(raw.window) && raw.window >= 1024 && raw.window <= 1_048_576)) return fail("local.run.window must be a whole number from 1024 to 1048576");
      return ok({ cmd: "local.run", repo: raw.repo, file: raw.file, ...(raw.window !== undefined ? { window: raw.window as number } : {}) });
    }
    case "local.pull": case "local.pause": case "local.cancel": case "local.remove": {
      if (typeof raw.repo !== "string" || !/^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(raw.repo)) return fail(`${raw.cmd}.repo must be the name of a repository, such as owner/name`);
      if (typeof raw.file !== "string" || !raw.file || raw.file.length > 300 || !/\.gguf$/i.test(raw.file) || raw.file.split("/").some((b: string) => !b || b === "." || b === "..") || /[\\\0]/.test(raw.file)) return fail(`${raw.cmd}.file must be the path of a .gguf file in the repository`);
      return ok({ cmd: raw.cmd, repo: raw.repo, file: raw.file });
    }
    case "local.runtime": case "local.runtime.install": case "local.runtime.cancel": case "local.runtime.remove": return ok({ cmd: raw.cmd });
    case "local.recommended":
      if (raw.window !== undefined && !(typeof raw.window === "number" && Number.isInteger(raw.window) && raw.window >= 1024 && raw.window <= 1_048_576)) return fail("local.recommended.window must be a whole number from 1024 to 1048576");
      return ok({ cmd: "local.recommended", ...(raw.window !== undefined ? { window: raw.window as number } : {}) });
    case "local.search":
      if (typeof raw.query !== "string" || !raw.query.trim() || raw.query.length > 200) return fail("local.search.query must be words of at most 200 characters");
      if (raw.window !== undefined && !(typeof raw.window === "number" && Number.isInteger(raw.window) && raw.window >= 1024 && raw.window <= 1_048_576)) return fail("local.search.window must be a whole number from 1024 to 1048576");
      return ok({ cmd: "local.search", query: raw.query.trim(), ...(raw.window !== undefined ? { window: raw.window as number } : {}) });
    case "endpoints": return ok({ cmd: "endpoints" });
    case "endpoint.remove":
      if (!isName(raw.id)) return fail("endpoint.remove needs the id of an endpoint");
      return ok({ cmd: "endpoint.remove", id: raw.id });
    case "endpoint.models": {
      if (raw.id !== undefined) { if (!isName(raw.id)) return fail("endpoint.models.id must be the id of an endpoint"); return ok({ cmd: "endpoint.models", id: raw.id }); }
      const where = endpointAddress(raw);
      if ("error" in where) return fail(`endpoint.models ${where.error}`);
      if (raw.key !== undefined && !isKey(raw.key)) return fail("endpoint.models.key must be a key of at most 4096 characters, without spaces");
      return ok({ cmd: "endpoint.models", ...where.value, ...(raw.key !== undefined ? { key: raw.key as string } : {}) });
    }
    case "endpoint.save": {
      if (raw.id !== undefined && !isName(raw.id)) return fail("endpoint.save.id must be the id of an endpoint");
      if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) return fail("endpoint.save.name must be a name of at most 80 characters");
      const where = endpointAddress(raw);
      if ("error" in where) return fail(`endpoint.save ${where.error}`);
      if (raw.key !== undefined && raw.key !== "" && !isKey(raw.key)) return fail("endpoint.save.key must be a key of at most 4096 characters, without spaces, or empty to remove it");
      if (!Array.isArray(raw.models) || raw.models.length > 500) return fail("endpoint.save.models must be a list of at most 500 models");
      const models: { id: string; window?: number; vision?: boolean; pdf?: boolean }[] = [];
      for (const m of raw.models) {
        if (!isObj(m) || typeof m.id !== "string" || !m.id || m.id.length > 200 || /[\s\u0000-\u001f]/.test(m.id)) return fail("endpoint.save.models: a model needs an id of at most 200 characters, without spaces");
        if (m.window !== undefined && !(typeof m.window === "number" && Number.isInteger(m.window) && m.window > 0 && m.window <= 100_000_000)) return fail("endpoint.save.models: window must be a whole number above zero");
        if ((m.vision !== undefined && typeof m.vision !== "boolean") || (m.pdf !== undefined && typeof m.pdf !== "boolean")) return fail("endpoint.save.models: vision and pdf must be true or false");
        if (models.some((o) => o.id === m.id)) return fail(`endpoint.save.models: ${m.id} is there twice`);
        models.push({ id: m.id, ...(m.window !== undefined ? { window: m.window } : {}), ...(m.vision !== undefined ? { vision: m.vision } : {}), ...(m.pdf !== undefined ? { pdf: m.pdf } : {}) });
      }
      return ok({ cmd: "endpoint.save", ...(raw.id !== undefined ? { id: raw.id as string } : {}), name: raw.name.trim(), ...where.value, ...(raw.key !== undefined ? { key: raw.key as string } : {}), models });
    }
    case "provider.models":
      if (!isName(raw.id)) return fail("provider.models needs the id of a provider");
      return ok({ cmd: "provider.models", id: raw.id });
    case "provider.use":
      if (!isName(raw.id)) return fail("provider.use needs the id of a provider");
      if (typeof raw.model !== "string" || !raw.model || raw.model.length > 200 || /[\s\u0000-\u001f]/.test(raw.model)) return fail("provider.use.model must be the name of a model, without spaces");
      return ok({ cmd: "provider.use", id: raw.id, model: raw.model });
    case "provider.remove":
      if (!isName(raw.id)) return fail("provider.remove needs the id of a provider");
      return ok({ cmd: "provider.remove", id: raw.id });
    case "provider.save": {
      if (!isName(raw.id)) return fail("provider.save needs the id of a provider");
      if (raw.key !== undefined && (typeof raw.key !== "string" || !raw.key || raw.key.length > 4096 || /\s/.test(raw.key))) return fail("provider.save.key must be a key of at most 4096 characters, without spaces");
      if (raw.region !== undefined && !isName(raw.region)) return fail("provider.save.region must be the id of a region");
      if (raw.base !== undefined && !(typeof raw.base === "string" && (raw.base === "" || isBaseAddress(raw.base)))) return fail("provider.save.base must be an https address, or an http address of this computer, without a name or password in it (empty takes it away)");
      let fields: Record<string, string> | undefined;
      if (raw.fields !== undefined) {
        if (!isObj(raw.fields) || Object.keys(raw.fields).length > 12) return fail("provider.save.fields must be an object of at most 12 fields");
        fields = {};
        for (const [k, v] of Object.entries(raw.fields)) {
          if (!isName(k) || typeof v !== "string" || v.length > 2048) return fail("provider.save.fields: a field is named by an id and holds text of at most 2048 characters");
          fields[k] = v;
        }
      }
      return ok({ cmd: "provider.save", id: raw.id, ...(raw.key !== undefined ? { key: raw.key } : {}), ...(raw.region !== undefined ? { region: raw.region } : {}), ...(raw.base !== undefined ? { base: raw.base } : {}), ...(fields ? { fields } : {}) });
    }
    case "tools": return ok({ cmd: "tools" });
    case "drafts": return ok({ cmd: "drafts" });
    case "draft":
      if (typeof raw.key !== "string" || !/^(new|[A-Za-z0-9_-]{1,80})$/.test(raw.key)) return fail("draft needs the id of a conversation, or new");
      if (typeof raw.text !== "string" || raw.text.length > 20_000) return fail("draft.text must be text of at most 20000 characters");
      return ok({ cmd: "draft", key: raw.key, text: raw.text });
    case "tool.setup":
      if (typeof raw.id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(raw.id)) return fail("tool.setup needs the id of a tool");
      if (raw.mode !== undefined && !PERM_MODES.includes(raw.mode as PermMode)) return fail(`tool.setup.mode must be one of ${PERM_MODES.join(", ")}`);
      return ok({ cmd: "tool.setup", id: raw.id, ...(raw.mode !== undefined ? { mode: raw.mode as PermMode } : {}) });
    case "tool.setup.approve":
    case "tool.setup.cancel":
      if (typeof raw.id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(raw.id)) return fail(`${raw.cmd} needs the id of a tool`);
      return ok({ cmd: raw.cmd, id: raw.id });
    case "tool.toggle":
      if (typeof raw.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(raw.name)) return fail("tool.toggle needs the name of a tool");
      if (typeof raw.enabled !== "boolean") return fail("tool.toggle.enabled must be true or false");
      return ok({ cmd: "tool.toggle", name: raw.name, enabled: raw.enabled });
    case "terminal.use":
      if (raw.backend !== "local" && raw.backend !== "docker" && raw.backend !== "ssh") return fail("terminal.use.backend must be local, docker or ssh");
      return ok({ cmd: "terminal.use", backend: raw.backend });
    case "sandbox.use":
      if ((raw.on !== undefined && typeof raw.on !== "boolean") || (raw.network !== undefined && typeof raw.network !== "boolean")) return fail("sandbox.use.on and sandbox.use.network must be true or false");
      if (raw.on === undefined && raw.network === undefined) return fail("sandbox.use needs on or network");
      return ok({ cmd: "sandbox.use", ...(raw.on !== undefined ? { on: raw.on } : {}), ...(raw.network !== undefined ? { network: raw.network } : {}) });
    case "artifacts":
      if (raw.id !== undefined && !isId(raw.id)) return fail("artifacts.id must be an id");
      return ok({ cmd: "artifacts", ...(typeof raw.id === "string" ? { id: raw.id } : {}) });
    case "artifact.read":
      if (!isId(raw.id)) return fail("artifact.read needs an id");
      return ok({ cmd: "artifact.read", id: raw.id });
    case "media.read": {
      if (!/^[0-9a-f]{16,64}$/.test(String(raw.id))) return fail("media.read needs the id of a picture, sound or video");
      for (const k of ["offset", "length"] as const) if (raw[k] !== undefined && !(typeof raw[k] === "number" && Number.isInteger(raw[k]) && (raw[k] as number) >= (k === "length" ? 1 : 0) && (raw[k] as number) <= 2_000_000_000)) return fail(`media.read.${k} must be a whole number of bytes`);
      return ok({ cmd: "media.read", id: raw.id as string, ...(raw.offset !== undefined ? { offset: raw.offset as number } : {}), ...(raw.length !== undefined ? { length: raw.length as number } : {}) });
    }
    case "a2a.list": return ok({ cmd: "a2a.list" });
    case "a2a.peer.add": {
      if (!isAgentName(raw.name)) return fail("a2a.peer.add.name must be letters, digits, dots, dashes or underscores (at most 32)");
      if (typeof raw.url !== "string" || raw.url.length > 2048 || !/^https?:\/\/[^\s@]+$/.test(raw.url)) return fail("a2a.peer.add.url must be a web address such as https://agent.example.com, without a name or password in it");
      if (raw.token !== undefined && (typeof raw.token !== "string" || !raw.token.trim() || raw.token.length > 4096 || /\s/.test(raw.token.trim()))) return fail("a2a.peer.add.token must be the token as one piece of text");
      if (raw.tokenEnv !== undefined && !(typeof raw.tokenEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.tokenEnv) && raw.tokenEnv.length <= 128)) return fail("a2a.peer.add.tokenEnv must be the name of an environment variable");
      if (raw.tokenFile !== undefined && !(typeof raw.tokenFile === "string" && raw.tokenFile.length > 0 && raw.tokenFile.length <= LIMITS.pathLength)) return fail("a2a.peer.add.tokenFile must be a file path");
      if ([raw.token, raw.tokenEnv, raw.tokenFile].filter((x) => x !== undefined).length > 1) return fail("a2a.peer.add takes one of token, tokenEnv and tokenFile");
      if (raw.timeoutSeconds !== undefined && !(typeof raw.timeoutSeconds === "number" && raw.timeoutSeconds >= 1 && raw.timeoutSeconds <= 3600)) return fail("a2a.peer.add.timeoutSeconds must be from 1 to 3600");
      return ok({ cmd: "a2a.peer.add", name: raw.name, url: raw.url, ...(raw.token !== undefined ? { token: (raw.token as string).trim() } : {}), ...(raw.tokenEnv !== undefined ? { tokenEnv: raw.tokenEnv as string } : {}), ...(raw.tokenFile !== undefined ? { tokenFile: raw.tokenFile as string } : {}), ...(raw.timeoutSeconds !== undefined ? { timeoutSeconds: raw.timeoutSeconds as number } : {}) });
    }
    case "a2a.peer.remove": case "a2a.token.add": case "a2a.token.revoke":
      if (!isAgentName(raw.name)) return fail(`${raw.cmd}.name must be letters, digits, dots, dashes or underscores (at most 32)`);
      return ok({ cmd: raw.cmd, name: raw.name } as Command);
    case "memory.list":
      if (raw.scope !== undefined && raw.scope !== "project" && raw.scope !== "user") return fail("memory.list.scope must be project or user");
      return ok({ cmd: "memory.list", ...(raw.scope ? { scope: raw.scope } : {}) });
    case "memory.edit": case "memory.forget": {
      if (!isId(raw.id)) return fail(`${raw.cmd} needs the id of a note`);
      if (raw.scope !== "project" && raw.scope !== "user") return fail(`${raw.cmd}.scope must be project or user`);
      if (raw.cmd === "memory.forget") return ok({ cmd: "memory.forget", id: raw.id, scope: raw.scope });
      if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 2000) return fail("memory.edit.text must be the note, in at most 2000 characters");
      return ok({ cmd: "memory.edit", id: raw.id, scope: raw.scope, text: raw.text });
    }
    case "memory.extract":
      if (raw.mode !== undefined && raw.mode !== "off" && raw.mode !== "rules" && raw.mode !== "model") return fail("memory.extract.mode must be off, rules or model");
      return ok({ cmd: "memory.extract", ...(raw.mode ? { mode: raw.mode } : {}) });
    case "mcp.resources":
      if (raw.server !== undefined && !isId(raw.server)) return fail("mcp.resources.server must be the name of a connected program");
      return ok({ cmd: "mcp.resources", ...(typeof raw.server === "string" ? { server: raw.server } : {}) });
    case "mcp.resource":
      if (!isId(raw.server)) return fail("mcp.resource.server must be the name of a connected program");
      if (typeof raw.uri !== "string" || !raw.uri || raw.uri.length > 4096) return fail("mcp.resource.uri must be the address of a document");
      return ok({ cmd: "mcp.resource", server: raw.server, uri: raw.uri });
    case "mcp.tools":
      if (raw.query !== undefined && (typeof raw.query !== "string" || raw.query.length > 200)) return fail("mcp.tools.query must be text of at most 200 characters");
      if (raw.server !== undefined && !isId(raw.server)) return fail("mcp.tools.server must be the name of a connected program");
      return ok({ cmd: "mcp.tools", ...(typeof raw.query === "string" ? { query: raw.query } : {}), ...(typeof raw.server === "string" ? { server: raw.server } : {}) });
    case "plugin.install":
      if (typeof raw.from !== "string" || !raw.from.trim() || raw.from.length > LIMITS.pathLength || /[\0\n]/.test(raw.from)) return fail("plugin.install.from must be a folder, an archive or an address");
      if (raw.fingerprint !== undefined && !(typeof raw.fingerprint === "string" && /^[0-9a-f]{12,64}$/i.test(raw.fingerprint.trim()))) return fail("plugin.install.fingerprint must be at least 12 hex digits");
      return ok({ cmd: "plugin.install", from: raw.from.trim(), ...(typeof raw.fingerprint === "string" ? { fingerprint: raw.fingerprint.trim() } : {}) });
    case "computer.takeover": case "computer.giveback": return ok({ cmd: raw.cmd });
    case "plugin.toggle":
      if (!isId(raw.id)) return fail("plugin.toggle needs an id");
      if (typeof raw.enabled !== "boolean") return fail("plugin.toggle.enabled must be true or false");
      return ok({ cmd: "plugin.toggle", id: raw.id, enabled: raw.enabled });
    case "memory.pending":
      if (raw.action !== undefined && raw.action !== "accept" && raw.action !== "reject") return fail("memory.pending.action must be accept or reject");
      if (raw.action !== undefined && !isId(raw.id)) return fail("memory.pending needs an id to accept or reject");
      return ok({ cmd: "memory.pending", ...(raw.action ? { action: raw.action } : {}), ...(typeof raw.id === "string" ? { id: raw.id } : {}) });
    case "skill.review":
      if (raw.id !== undefined && !isId(raw.id)) return fail("skill.review.id must be an id");
      if (raw.id !== undefined && typeof raw.accept !== "boolean") return fail("skill.review.accept must be true or false");
      return ok({ cmd: "skill.review", ...(typeof raw.id === "string" ? { id: raw.id, accept: raw.accept as boolean } : {}) });
    case "skill.rollback":
      if (raw.id !== undefined && !isId(raw.id)) return fail("skill.rollback.id must be an id");
      return ok({ cmd: "skill.rollback", ...(typeof raw.id === "string" ? { id: raw.id } : {}) });
    case "schedule.add": case "schedule.update": {
      const add = raw.cmd === "schedule.add";
      const out: Record<string, unknown> = { cmd: raw.cmd };
      if (!add) { if (!isId(raw.id)) return fail("schedule.update needs an id"); out.id = raw.id; }
      if (raw.title !== undefined) { if (typeof raw.title !== "string" || raw.title.length > 80) return fail("title must be text of at most 80 characters"); out.title = raw.title; }
      if (raw.cron !== undefined && raw.when !== undefined) return fail("give when or cron, not both");
      if (add && raw.cron === undefined && raw.when === undefined) return fail("say when: when, or cron of five fields");
      if (raw.cron !== undefined) { if (typeof raw.cron !== "string" || !raw.cron.trim() || raw.cron.length > 100) return fail("cron must be the five fields of a schedule"); out.cron = raw.cron.trim(); }
      if (raw.when !== undefined) { const w = whenOf(raw.when); if (typeof w === "string") return fail(w); out.when = w; }
      if (raw.tz !== undefined) { if (typeof raw.tz !== "string" || !raw.tz.trim() || raw.tz.length > 64) return fail("tz must be a time zone name"); out.tz = raw.tz.trim(); }
      if (add || raw.prompt !== undefined) { if (typeof raw.prompt !== "string" || !raw.prompt.trim() || raw.prompt.length > 4000) return fail("prompt must be 1 to 4000 characters"); out.prompt = raw.prompt; }
      if (raw.mode !== undefined) { if (raw.mode !== "plan" && raw.mode !== "auto") return fail("mode must be plan or auto"); out.mode = raw.mode; }
      if (raw.folder !== undefined) { if (!isId(raw.folder)) return fail("folder must be an id"); out.folder = raw.folder; }
      if (!add && raw.enabled !== undefined) { if (typeof raw.enabled !== "boolean") return fail("enabled must be true or false"); out.enabled = raw.enabled; }
      return ok(out as unknown as Command);
    }
    case "schedule.remove": case "schedule.run":
      if (!isId(raw.id)) return fail(`${raw.cmd} needs an id`);
      return ok({ cmd: raw.cmd, id: raw.id } as Command);
    case "computer.state": return ok({ cmd: "computer.state" });
    case "computer.permission":
      if (raw.id !== "accessibility" && raw.id !== "screen-recording") return fail("computer.permission.id must be accessibility or screen-recording");
      return ok({ cmd: "computer.permission", id: raw.id });
    case "computer.on":
      if (typeof raw.on !== "boolean") return fail("computer.on.on must be true or false");
      return ok({ cmd: "computer.on", on: raw.on });
    case "schedule.runs": {
      if (!isId(raw.id)) return fail("schedule.runs needs an id");
      if (raw.limit !== undefined && (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1 || raw.limit > 20)) return fail("schedule.runs.limit must be a whole number from 1 to 20");
      return ok({ cmd: "schedule.runs", id: raw.id, ...(raw.limit !== undefined ? { limit: raw.limit } : {}) });
    }
    case "fork":
      if (!isId(raw.id)) return fail("fork needs an id");
      return ok({ cmd: "fork", id: raw.id });
    case "archive":
      if (!isId(raw.id)) return fail("archive needs an id");
      if (typeof raw.archived !== "boolean") return fail("archive.archived must be true or false");
      return ok({ cmd: "archive", id: raw.id, archived: raw.archived });
    case "mark": {
      if (!isId(raw.id)) return fail("mark needs an id");
      if ((raw.read !== undefined && typeof raw.read !== "boolean") || (raw.done !== undefined && typeof raw.done !== "boolean") || (raw.read === undefined && raw.done === undefined)) return fail("mark needs read and/or done, as true or false");
      return ok({ cmd: "mark", id: raw.id, ...(raw.read !== undefined ? { read: raw.read as boolean } : {}), ...(raw.done !== undefined ? { done: raw.done as boolean } : {}) });
    }
    case "new":
      if (raw.folder !== undefined && !isId(raw.folder)) return fail("new.folder must be an id");
      return ok({ cmd: "new", ...(typeof raw.folder === "string" ? { folder: raw.folder } : {}) });
    case "import": {
      if (raw.ids === undefined) return ok({ cmd: "import" });
      if (!Array.isArray(raw.ids) || raw.ids.length > 50 || raw.ids.some((x) => !isId(x))) return fail("import.ids must be up to 50 ids");
      return ok({ cmd: "import", ids: raw.ids as string[] });
    }
    case "move": case "copy":
      if (!isId(raw.id) || !isId(raw.to)) return fail(`${raw.cmd} needs id and to`);
      return ok({ cmd: raw.cmd, id: raw.id, to: raw.to });
    case "rename": {
      if (!isId(raw.id)) return fail("rename needs an id");
      if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 200) return fail("rename.title must be 1 to 200 characters");
      return ok({ cmd: "rename", id: raw.id, title: raw.title.trim() });
    }
    case "remove":
      if (!isId(raw.id)) return fail("remove needs an id");
      return ok({ cmd: "remove", id: raw.id });
    case "pin":
      if (!isId(raw.id)) return fail("pin needs an id");
      if (typeof raw.pinned !== "boolean") return fail("pin.pinned must be true or false");
      return ok({ cmd: "pin", id: raw.id, pinned: raw.pinned });
    case "search": {
      if (typeof raw.query !== "string" || !raw.query.trim() || raw.query.length > 200) return fail("search needs words to look for (1 to 200 characters)");
      if (raw.limit !== undefined && !(Number.isInteger(raw.limit) && (raw.limit as number) >= 1 && (raw.limit as number) <= 50)) return fail("search.limit must be a whole number from 1 to 50");
      return ok({ cmd: "search", query: raw.query.trim(), ...(raw.limit !== undefined ? { limit: raw.limit as number } : {}), ...(raw.includeArchived === true ? { includeArchived: true } : {}) });
    }
    case "checkpoints": return ok({ cmd: "checkpoints" });
    case "restore": {
      if (!isId(raw.id)) return fail("restore needs an id");
      if (raw.preview !== undefined && typeof raw.preview !== "boolean") return fail("restore.preview must be true or false");
      return ok({ cmd: "restore", id: raw.id, ...(raw.preview === true ? { preview: true } : {}) });
    }
    default:
      return fail(typeof raw.cmd === "string" ? `unknown command "${raw.cmd.slice(0, 40)}"` : "missing cmd");
  }
}

/** `when` of a schedule command: one of the three forms, with the numbers checked. Or why not. */
function whenOf(v: unknown): ScheduleWhen | string {
  const w = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const time = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  if (w.kind === "cron") return typeof w.cron === "string" && w.cron.trim() && w.cron.length <= 100 ? { kind: "cron", cron: w.cron.trim() } : "when.cron must be the five fields of a schedule";
  if (w.kind === "every") {
    if (typeof w.ms !== "number" || !Number.isInteger(w.ms) || w.ms < 60_000) return "when.ms must be a whole number of milliseconds, at least 60000";
    if (w.start !== undefined && !time(w.start)) return "when.start must be a time in milliseconds";
    return { kind: "every", ms: w.ms, ...(w.start !== undefined ? { start: w.start as number } : {}) };
  }
  if (w.kind === "at") return time(w.at) ? { kind: "at", at: w.at } : "when.at must be a time in milliseconds";
  return "when.kind must be cron, every or at";
}

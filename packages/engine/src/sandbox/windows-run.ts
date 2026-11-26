import { commandLine } from "./windows.ts";

export const ACTIVE_PROCESSES = 4096;
export const KILL_ON_CLOSE = 0x2000;
export const ACTIVE_PROCESS_LIMIT = 0x8;
export const UI_RESTRICTIONS = 0xff;
export const DENY_ONLY_GROUPS = [26, 29, 33] as const;

export function jobLimits(o: { detached: boolean }): Uint8Array {
  const b = new Uint8Array(144);
  const v = new DataView(b.buffer);
  v.setUint32(16, ACTIVE_PROCESS_LIMIT | (o.detached ? 0 : KILL_ON_CLOSE), true);
  v.setUint32(40, ACTIVE_PROCESSES, true);
  return b;
}

export function uiLimits(): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, UI_RESTRICTIONS, true);
  return b;
}

export function startupInfo(handles: { input: bigint; output: bigint; error: bigint }): Uint8Array {
  const b = new Uint8Array(104);
  const v = new DataView(b.buffer);
  v.setUint32(0, 104, true);
  v.setUint32(60, 0x100, true);
  v.setBigUint64(80, handles.input, true);
  v.setBigUint64(88, handles.output, true);
  v.setBigUint64(96, handles.error, true);
  return b;
}

export const wide = (text: string): Uint16Array => { const u = new Uint16Array(text.length + 1); for (let i = 0; i < text.length; i++) u[i] = text.charCodeAt(i); return u; };

export function parseRun(args: readonly string[]): { detached: boolean; argv: string[] } | undefined {
  const dash = args.indexOf("--");
  if (dash < 0 || dash === args.length - 1) return undefined;
  return { detached: args.slice(0, dash).includes("--detached"), argv: args.slice(dash + 1) };
}

const STD = [0xfffffff6, 0xfffffff5, 0xfffffff4] as const;
const WAIT_OBJECT_0 = 0;
const HANDLE_FLAG_INHERIT = 1;
const INFINITE = 0xffffffff;

type SystemLibrary = () => Promise<Pick<typeof import("bun:ffi"), "dlopen" | "FFIType" | "ptr">>;

export async function runConfined(args: readonly string[], err: (text: string) => void = (t) => process.stderr.write(t), system: SystemLibrary = () => import("bun:ffi")): Promise<number> {
  try {
    return await confine(args, err, system);
  } catch (e) {
    err(`sandbox: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}\n`);
    return 1;
  }
}

async function confine(args: readonly string[], err: (text: string) => void, system: SystemLibrary): Promise<number> {
  const asked = parseRun(args);
  if (!asked) { err("sandbox: no command was given\n"); return 2; }
  const { dlopen, FFIType, ptr } = await system();
  const { u32, i32, u64, ptr: P } = FFIType;
  const k = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: u64 }, GetStdHandle: { args: [u32], returns: u64 }, CloseHandle: { args: [u64], returns: i32 },
    CreateJobObjectW: { args: [P, P], returns: u64 }, SetInformationJobObject: { args: [u64, i32, P, u32], returns: i32 }, AssignProcessToJobObject: { args: [u64, u64], returns: i32 },
    TerminateJobObject: { args: [u64, u32], returns: i32 }, ResumeThread: { args: [u64], returns: u32 }, OpenProcess: { args: [u32, i32, u32], returns: u64 },
    WaitForMultipleObjects: { args: [u32, P, i32, u32], returns: u32 }, SetHandleInformation: { args: [u64, u32, u32], returns: i32 }, GetExitCodeProcess: { args: [u64, P], returns: i32 }, GetLastError: { args: [], returns: u32 },
  }).symbols;
  const a = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [u64, u32, P], returns: i32 },
    CreateRestrictedToken: { args: [u64, u32, u32, P, u32, P, u32, P, P], returns: i32 },
    CreateProcessAsUserW: { args: [u64, P, P, P, P, i32, u32, P, P, P, P], returns: i32 },
    CreateWellKnownSid: { args: [i32, P, P, P], returns: i32 },
  }).symbols;
  const fail = (step: string): number => { err(`sandbox: ${step} failed (error ${k.GetLastError()})\n`); return 1; };

  const own = new BigUint64Array(1);
  if (!a.OpenProcessToken(BigInt(k.GetCurrentProcess()), 0xb, ptr(own))) return fail("reading the token");
  const sids = DENY_ONLY_GROUPS.map(() => new Uint8Array(68));
  const list = new BigUint64Array(DENY_ONLY_GROUPS.length * 2);
  const size = new Uint32Array(1);
  for (const [i, kind] of DENY_ONLY_GROUPS.entries()) {
    size[0] = 68;
    if (!a.CreateWellKnownSid(kind, null, ptr(sids[i]!), ptr(size))) return fail("naming a group");
    list[i * 2] = BigInt(ptr(sids[i]!));
  }
  const restricted = new BigUint64Array(1);
  if (!a.CreateRestrictedToken(own[0]!, 0x1, DENY_ONLY_GROUPS.length, ptr(list), 0, null, 0, null, ptr(restricted))) return fail("restricting the token");

  const job = BigInt(k.CreateJobObjectW(null, null));
  if (!job) return fail("making the job");
  if (!k.SetInformationJobObject(job, 9, ptr(jobLimits({ detached: asked.detached })), 144)) return fail("setting the job limits");
  if (!k.SetInformationJobObject(job, 4, ptr(uiLimits()), 4)) return fail("setting the job limits");

  const line = wide(commandLine(asked.argv));
  const info = new Uint8Array(24);
  const std = STD.map((id) => BigInt(k.GetStdHandle(id)));
  for (const handle of std) k.SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  const started = a.CreateProcessAsUserW(restricted[0]!, null, ptr(line), null, null, 1, 0x4 | 0x08000000, null, null, ptr(startupInfo({ input: std[0]!, output: std[1]!, error: std[2]! })), ptr(info));
  if (!started) return fail("starting the command");
  const view = new DataView(info.buffer);
  const process_ = view.getBigUint64(0, true), thread = view.getBigUint64(8, true);
  if (!k.AssignProcessToJobObject(job, process_)) { k.TerminateJobObject(job, 1); return fail("putting the command in the job"); }
  k.ResumeThread(thread);
  k.CloseHandle(thread);

  const waits = [process_];
  const parent = asked.detached ? 0n : BigInt(k.OpenProcess(0x100000, 0, process.ppid));
  if (parent) waits.push(parent);
  const handles = BigUint64Array.from(waits);
  const which = k.WaitForMultipleObjects(waits.length, ptr(handles), 0, INFINITE);
  if (which !== WAIT_OBJECT_0) { k.TerminateJobObject(job, 1); return 1; }
  const code = new Uint32Array(1);
  return k.GetExitCodeProcess(process_, ptr(code)) ? code[0]! : 1;
}

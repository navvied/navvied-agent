import { existsSync, readFileSync, statfsSync } from "node:fs";
import { arch, freemem, totalmem } from "node:os";
import { dirname } from "node:path";

/**
 * What this computer can run a model with, read from the system's own tools and files only, every lookup with a timeout. What cannot be read is `unknown`
 * (or left out): nothing is guessed, because a wrong number here becomes a model that does not fit or a card that is not used.
 */
export interface Gpu {
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown";
  /** `discrete` has memory of its own; `integrated` shares the memory of the computer; `unified` is one memory for all (Apple silicon). */
  kind: "discrete" | "integrated" | "unified" | "unknown";
  /** Its own memory, when it has one that could be read (for `unified`, the memory of the computer). */
  memoryMb?: number;
  /** What of it is free now, when that could be read. */
  freeMb?: number;
  driver?: string;
}

export interface Machine {
  os: "linux" | "wsl" | "macos" | "windows" | "unknown";
  arch: "x64" | "arm64" | "unknown";
  gpus: Gpu[];
  ramMb: number;
  /** What the computer can give to a program now (not cache), when that could be read. */
  freeRamMb?: number;
  /** Free space on the volume of the folder models are kept in. */
  disk?: { path: string; freeMb: number; totalMb: number };
}

/** The parts of the computer the lookups touch, injected so that a test shows every system's answers without any of them. */
export interface Probe {
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  /** Runs a program; undefined when it is not there, fails, or does not answer in time. */
  run(argv: string[], timeoutMs?: number): Promise<string | undefined>;
  read(path: string): string | undefined;
  exists(path: string): boolean;
  ram(): { totalMb: number; freeMb: number };
  disk(path: string): { freeMb: number; totalMb: number } | undefined;
}

const MB = 1024 * 1024;
const WAIT = 4000;

/** The probe of the computer this runs on. `system.run` is the program runner of the setup screens (it kills what does not answer in time). */
export function realProbe(system: { run(argv: string[], o?: { timeoutMs?: number }): Promise<{ code: number; output: string }> }): Probe {
  return {
    platform: process.platform,
    arch: arch(),
    env: process.env,
    async run(argv, timeoutMs = WAIT) { try { const r = await system.run(argv, { timeoutMs }); return r.code === 0 ? r.output : undefined; } catch { return undefined; } },
    read(path) { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
    exists: existsSync,
    ram: () => ({ totalMb: Math.round(totalmem() / MB), freeMb: Math.round(freemem() / MB) }),
    // The folder may not be made yet: its volume is the one of the nearest folder that is there.
    disk(path) {
      for (let at = path; ; at = dirname(at)) {
        try { const s = statfsSync(at); return { freeMb: Math.floor((s.bavail * s.bsize) / MB), totalMb: Math.floor((s.blocks * s.bsize) / MB) }; } catch { if (dirname(at) === at) return undefined; }
      }
    },
  };
}

const num = (v: string | undefined): number | undefined => { const n = Number(v?.trim()); return v !== undefined && v.trim() !== "" && Number.isFinite(n) ? n : undefined; };

const vendorOf = (text: string): Gpu["vendor"] => (/nvidia/i.test(text) ? "nvidia" : /\bamd\b|advanced micro|\bati\b|radeon/i.test(text) ? "amd" : /intel/i.test(text) ? "intel" : /apple/i.test(text) ? "apple" : "unknown");

/** `discrete` or `integrated` from what the name says of the card; a name that does not say stays `unknown`. */
function kindOf(vendor: Gpu["vendor"], name: string): Gpu["kind"] {
  if (vendor === "apple") return "unified";
  if (vendor === "nvidia") return /tegra|jetson|orin\b(?!.*rtx)/i.test(name) ? "unknown" : "discrete";
  if (vendor === "amd") return /instinct|radeon\s+(rx|pro|vii|r9|r7)\b|radeon\s+pro/i.test(name) ? "discrete" : /radeon(\(tm\))?\s+graphics|vega\s*\d+\b|radeon\s+\d{3}m\b/i.test(name) ? "integrated" : "unknown";
  if (vendor === "intel") return /\barc\b|data center gpu|flex\s+\d/i.test(name) ? "discrete" : /uhd|iris|hd graphics|xe graphics|\bgraphics$/i.test(name) ? "integrated" : "unknown";
  return "unknown";
}

/** NVIDIA's own tool, on Linux, WSL and Windows alike: name, memory total and free in MB, driver. One line per card. */
async function nvidia(p: Probe): Promise<Gpu[]> {
  const candidates = p.platform === "linux" ? [["nvidia-smi"], ["/usr/lib/wsl/lib/nvidia-smi"]] : [["nvidia-smi"]];
  for (const base of candidates) {
    const out = await p.run([...base, "--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"]);
    if (!out?.trim()) continue;
    const gpus: Gpu[] = [];
    for (const row of out.trim().split(/\r?\n/)) {
      const [name, total, free, driver] = row.split(",").map((x) => x.trim());
      if (!name) continue;
      const memoryMb = num(total), freeMb = num(free);
      gpus.push({ name, vendor: "nvidia", kind: "discrete", ...(memoryMb ? { memoryMb } : {}), ...(freeMb !== undefined ? { freeMb } : {}), ...(driver ? { driver } : {}) });
    }
    if (gpus.length) return gpus;
  }
  return [];
}

const PCI_GPU = /VGA compatible controller|3D controller|Display controller/;

/** Linux: the names from `lspci`, the memory of AMD cards from the driver's own files. */
async function linuxOthers(p: Probe, skip: Set<Gpu["vendor"]>): Promise<Gpu[]> {
  const gpus: Gpu[] = [];
  const out = await p.run(["lspci", "-mm", "-nn"]);
  for (const line of (out ?? "").split("\n")) {
    const f = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    if (f.length < 3 || !PCI_GPU.test(f[0]!)) continue;
    const vendor = vendorOf(f[1]!);
    if (skip.has(vendor)) continue;
    const device = f[2]!.replace(/\s*\[[0-9a-f]{4}\]\s*$/i, "");
    const name = (device.match(/\[([^\]]+)\]\s*$/)?.[1] ?? device).trim();
    gpus.push({ name, vendor, kind: kindOf(vendor, name) });
  }
  // AMD's driver says how much memory a card has and how much is used; it is the only reliable place for it.
  for (let i = 0; i < 8; i++) {
    const dir = `/sys/class/drm/card${i}/device`;
    if (p.read(`${dir}/vendor`)?.trim() !== "0x1002") continue;
    const total = num(p.read(`${dir}/mem_info_vram_total`)), used = num(p.read(`${dir}/mem_info_vram_used`));
    if (!total) continue;
    const mem = { memoryMb: Math.round(total / MB), ...(used !== undefined ? { freeMb: Math.max(0, Math.round((total - used) / MB)) } : {}) };
    const at = gpus.findIndex((g) => g.vendor === "amd" && g.memoryMb === undefined);
    if (at >= 0) gpus[at] = { ...gpus[at]!, ...mem }; else gpus.push({ name: "AMD graphics card", vendor: "amd", kind: "unknown", ...mem });
  }
  return gpus;
}

/** macOS: `system_profiler` names the cards; Apple silicon has one memory for all, which is the memory of the computer. */
async function macOthers(p: Probe, ramMb: number): Promise<Gpu[]> {
  const out = await p.run(["system_profiler", "SPDisplaysDataType", "-json"], 10_000);
  let list: Record<string, unknown>[] = [];
  try { list = ((JSON.parse(out ?? "{}") as { SPDisplaysDataType?: Record<string, unknown>[] }).SPDisplaysDataType) ?? []; } catch { return []; }
  const gpus: Gpu[] = [];
  for (const g of list) {
    const name = String(g.sppci_model ?? g._name ?? "").trim();
    if (!name) continue;
    const vendor = vendorOf(`${String(g.spdisplays_vendor ?? "")} ${name}`);
    const kind = kindOf(vendor, name);
    const vram = /^(\d+)\s*(GB|MB)$/i.exec(String(g.spdisplays_vram ?? ""));
    const memoryMb = kind === "unified" ? ramMb : vram ? Number(vram[1]) * (vram[2]!.toUpperCase() === "GB" ? 1024 : 1) : undefined;
    gpus.push({ name, vendor, kind, ...(memoryMb ? { memoryMb } : {}) });
  }
  return gpus;
}

/** Windows: the video controllers by their names. The memory the system reports for them is capped at 4 GB, so it is not used. */
async function windowsOthers(p: Probe, skip: Set<Gpu["vendor"]>): Promise<Gpu[]> {
  const out = await p.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress"], 10_000);
  let rows: { Name?: string; DriverVersion?: string }[] = [];
  try { const parsed = JSON.parse(out ?? "[]") as unknown; rows = Array.isArray(parsed) ? parsed : parsed ? [parsed as { Name?: string }] : []; } catch { return []; }
  const gpus: Gpu[] = [];
  for (const r of rows) {
    const name = r.Name?.trim();
    if (!name) continue;
    const vendor = vendorOf(name);
    if (skip.has(vendor)) continue;
    gpus.push({ name, vendor, kind: kindOf(vendor, name), ...(r.DriverVersion ? { driver: r.DriverVersion } : {}) });
  }
  return gpus;
}

function osOf(p: Probe): Machine["os"] {
  if (p.platform === "win32") return "windows";
  if (p.platform === "darwin") return "macos";
  if (p.platform === "linux") return p.env.WSL_DISTRO_NAME || /microsoft/i.test(p.read("/proc/version") ?? "") ? "wsl" : "linux";
  return "unknown";
}

/** MemAvailable is what a Linux program can really get; elsewhere the system's own count of free memory is the best that is said (it can understate). */
function freeRamOf(p: Probe, os: Machine["os"]): number | undefined {
  if (os === "linux" || os === "wsl") {
    const kb = num(/^MemAvailable:\s+(\d+)\s*kB/m.exec(p.read("/proc/meminfo") ?? "")?.[1]);
    if (kb !== undefined) return Math.round(kb / 1024);
  }
  return p.ram().freeMb;
}

/** What the computer is, for the folder models are kept in (its volume is the one whose free space counts). */
export async function readMachine(p: Probe, dir: string): Promise<Machine> {
  const os = osOf(p);
  const ramMb = p.ram().totalMb;
  const gpus = await nvidia(p);
  const have = new Set<Gpu["vendor"]>(gpus.map((g) => g.vendor));
  if (os === "linux" || os === "wsl") gpus.push(...await linuxOthers(p, have));
  else if (os === "macos") gpus.push(...await macOthers(p, ramMb));
  else if (os === "windows") gpus.push(...await windowsOthers(p, have));
  const free = freeRamOf(p, os);
  const disk = p.disk(dir);
  return {
    os,
    arch: p.arch === "x64" ? "x64" : p.arch === "arm64" ? "arm64" : "unknown",
    gpus,
    ramMb,
    ...(free !== undefined ? { freeRamMb: free } : {}),
    ...(disk ? { disk: { path: dir, ...disk } } : {}),
  };
}

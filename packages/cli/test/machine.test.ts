import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHub } from "../src/commands/hub.ts";
import { configPath } from "../src/config.ts";
import { readMachine, realProbe, type Probe } from "../src/machine.ts";
import { fakeIO, remove, tempDir, until } from "./helpers.ts";

/** A computer that answers only what it is given: a program answers when its command line starts with the key, a file when its path is a key. */
function computer(o: { platform: NodeJS.Platform; arch?: string; env?: Record<string, string>; files?: Record<string, string>; programs?: Record<string, string>; ramMb?: number; freeMb?: number; disk?: { freeMb: number; totalMb: number } }): Probe & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    platform: o.platform, arch: o.arch ?? "x64", env: o.env ?? {},
    async run(argv) { const line = argv.join(" "); ran.push(line); const key = Object.keys(o.programs ?? {}).find((k) => line.startsWith(k)); return key ? o.programs![key] : undefined; },
    read: (p) => o.files?.[p],
    exists: (p) => p in (o.files ?? {}),
    ram: () => ({ totalMb: o.ramMb ?? 16384, freeMb: o.freeMb ?? 4000 }),
    disk: () => o.disk,
  };
}

const NVIDIA_ROW = "NVIDIA GeForce RTX 4090, 24564, 23102, 550.54.14\n";
const NVIDIA_QUERY = "nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits";

describe("Linux", () => {
  test("an NVIDIA card: name, memory, what is free, driver; RAM is what a program can really get; the disk is the folder's volume", async () => {
    const m = await readMachine(computer({ platform: "linux", ramMb: 32768, files: { "/proc/meminfo": "MemTotal: 33554432 kB\nMemFree: 1000 kB\nMemAvailable: 20971520 kB\n", "/proc/version": "Linux version 6.1 (gcc)" }, programs: { [NVIDIA_QUERY]: NVIDIA_ROW }, disk: { freeMb: 500_000, totalMb: 1_000_000 } }), "/data/navvied");
    expect(m).toEqual({ os: "linux", arch: "x64", ramMb: 32768, freeRamMb: 20480, gpus: [{ name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", kind: "discrete", memoryMb: 24564, freeMb: 23102, driver: "550.54.14" }], disk: { path: "/data/navvied", freeMb: 500_000, totalMb: 1_000_000 } });
  });

  test("two NVIDIA cards are two cards", async () => {
    const m = await readMachine(computer({ platform: "linux", programs: { [NVIDIA_QUERY]: `${NVIDIA_ROW}NVIDIA GeForce RTX 3060, 12288, 100, 550.54.14\n` } }), "/d");
    expect(m.gpus.map((g) => [g.name, g.memoryMb, g.freeMb])).toEqual([["NVIDIA GeForce RTX 4090", 24564, 23102], ["NVIDIA GeForce RTX 3060", 12288, 100]]);
  });

  test("an AMD card: the name from lspci, its memory from the driver's files; an Intel one that is built in has no memory of its own", async () => {
    const lspci = [
      '00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "Alder Lake-P GT2 [Iris Xe Graphics] [46a6]" -r0c "Dell [1028]" "Device [0a5b]"',
      '03:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 21 [Radeon RX 6800/6800 XT / 6900 XT] [73bf]" -rc1 "Sapphire [1da2]" "Device [e438]"',
    ].join("\n");
    const m = await readMachine(computer({ platform: "linux", programs: { "lspci -mm -nn": lspci }, files: { "/sys/class/drm/card1/device/vendor": "0x1002\n", "/sys/class/drm/card1/device/mem_info_vram_total": `${16 * 1024 * 1024 * 1024}\n`, "/sys/class/drm/card1/device/mem_info_vram_used": `${1024 * 1024 * 1024}\n` } }), "/d");
    const amd = m.gpus.find((g) => g.vendor === "amd")!;
    expect(amd).toEqual({ name: "Radeon RX 6800/6800 XT / 6900 XT", vendor: "amd", kind: "discrete", memoryMb: 16384, freeMb: 15360 });
    expect(m.gpus.find((g) => g.vendor === "intel")).toEqual({ name: "Iris Xe Graphics", vendor: "intel", kind: "integrated" });
  });

  test("a card the name of which does not say what it is stays unknown, and a memory file that is not there is no memory", async () => {
    const lspci = '04:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Something New [ffff]" -r00';
    const m = await readMachine(computer({ platform: "linux", programs: { "lspci -mm -nn": lspci } }), "/d");
    expect(m.gpus).toEqual([{ name: "Something New", vendor: "amd", kind: "unknown" }]);
  });

  test("WSL is told from Linux by the kernel's name, and its NVIDIA tool is found where WSL puts it", async () => {
    const m = await readMachine(computer({ platform: "linux", files: { "/proc/version": "Linux version 5.15.153.1-microsoft-standard-WSL2" }, programs: { "/usr/lib/wsl/lib/nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits": NVIDIA_ROW } }), "/d");
    expect(m.os).toBe("wsl");
    expect(m.gpus[0]).toMatchObject({ vendor: "nvidia", memoryMb: 24564 });
  });

  test("nothing readable: no card, and what cannot be said is not said", async () => {
    const m = await readMachine(computer({ platform: "linux" }), "/d");
    expect(m).toEqual({ os: "linux", arch: "x64", gpus: [], ramMb: 16384, freeRamMb: 4000 });
    expect("disk" in m).toBe(false);
  });
});

describe("macOS", () => {
  test("Apple silicon: one memory for all, and it is the memory of the computer", async () => {
    const profiler = JSON.stringify({ SPDisplaysDataType: [{ _name: "Apple M2 Pro", spdisplays_vendor: "sppci_vendor_Apple", sppci_model: "Apple M2 Pro", sppci_cores: "19" }] });
    const m = await readMachine(computer({ platform: "darwin", arch: "arm64", ramMb: 32768, programs: { "system_profiler SPDisplaysDataType -json": profiler } }), "/d");
    expect(m).toMatchObject({ os: "macos", arch: "arm64", ramMb: 32768, gpus: [{ name: "Apple M2 Pro", vendor: "apple", kind: "unified", memoryMb: 32768 }] });
  });

  test("an Intel Mac: the card with memory of its own is discrete, the one built in is not", async () => {
    const profiler = JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "AMD Radeon Pro 5500M", spdisplays_vendor: "sppci_vendor_amd", spdisplays_vram: "8 GB" }, { sppci_model: "Intel UHD Graphics 630", spdisplays_vendor: "sppci_vendor_intel", spdisplays_vram_shared: "1536 MB" }] });
    const m = await readMachine(computer({ platform: "darwin", programs: { "system_profiler SPDisplaysDataType -json": profiler } }), "/d");
    expect(m.gpus).toEqual([{ name: "AMD Radeon Pro 5500M", vendor: "amd", kind: "discrete", memoryMb: 8192 }, { name: "Intel UHD Graphics 630", vendor: "intel", kind: "integrated" }]);
  });

  test("a profiler that answers nothing usable is no card", async () => {
    expect((await readMachine(computer({ platform: "darwin", programs: { "system_profiler": "not json" } }), "/d")).gpus).toEqual([]);
  });
});

describe("Windows", () => {
  const cim = (rows: unknown) => ({ "powershell.exe -NoProfile -NonInteractive -Command Get-CimInstance Win32_VideoController": JSON.stringify(rows) });

  test("an NVIDIA card from its own tool, and the built-in one of the processor from the system's list; the same card is not said twice", async () => {
    const m = await readMachine(computer({ platform: "win32", programs: { ...cim([{ Name: "NVIDIA GeForce RTX 3070", DriverVersion: "31.0.15.5222" }, { Name: "Intel(R) UHD Graphics 770", DriverVersion: "31.0.101.4146" }]), [NVIDIA_QUERY]: "NVIDIA GeForce RTX 3070, 8192, 7000, 552.22\n" } }), "C:\\d");
    expect(m.os).toBe("windows");
    expect(m.gpus).toEqual([{ name: "NVIDIA GeForce RTX 3070", vendor: "nvidia", kind: "discrete", memoryMb: 8192, freeMb: 7000, driver: "552.22" }, { name: "Intel(R) UHD Graphics 770", vendor: "intel", kind: "integrated", driver: "31.0.101.4146" }]);
  });

  test("one card is an object, not a list; an AMD card has no memory said (the system caps it at 4 GB)", async () => {
    const m = await readMachine(computer({ platform: "win32", programs: cim({ Name: "AMD Radeon RX 7900 XTX", DriverVersion: "31.0.21001" }) }), "C:\\d");
    expect(m.gpus).toEqual([{ name: "AMD Radeon RX 7900 XTX", vendor: "amd", kind: "discrete", driver: "31.0.21001" }]);
  });

  test("a list that does not answer is no card", async () => {
    expect((await readMachine(computer({ platform: "win32" }), "C:\\d")).gpus).toEqual([]);
  });
});

describe("on this computer", () => {
  test("the real probe reads the memory and the disk, and every program it runs is given a time", async () => {
    const asked: { argv: string[]; timeoutMs?: number }[] = [];
    const p = realProbe({ async run(argv, o) { asked.push({ argv, ...(o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) }); return { code: 1, output: "" }; } });
    const m = await readMachine(p, process.cwd());
    expect(m.ramMb).toBeGreaterThan(0);
    expect(m.disk!.freeMb).toBeGreaterThan(0);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => typeof a.timeoutMs === "number" && a.timeoutMs > 0)).toBe(true);
  });
});

describe("asked through the hub", () => {
  const open = (cloud: false | "flag" | "config") => {
    const state = tempDir(), work = tempDir();
    const env = { HOME: state, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state, NAVVIED_GUEST_MODELS: "0", NAVVIED_LOCAL_DIR: join(state, "not", "made", "yet") };
    const file = configPath(env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ models: { m: { baseUrl: "http://127.0.0.1:1/v1", model: "x", window: 1000 } }, ...(cloud === "config" ? { webProxy: { url: "http://127.0.0.1:1/v1/web", token: "t" } } : {}) }));
    const hub = createHub({ json: false, yes: false, thinking: false, cwd: work, ...(cloud === "flag" ? { sandboxed: true } : {}) } as never, fakeIO({ env }).io, { watch: false, import: false });
    const got: { ev: string; msg?: string; ramMb?: number; disk?: { path: string; freeMb: number } }[] = [];
    hub.attach({ send: (line) => { got.push(JSON.parse(String(line))); } }, 0);
    return { got, send: (cmd: object) => hub.command(JSON.stringify(cmd), () => undefined), cleanup: () => { remove(state); remove(work); } };
  };

  test("the machine is read, with the free space of the volume the models folder is on even before the folder is made", async () => {
    const c = open(false);
    c.send({ cmd: "machine" });
    await until(() => c.got.some((e) => e.ev === "machine"));
    const m = c.got.find((e) => e.ev === "machine")!;
    expect(m.ramMb).toBeGreaterThan(0);
    expect(m.disk!.freeMb).toBeGreaterThan(0);
    expect(m.disk!.path).toContain(join("not", "made", "yet"));
    c.cleanup();
  });

  test("in Navvied Cloud it is refused: the hardware there is the servers'", async () => {
    for (const how of ["flag", "config"] as const) {
      const c = open(how);
      c.send({ cmd: "machine" });
      await until(() => c.got.some((e) => e.ev === "error"));
      expect(c.got.some((e) => e.ev === "machine")).toBe(false);
      c.cleanup();
    }
  });
});

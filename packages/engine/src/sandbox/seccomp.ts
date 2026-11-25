/**
 * A seccomp filter for bubblewrap, written here so that no library is needed. It is a denylist: a program that asks for one of these
 * calls gets EPERM, every other call goes through, so ordinary programs are not affected. The list is what a confined command has no
 * business doing: watching or changing other programs, changing mounts, the kernel or the clock, and the calls that reach around
 * the file rules (handles opened by number, the newer mount calls).
 */

const AUDIT_X86_64 = 0xc000003e;
const AUDIT_AARCH64 = 0xc00000b7;
const X32_FLAG = 0x40000000;

/** System call numbers by name. aarch64 uses the generic table, so the newer calls have the same number on both. */
const X86_64: Record<string, number> = {
  ptrace: 101, process_vm_readv: 310, process_vm_writev: 311, kcmp: 312, pidfd_getfd: 438,
  mount: 165, umount2: 166, pivot_root: 155, move_mount: 429, open_tree: 428, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
  reboot: 169, kexec_load: 246, kexec_file_load: 320, init_module: 175, finit_module: 313, delete_module: 176, swapon: 167, swapoff: 168,
  bpf: 321, perf_event_open: 298, userfaultfd: 323, keyctl: 250, add_key: 248, request_key: 249,
  open_by_handle_at: 304, acct: 163, settimeofday: 164, iopl: 172, ioperm: 173, lookup_dcookie: 212, quotactl: 179, vhangup: 153,
};
const AARCH64: Record<string, number> = {
  ptrace: 117, process_vm_readv: 270, process_vm_writev: 271, kcmp: 272, pidfd_getfd: 438,
  mount: 40, umount2: 39, pivot_root: 41, move_mount: 429, open_tree: 428, fsopen: 430, fsconfig: 431, fsmount: 432, fspick: 433, mount_setattr: 442,
  reboot: 142, kexec_load: 104, kexec_file_load: 294, init_module: 105, finit_module: 273, delete_module: 106, swapon: 224, swapoff: 225,
  bpf: 280, perf_event_open: 241, userfaultfd: 282, keyctl: 219, add_key: 217, request_key: 218,
  open_by_handle_at: 265, acct: 89, settimeofday: 170, lookup_dcookie: 18, quotactl: 60, vhangup: 58,
};

export const DENIED_CALLS = { x64: X86_64, arm64: AARCH64 } as const;

const LD_W_ABS = 0x20, JEQ_K = 0x15, JGE_K = 0x35, RET_K = 0x06;
const ALLOW = 0x7fff0000;
const errno = (n: number): number => 0x00050000 | n;
const EPERM = 1, ENOSYS = 38;

type Op = [code: number, jt: number, jf: number, k: number];

/** The program as bytes (a `struct sock_filter` each, little endian), or nothing for a processor this does not know. */
export function seccompProgram(arch: string = process.arch): Uint8Array | undefined {
  const table = arch === "x64" ? X86_64 : arch === "arm64" ? AARCH64 : undefined;
  if (!table) return undefined;
  const audit = arch === "x64" ? AUDIT_X86_64 : AUDIT_AARCH64;
  const numbers = [...new Set(Object.values(table))].sort((a, b) => a - b);
  const x32 = arch === "x64";
  // A call made in another ABI of the same processor has other numbers: it is refused whole, not looked up in this table.
  const head: Op[] = [
    [LD_W_ABS, 0, 0, 4],
    [JEQ_K, 1, 0, audit], [RET_K, 0, 0, errno(ENOSYS)],
    [LD_W_ABS, 0, 0, 0],
    ...(x32 ? ([[JGE_K, 0, 1, X32_FLAG], [RET_K, 0, 0, errno(ENOSYS)]] as Op[]) : []),
  ];
  // Each number jumps to the last instruction, which refuses; the jump counts instructions still to pass.
  const checks: Op[] = numbers.map((n, i) => [JEQ_K, numbers.length - i, 0, n]);
  const program: Op[] = [...head, ...checks, [RET_K, 0, 0, ALLOW], [RET_K, 0, 0, errno(EPERM)]];
  const out = new Uint8Array(program.length * 8);
  const view = new DataView(out.buffer);
  program.forEach(([code, jt, jf, k], i) => { view.setUint16(i * 8, code, true); view.setUint8(i * 8 + 2, jt); view.setUint8(i * 8 + 3, jf); view.setUint32(i * 8 + 4, k, true); });
  return out;
}

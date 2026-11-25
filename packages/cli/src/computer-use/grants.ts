/**
 * The two grants macOS asks a program for before it may drive other programs: Accessibility (to read and press their controls) and Screen
 * Recording (to see them). The driver is a child of this program, so the grants are this program's own (the app's, or the terminal's) and
 * this program is the one that asks for them. No other system has such a grant.
 */
export type GrantId = "accessibility" | "screen-recording";
export type GrantState = "granted" | "missing" | "not-needed";

export interface Grants {
  state(id: GrantId): GrantState;
  /** Shows the system's own question for the grant. It is asked once, and a grant already refused is only changed in System Settings. */
  ask(id: GrantId): void;
  /** Opens the page of System Settings where the person turns the grant on. */
  settings(id: GrantId): void;
}

export const SETTINGS_URL: Record<GrantId, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

/** Systems with no grants. */
export const noGrants: Grants = { state: () => "not-needed", ask: () => undefined, settings: () => undefined };

/** The grants, asked of the system through its own libraries. Only on macOS. */
export async function macGrants(open: (url: string) => void): Promise<Grants> {
  const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
  const ax = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", {
    AXIsProcessTrusted: { args: [], returns: FFIType.bool },
    AXIsProcessTrustedWithOptions: { args: [FFIType.ptr], returns: FFIType.bool },
    CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
    CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
  }).symbols;
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    CFDictionaryCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  }).symbols;
  const sys = dlopen("/usr/lib/libSystem.B.dylib", { dlsym: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.ptr } }).symbols;
  const RTLD_DEFAULT = -2n;
  /** Memory the system is handed an address of stays referenced for as long as this program runs. */
  const held: Buffer[] = [];
  const text = (t: string) => { const b = Buffer.from(`${t}\0`); held.push(b); return ptr(b); };
  const global = (name: string) => sys.dlsym(RTLD_DEFAULT, text(name));

  const askAccessibility = (): void => {
    // The option that makes the system show its question is a dictionary with the one key the system documents, set to true.
    const key = cf.CFStringCreateWithCString(null, text("AXTrustedCheckOptionPrompt"), 0x08000100);
    const yes = read.ptr(global("kCFBooleanTrue") as never, 0);
    const keys = new BigUint64Array([BigInt(key as never)]), values = new BigUint64Array([BigInt(yes as never)]);
    held.push(Buffer.from(keys.buffer), Buffer.from(values.buffer));
    const dict = cf.CFDictionaryCreate(null, ptr(keys), ptr(values), 1n, global("kCFTypeDictionaryKeyCallBacks"), global("kCFTypeDictionaryValueCallBacks"));
    ax.AXIsProcessTrustedWithOptions(dict);
    cf.CFRelease(dict); cf.CFRelease(key);
  };
  return {
    state: (id) => ((id === "accessibility" ? ax.AXIsProcessTrusted() : ax.CGPreflightScreenCaptureAccess()) ? "granted" : "missing"),
    ask: (id) => { if (id === "accessibility") askAccessibility(); else ax.CGRequestScreenCaptureAccess(); },
    settings: (id) => { open(SETTINGS_URL[id]); },
  };
}

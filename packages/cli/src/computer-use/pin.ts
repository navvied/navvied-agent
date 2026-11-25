/**
 * The one driver build the host runs, as a descriptor and not as an address: moving to our own build changes this file and nothing else.
 * The hashes are those of upstream's release assets, the same ones its own checksum list gives and another product pins (read 2026-11-25).
 */
export type Target = "darwin" | "linux-x86_64" | "linux-arm64" | "windows-x86_64" | "windows-arm64";
export type Signer =
  | { kind: "apple"; teamIds: readonly string[] }
  | { kind: "authenticode"; subject: string }
  | { kind: "none" };

export interface PinnedAsset {
  asset: string;
  sha256: string;
  /** Bytes, when known from the release; the download is also stopped by the hash. */
  size?: number;
  format: "tar.gz" | "zip";
  /** The program inside the archive, relative to where it is unpacked. */
  entry: string;
  signer: Signer;
}

export interface Pin {
  version: string;
  /** Where assets are fetched from: `<base>/<asset>`. */
  base: string;
  /** Label macOS and the driver show for who started it (advisory only; the grants belong to the host program). */
  bundleId: string;
  /** The tools and properties the host needs to find in `tools/list`; a driver without them is not the pinned one, whatever its version says. */
  needs: Record<string, readonly string[]>;
  assets: Record<Target, PinnedAsset>;
}

const apple: Signer = { kind: "apple", teamIds: ["4YEC26S9KF", "YCK386LBJ7"] };
const windows: Signer = { kind: "authenticode", subject: "Cua AI, Inc." };

export const PIN: Pin = {
  version: "0.52.0",
  base: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.52.0",
  bundleId: "com.navvied.agent",
  needs: { click: ["pid", "delivery_mode"], type_text: ["pid", "text", "delivery_mode"] },
  assets: {
    darwin: { asset: "cua-driver-rs-0.52.0-darwin-universal.tar.gz", sha256: "19e5e652db83cc0324e7a3898ee875b87b265ad7e1c09fd862ef78869480f61d", format: "tar.gz", entry: "cua-driver-rs-0.52.0-darwin-universal/cua-driver", signer: apple },
    "linux-x86_64": { asset: "cua-driver-rs-0.52.0-linux-x86_64-binary.tar.gz", sha256: "55c99ec4177170b1a440a5efd41e55bacae1e9fe257c96dcd9e5b81ef9085036", format: "tar.gz", entry: "cua-driver", signer: { kind: "none" } },
    "linux-arm64": { asset: "cua-driver-rs-0.52.0-linux-arm64-binary.tar.gz", sha256: "5c7d0a36c0e368fb2847f226ca1435c60bfb79ac3968d9b08a94d82c97da880a", format: "tar.gz", entry: "cua-driver", signer: { kind: "none" } },
    "windows-x86_64": { asset: "cua-driver-rs-0.52.0-windows-x86_64-binary.zip", sha256: "788178cbdcce4de0121f6d04ef6cb5e9d512503371e60a70563aa6f69cdd50af", format: "zip", entry: "cua-driver.exe", signer: windows },
    "windows-arm64": { asset: "cua-driver-rs-0.52.0-windows-arm64-binary.zip", sha256: "73e0a7daae34b81a15aa16d3827cb44b975254130906f99dfcd49ea4c518d40c", format: "zip", entry: "cua-driver.exe", signer: windows },
  },
};

export type Support = { ok: true; target: Target } | { ok: false; why: "wayland" | "platform"; message: string };

/** What this computer can be driven as. A Wayland session has no input into another program's window that stays in the background, so it is refused before anything is installed. */
export function supportOf(platform: string, arch: string, env: Record<string, string | undefined>): Support {
  if (platform === "darwin") return { ok: true, target: "darwin" };
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : undefined;
  if (!cpu) return { ok: false, why: "platform", message: `This kind of processor (${arch}) is not supported.` };
  if (platform === "win32") return { ok: true, target: `windows-${cpu}` };
  if (platform === "linux") {
    const wayland = env.XDG_SESSION_TYPE === "wayland" || (!!env.WAYLAND_DISPLAY && !env.DISPLAY);
    if (wayland) return { ok: false, why: "wayland", message: "Controlling other programs in the background does not work on Wayland. Sign in with an X11 session instead." };
    if (!env.DISPLAY) return { ok: false, why: "platform", message: "There is no screen to control." };
    return { ok: true, target: `linux-${cpu}` };
  }
  return { ok: false, why: "platform", message: `${platform} is not supported.` };
}

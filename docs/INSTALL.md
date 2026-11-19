# Install

**macOS and Linux**

```
curl -fsSL https://github.com/navvied/navvied-agent/releases/latest/download/install.sh | sh
navvied
```

**Windows** (PowerShell)

```
irm https://github.com/navvied/navvied-agent/releases/latest/download/install.ps1 | iex
navvied
```

**Docker** (any machine that runs containers)

```
docker build -t navvied .
docker run --rm -it -v "$PWD":/work -v navvied-config:/root/.config/navvied navvied
```

The installers pick the right program for your machine, check its checksum, put it in a per-user folder (no administrator
rights needed) and add that folder to your `PATH`. Open a new terminal and type `navvied`. On the first run it sets up a model
with you: it finds model servers already running on your machine, or takes an API address and key, or the command of an
agent program you are signed in to.

```
navvied doctor      check that everything is in order
navvied update      update to the latest release
navvied init        set up another model
```

Install a specific version: `... | sh -s -- --version v0.1.0` (Windows: `$env:NAVVIED_VERSION = "v0.1.0"` first).
Install somewhere else: `NAVVIED_INSTALL_DIR=/opt/bin`.

## The desktop app

A window instead of a terminal: nothing to type, the program is inside. Open the release page
(`https://github.com/navvied/navvied-agent/releases/latest`) and take the file for your computer:

| System | File | Opens with |
|---|---|---|
| macOS, Apple silicon (M1 and later) | `navvied-desktop-<version>-macos-arm64.dmg` | Open the file and drag navvied onto Applications |
| macOS, Intel | `navvied-desktop-<version>-macos-x64.dmg` | The same |
| Windows 10 and 11, 64-bit | `navvied-desktop-<version>-windows-x64-setup.exe` | Run it; no administrator rights needed |
| Linux, any | `navvied-desktop-<version>-linux-x64.AppImage` | `chmod +x` the file, then run it |
| Ubuntu and Debian | `navvied-desktop-<version>-linux-x64.deb` | `sudo apt install ./navvied-desktop-<version>-linux-x64.deb` |

`SHA256SUMS-desktop` on the same page lists the checksum of each file. To check one: `shasum -a 256 <file>` (macOS), `sha256sum <file>` (Linux),
`Get-FileHash <file>` (Windows PowerShell). The result must equal the line for that file.

**These files are not signed yet.** Signing needs an Apple Developer account and a Windows certificate, which are not set up, so your computer
shows a warning the first time. The warning is about who made the file, not about what is in it; the checksum above is how you check the file.

* **macOS** says "navvied cannot be opened because Apple cannot check it for malicious software". Click Done, then open System Settings, Privacy & Security,
  scroll to the message about navvied and click Open Anyway (on macOS 14 and earlier you can instead right-click the app and choose Open). You do this once.
* **Windows** shows "Windows protected your PC". Click More info, then Run anyway.
* **Linux** shows nothing. If the AppImage does not start, your system may need FUSE (`sudo apt install libfuse2`); the `.deb` installs what it needs. On GNOME
  the tray icon needs the AppIndicator extension; without it the window still works, and `navvied-desktop --settings` opens the settings.

The app starts `navvied` itself on your computer, so the terminal program is not needed. It uses the same configuration, models and saved conversations as
`navvied`, so you can use both. Closing the window keeps it running in the menu bar or tray (a setting); Quit in that menu stops it.

## Supported machines

| System | Processors | Build |
|---|---|---|
| macOS | Apple silicon, Intel | `navvied-darwin-arm64`, `navvied-darwin-x64` |
| Linux (glibc) | x64, ARM64 | `navvied-linux-x64`, `navvied-linux-arm64` |
| Linux (musl, e.g. Alpine) | x64, ARM64 | `navvied-linux-x64-musl`, `navvied-linux-arm64-musl` |
| Linux, x64 CPUs without AVX2 | x64 | `navvied-linux-x64-baseline` (chosen automatically) |
| Windows 10 and 11 | x64 (ARM PCs run it through emulation) | `navvied-windows-x64.exe`, `-baseline` for CPUs without AVX2 |

Phones and tablets cannot run a command-line program. The plan for them is the browser: the same engine behind
`navvied serve`, with a web front-end.

## Without the installers

Download the file for your machine from the release page, check it against `SHA256SUMS`, make it executable and put it on your `PATH`.

## From source

Needs [Bun](https://bun.sh) and git.

```
git clone git@github.com:navvied/navvied-agent.git
cd navvied-agent
bun build --compile packages/cli/src/main.ts --outfile ~/.local/bin/navvied
```

## What has been verified

* **Linux (glibc, x64):** tested end to end with a compiled program: installer, first-run setup, chat.
* **Docker:** the image builds and runs (`--version`, `doctor`).
* **macOS, musl, baseline, ARM:** the installer's choice of build and the updater are covered by automated tests that simulate
  each machine; the programs themselves are built by the release workflow, which has not run yet.
* **Windows:** the installer, the program and the shell/path handling are written and unit-tested on Linux, but nothing has
  run on Windows yet. CI runs the test suite on Windows (reported, not blocking) so problems show up there.

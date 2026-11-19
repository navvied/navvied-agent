# The desktop app (plan)

Status: the previews are approved. `packages/desktop/core` (the supervisor and everything testable without a window) is built and tested; `packages/desktop/src-tauri` (the window, tray, notices, links, updates) is written and compiled, and its first real run is in CI.

A small native window around the web UI in `packages/web`, with the `navvied` program inside the app as a helper process (a sidecar). The person installs it, opens it and chats. No terminal, no pairing, no address to paste.

## Shape

```
 ┌───────────── navvied app (Tauri 2, Rust) ─────────────┐
 │ window (system web view) ──► http://127.0.0.1:<port>  │
 │ tray / menu bar, notices, updates, deep links         │
 │ supervisor ──► navvied serve --http (sidecar)         │
 │ event listener ──► ws://127.0.0.1:<port>/ws           │
 └────────────────────────────────────────────────────────┘
```

* Tauri 2 uses the web view that the system already has (WKWebView, WebView2, WebKitGTK), so the shell is about 10 MB. Measured on Linux x64: the compiled `navvied` program is 95 MB (36 MB gzipped), so it is the sidecar that decides the download size, about 45 MB per installer. Electron would add a browser of roughly 100 MB more. `arboard` and `image` (paste's clipboard fallback — see "Files" below), measured release build vs. the commit before them, same machine: the shell binary itself grew 151,168 bytes (7,333,328 → 7,484,496, ~2.1%); the `.deb` grew 76,602 bytes (56,162,382 → 56,238,984 bytes, ~0.14% — compression hides most of the binary's own growth).
* The shell has Rust dependencies. The rule "zero third-party runtime dependencies" applies to `protocol`, `engine` and `cli`; the sidecar is the unchanged `cli`.
* New workspace folder `packages/desktop` (`src-tauri/` for Rust, `shell-pages/` for a few static pages). The web UI is not copied: the sidecar serves it (`--web` is not needed, the build is embedded).

### Start-up

1. Single-instance lock. A second launch focuses the first window (preview 25).
2. Make a random token (24 random bytes, base64url). It stays in memory. The port is the one used last time, so the page keeps the same address and the settings it saved there (the page stores them per address); if it is taken, any free port.
3. Start `navvied serve --http --host 127.0.0.1 --port <port> --ready-line --exit-when-stdin-closes --cwd <project folder>` with `NAVVIED_SERVE_TOKEN=<token>` and `NAVVIED_NO_UPDATE=1` (the app updates the whole bundle; the program inside must never replace itself, that would break the signature).
4. Wait for `GET /api/info` (with the token) to answer, with a 10 second limit, then load the page. Until then the window shows the bundled "Starting" page (27).
5. Hand the token to the page **without a URL**: an initialisation script, injected only for the exact loopback origin, writes `navvied.target` into `sessionStorage` before any page script runs. The web UI already reads that key (`loadTarget` in `packages/web/src/target.ts`). The token is never in the address, in a log, in the window title or in an error report.

### Supervision

* The shell keeps the sidecar's standard input open. **Needs a small CLI flag (below)**: the sidecar exits when that pipe closes, which works the same on all three systems and covers the shell being killed. Windows also gets a job object and Linux `PR_SET_PDEATHSIG` as a second line.
* Quit: close the pipe, wait 3 seconds, then kill. A running task is cancelled first (`cancel` command).
* Crash: restart after 0.5 s, 1 s, 2 s. The third crash inside 60 seconds stops the restarts and shows preview 22. While restarting the web UI shows the banner of preview 20/21.
* After a restart the page sends `load <session id>` and continues from the engine's stable event cursor (engine work in progress; a web test must cover it).
* The event listener (a small WebSocket client in the Rust shell) watches `approval`, `done` and `error` events. Notices must work with the window closed, and a hidden web view is throttled by the system, so the page is not used for this. The listener reads event names only; a notice for an approval shows the approval title, a notice for a finished task shows no file content. A setting hides the details.

### Security rules (checked in review, tested where a test can reach)

* The window may load only `http://127.0.0.1:<port>`. Any other navigation is cancelled; a link the model wrote (http, https, mailto) opens in the system browser after the page's own allow-list.
* The page gets almost no native power. Tauri's capability file lists exactly seven commands for that origin: choose a folder, read the desktop settings, open the settings page, and four for pairing with navvied.com over the relay (make a link, read the status, forget a device, answer a pending question — see "Pairing with navvied.com" below). Everything else (notices, updates, tray, files) is called by Rust, never by page code.
* The sidecar listens on loopback only and refuses other `Host` headers (`serve-http.ts` already does). The page's content security policy comes from the sidecar's response headers, unchanged and strict; the bundled shell pages carry their own (`default-src 'self'; connect-src 'none'`).
* The token passes through the sidecar's environment, which the same user's other programs can read. That is the same trust level as the config file; it is not stronger. A stricter hand-over (token over the pipe) needs a CLI change and is listed as optional.
* Deep links never run anything: `navvied://chat?text=…` only fills the message box after a question (16), `navvied://open?folder=…` asks before switching folders. Unknown paths are ignored. All values are length limited and shown as plain text.
* The updater verifies a signature with a public key built into the app, over the download, before anything is replaced (19 shows a refusal).

### The bundle identifier

`com.navvied.desktop` is written in one place only: `packages/desktop/src-tauri/tauri.conf.json` (`identifier`). Everything else derives from it, and it cannot change after people have installed the app without losing what hangs on it: the macOS code signature and notarisation record, the Login Items entry (`open when I sign in`), the folders for settings and logs (`~/Library/Application Support/com.navvied.desktop`, `%APPDATA%\com.navvied.desktop`, `~/.local/share/com.navvied.desktop`), the Windows application id used by notices and the taskbar, the Linux `.desktop` file name, and the `navvied://` link registration. The maintainer confirms it before the first signed build.

### Icons

The app icon is the brand icon (`packages/web/public/icon.svg`) rasterised to png, ico and icns. The menu bar and tray icon is a plain outline hexagon (`src-tauri/icons/tray.svg`): black as a macOS template image (macOS tints it for light and dark menu bars), the accent colour on Windows and Linux so it reads on any panel.

## What the engine and the web UI must provide first

These are not in `main` today. The app cannot be finished without them.

| Where | What | Why |
|---|---|---|
| `packages/cli` `serve --http` | `--ready-line`: once listening, one token-free line on standard error, `navvied-ready {"port":N}` (and `--port 0` is already honoured); with the flag the token-bearing start-up text is not printed | The shell needs the real port. The normal start-up text contains the token and must never be parsed or kept. |
| `packages/cli` `serve --http` | `--exit-when-stdin-closes`, and `NAVVIED_NO_UPDATE=1` switching the self-updater off | Kills the sidecar when the shell dies, on every system; keeps the signed bundle intact. |
| `packages/cli` + `packages/web` | **A real "connect a model" flow over HTTP.** Today the web page only shows `navvied init` for a terminal. Previews 02 and 03 need endpoints such as `GET /api/setup/discover` (model servers found on this computer), `POST /api/setup/test`, `POST /api/setup/save`, reusing the code behind `navvied init` and `presets.ts`. | A person who never opens a terminal must be able to connect a model. Keys are written to the configuration file (mode 0600) and are never sent back to the page. This is the largest missing piece and it also helps the browser version. |
| engine | A session that can be resumed with a stable event cursor | After a sidecar restart the page does `load` and carries on, with no reset of its cursor. |
| `packages/cli` | Changing the project folder: restart the sidecar with a new `--cwd` (the shell does it) | A running engine has a fixed folder. |
| `packages/web` | A small "desktop bridge" (`window.navviedDesktop`, present only inside the app): chooseFolder, the "This computer" settings page (14), the drop and deep-link questions (9, 16), the update card (17 to 19), the crash banner (20 to 22), the footer text "This computer" instead of the address | These screens are drawn by the web UI so they follow its theme. Bear owns that code; the contract is listed here for him. |
| `packages/web` | Test in WebKit | The UI was tested in Chrome only. WKWebView and WebKitGTK are not Chrome. |

**Stopping.** The protocol has `cancel` and no pause, so the app does not pretend to have one. The menu item is "Stop the current task" (greyed out while nothing runs) and sends `cancel`.

## Pairing with navvied.com

Built, with no UI yet: the non-UI half of the same `/remote` relay the interactive terminal already has
(`docs/RELAY.md`), reachable from the desktop app's own sidecar instead of only from a terminal session. No account
is needed — this is the direct link-and-code pairing, not the account-based "My computers" (`docs/ACCOUNTS.md`),
which is a separate, later piece.

* **The sidecar** (`serve --http`) reuses `RelayHost` exactly as `/remote` does, wired to the same `hub` and the
  same `DeviceStore` the local `connect=` pairing already uses. Four endpoints, authorised the same way as
  `/api/devices` (the app's own bearer token, never a paired website's key): `POST /api/relay/pair` (makes a link
  and a code), `GET /api/relay/status` (what is connected, and the one question waiting for a decision, if there
  is one), `POST /api/relay/forget` (stops sharing with a device), `POST /api/relay/answer` (answers a pending
  question by its id). A device paired before reconnects by itself on the next start, the same as the terminal.
* **The pending question** ("a website wants to use navvied") has no terminal to ask in here, so it is published
  over the sidecar's own `/ws` (the same socket the shell already keeps open for notices, via Bun's topic publish —
  a line with a `relay` key and no `ev` key, which `events::Tracker` on the Rust side already ignores safely) and
  also sits in `/api/relay/status` for a shell that was not listening yet. The shell's event listener
  (`start_listener` in `shell.rs`) forwards any such line to the webview as a Tauri `relay` event, unexamined: it
  does not know or care what a particular one means, it just delivers it.
* **Four Rust commands** (`relay_pair`, `relay_status`, `relay_forget`, `relay_answer`), on the loopback page's
  capability list with the three it already had. Each is a thin HTTP call into the sidecar with the app's own
  token (`shell.rs`'s `relay_call`), guarded the same way `shell_answer` is (`from_loopback`).
* **Not built yet, on purpose: the card itself.** "A website wants to use navvied on this computer" is a screen a
  person sees, so it waits for its own Liquid Glass preview and approval, same as every other screen in this app.
  Until it exists, a `relay` event with nothing listening for it is simply not shown — pairing works, but nobody
  is asked, so nothing is approved either, which is the safe default.

## Files: drag-drop, paste, the "+" dialog

A file a person drags onto the window, pastes, or picks through the page's own `<input type="file">` must reach
the page exactly as it would in a browser tab — as a real `File` in `dataTransfer.files` or `clipboardData.files`,
with the page's own code (the composer, and later the `files` field on a prompt once the engine accepts it) doing
the rest. Nothing here is new UI: the attach menu, the drop zone outline, the file chips are the web UI's, already
built (`packages/web/src/composer.ts`).

**What WebKitGTK actually does with a real file, confirmed with its own remote inspector** (`WEBKIT_INSPECTOR_SERVER`,
driving the real app with `tauri-driver`/`WebKitWebDriver` and reading `dataTransfer`/`clipboardData` straight out of
the live page, not guessed): a dropped local file — even offered the way a real file manager offers one, with
`text/uri-list`, `x-special/gnome-copied-files` *and* `image/png` all on the table — is given to the page only as a
`text/uri-list` **string**; `dataTransfer.files` stays empty. A clipboard image is worse: `clipboardData` comes back
with no types at all, as if nothing were pasted. Plain text, through both channels, works exactly as a browser's
would. So the gap is specifically WebKitGTK never turning a local file or a clipboard image into a `File` — not a
Tauri setting away from working, as the first pass through this assumed.

**The fix, in two parts, neither of them new UI:**

* **Drag-and-drop:** Tauri's own drag-drop handler (the thing `.disable_drag_drop_handler()` would turn off) is kept
  **on**, because it is the only place on this platform a dropped file's real path is available at all — WebKitGTK
  never hands it to the page directly. `native_drag_drop` (`shell.rs`) reads each dropped path in Rust (at most 8
  files, 15 MB each — the rest are silently skipped, never an error), base64-encodes them, and calls into the page
  (`window.__navviedDrop`, defined unconditionally by the init script) with the file bytes and the drop position.
  That function reconstructs real `File` objects and dispatches an ordinary, bubbling `drop` `DragEvent` (preceded by
  synthetic `dragenter`/`dragover`/`dragleave` for the composer's own hover highlight) at the element under the
  pointer — indistinguishable, from the page's side, from a real browser drop. `packages/web/src/composer.ts` needed
  no change at all.
* **Paste:** a new command, `clipboard_image` (loopback-page only, like the relay commands), reads the system
  clipboard's image with `arboard` and re-encodes it to PNG with `image`, answering `null` when there is none (never
  an error, so a plain-text paste — already working on its own — is never slowed down). This one **does** need a
  one-line call from the page's side: `packages/web/src/composer.ts`'s `paste` handler, finding `clipboardData.files`
  empty, should call `window.__TAURI_INTERNALS__.invoke("clipboard_image")` as a fallback and, if it answers
  something, build a `File` from the returned base64 `data`/`mime` and call `addFiles` with it exactly as a real
  pasted file would.
* **The "+" dialog** needed no change: an `<input type="file">` opening the OS's own file picker is ordinary browser
  behavior in every one of Tauri's three webviews.

**A scaled display (2x on macOS, 150%/200% on Windows):** `DragDropEvent`'s position is typed `PhysicalPosition`
everywhere Tauri exposes it, but reading wry's own source per platform shows that is only true on one of the three.
On Windows (`wry::webview2::drag_drop`) it is a Win32 screen point run through `ScreenToClient`, a coordinate-system
shift with no DPI conversion — genuinely physical, needing `to_logical(scale_factor)` before it means anything to
`document.elementFromPoint`, which wants CSS pixels. On Linux it is GTK's own `drag-motion` signal's `x, y`, already
in GDK's device-independent units; on macOS, AppKit's `draggingLocation`, already in points — both already equal to
CSS pixels. Converting those two a second time is exactly the bug this document's first pass over this feature had:
reproduced here, under `GDK_SCALE=2`, a drop aimed at logical `(685, 600)` landed, converted, at `(342.5, 300)` —
half of half, the signature of dividing by the scale factor one time too many. Fixed with `#[cfg(windows)]` gating
`to_logical`'s use to the one platform it is correct on; the same drop, rebuilt, landed at exactly `(685, 600)`.

**Verified end to end, against the real app connected to a mock model, under a virtual screen, reading the actual
request the mock model received — not just that a chip appeared:**
* **A real drag.** A small GTK window built for this test, offering `text/uri-list`, `x-special/gnome-copied-files`
  and `image/png` together (WebKitGTK chose `text/uri-list`, same as a real file manager's drag would be free to),
  driven by real mouse motion (press, move, release) onto the real composer: the dropped PNG appeared as a real chip,
  was sent, and the mock model's own HTTP server logged the request with `{"type":"image_url","image_url":{"url":
  "data:image/png;base64,..."}}` carrying the exact bytes dropped.
* **Paste, both the part already working and the new fallback.** A real GTK clipboard holding plain text, pasted
  with a real Ctrl+V, appeared in the input and was sent, logged by the mock model with that exact text — proving
  `enable_clipboard_access()` end to end. The new `clipboard_image` command, invoked the same way the page would
  invoke it, read a real image set on the system clipboard and returned the identical PNG bytes (decoded and
  compared byte for byte against the original); invoked again with only text on the clipboard, it answered `null`
  with no error.

**The scaled-display fix, verified on the position math itself, not re-run through the whole composer:** under
`GDK_SCALE=2` on this virtual screen, a real XDND drag landing at logical `(685, 600)` was captured, wrapped, and
confirmed exact — before the fix, `(342.5, 300)`; after, `(685, 600)`, file still attached. Re-running the full
drop-to-chip-to-mock-request proof under that same `GDK_SCALE=2`, though, hit something unrelated: the app never
gets past "Starting navvied…" there at all — `running()` (`shell.rs`) is reached and does its work up to and
including `refresh_tray`, but the very next call, `app.get_webview_window("main")` or the `w.url()` right after it,
never returns. That is a stall on the GTK main thread under `GDK_SCALE` inside `Xvfb` specifically (plain text paste
and a plain drag both work fine on `starting.html`, which loads normally under the same scale — only the
*navigation* to the real page, which needs that same cross-thread call, never completes), present before this
branch touched anything and unrelated to the position fix. Flagging it rather than chasing it further here.

**Not yet done:** the one-line `composer.ts` call described above — this crosses into the web lane, so it is
written up here rather than changed directly; everything Rust owns is built, tested, and proven with real bytes
reaching a real request.

## Packaging

| System | Output | Notes |
|---|---|---|
| macOS | `.dmg` for arm64 and for x64 (two builds, not a universal binary, so each download is about 45 MB) | Signed with a Developer ID, hardened runtime, notarised and stapled. The compiled `navvied` needs the JIT entitlements `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory`; **to be proven on a real Mac**. |
| Windows | NSIS installer, x64, per user (no administrator rights) | Embeds the WebView2 bootstrapper so it also works offline on Windows 10. ARM PCs run it through emulation, as the CLI already does. |
| Linux | AppImage and `.deb`, x64 (arm64 later) | The `.deb` depends on `libwebkit2gtk-4.1-0` and `libayatana-appindicator3-1`; the AppImage carries them. Stock GNOME needs the AppIndicator extension for a tray icon (preview 12 says so). |

The program inside each installer is compiled on the same runner as the app (`bun build --compile`) and named the way Tauri expects (`navvied-<rust target triple>`). The workflow is `.github/workflows/desktop.yml`: tests on the three systems, the real window on a virtual screen (Linux), one installer job per system, and on a tag `v*` a `publish` job that attaches the installers and `SHA256SUMS-desktop` to the release that carries the command-line binaries. Installers are named `navvied-desktop-<version>-<system>.<ext>`.

Updates: the Tauri updater with its own key pair (an ed25519 key made once with `tauri signer generate`; free). It reads a `latest.json` that the workflow attaches to the GitHub release. This key is separate from the Apple and Windows certificates.

### Accounts and money needed (nothing has been bought or registered)

| Need | Cost, as far as known | Without it |
|---|---|---|
| **Apple Developer Program** (an Apple ID, then enrolment as a person or an organisation; an organisation also needs a D-U-N-S number) | 99 USD per year | The `.dmg` opens only after the person overrides Gatekeeper in System Settings. Not acceptable for beginners. |
| **Windows code-signing** | A certificate from a certificate authority (roughly 200 to 600 USD per year, an extended-validation one costs more and removes SmartScreen warnings at once), or Microsoft's Azure Trusted Signing (about 10 USD per month; its eligibility rules for the publisher's country and entity type must be checked before relying on it) | SmartScreen shows "unknown publisher" and many people stop there. |
| **GitHub secrets** | Free | n/a |
| The updater key | Free, made once by the maintainers | No updates. |
| Linux | Nothing; an optional GPG key to sign the `.deb` repository later | n/a |

**What the workflow reads once the accounts exist.** Nothing is read today: with no secret set, every installer is built unsigned (macOS gets an ad-hoc signature, which Apple silicon needs to start a program at all). Each name below is a GitHub repository secret; the build step already refers to them.

| Secret | What it is | Used for |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | The name of the Developer ID Application certificate, for example `Developer ID Application: Name (TEAMID)` | Signs the app and the program inside it. Without it the workflow passes `-` (ad-hoc). |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | The certificate exported as a `.p12` file, as base64, and its password | Lets the runner use the certificate. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | The Apple ID, an app-specific password made for it, and the team id | Notarisation, so macOS opens the app without a warning. |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | The code-signing certificate as base64 `.pfx` and its password | Signs the installer and the app, so SmartScreen warns less. |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key made by `cargo tauri signer generate` | Signs updates. `.github/workflows/desktop.yml` already checks for this one and switches the build to `--features updater` with update signing on when it is there — nothing else to wire up once it exists. |

Adding the signing steps themselves (importing the certificate into a keychain on macOS, pointing Tauri's `signCommand` at the Windows certificate) is a small change to the installer job once the first certificate exists; it cannot be tested before that.

### Turning auto-update on: what you do, once

Everything the code needs is already built and tested (see "Test plan" below) against a keypair generated inside
the test itself — never a real one. Turning the real thing on is two steps, both yours to do, both needing
something only you can provide: a password to protect the key, and write access to this repository's own
Actions secrets.

1. **Make the key, once, on your own computer** (needs `cargo install tauri-cli --version "^2" --locked` first, if not already installed):
   ```bash
   cargo tauri signer generate -w ~/navvied-updater.key
   ```
   This prints two things and writes the private half to `~/navvied-updater.key` (keep that file **and its
   password** somewhere safe — losing it means every future release has to ship a *new* key, and every copy of
   the app signed with the old one can never verify a signature again until it is reinstalled with the new key
   already built in):
   - **Public key** — paste this over the placeholder in
     [`packages/desktop/src-tauri/tauri.conf.json`](../packages/desktop/src-tauri/tauri.conf.json)'s
     `plugins.updater.pubkey` (an ordinary commit like any other change; the public key is not a secret — it is
     what every copy of the app ships with, to check updates *against*).
   - **Private key** — this is the secret. Do not commit it anywhere.
2. **Put the private half where the release workflow can reach it.** Settings → Secrets and variables → Actions
   → New repository secret:
   - `TAURI_SIGNING_PRIVATE_KEY` — the contents of `~/navvied-updater.key` (the whole file, exactly as written).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password chosen in step 1.

Once both are set and the next tagged release runs, `desktop.yml`'s `bundle` job signs the installer (or, for
macOS, a separate `.app.tar.gz` next to the `.dmg` — see the workflow's own comment on why) and the `publish` job
assembles `latest.json` from the `.sig` files that run produced
(`packages/desktop/scripts/assemble-update-manifest.ts`), attaching it to the release alongside the installers.
Nothing changes in the workflow itself for this to start working — it already checks for the secret every run and
builds unsigned, exactly as before, for as long as it is absent. If the secret is set but `tauri.conf.json`'s
`pubkey` is still the placeholder, the `bundle` job fails loudly instead of quietly shipping a signed release
that every copy of the app refuses to update from (see the workflow's own check for this).

**What happens before this is done, what happens if it ever goes wrong:** every build is unsigned and
`check_update()` is compiled out entirely (`#[cfg(feature = "updater")]` — the app never even asks); nothing
regresses, nothing nags. Once it is on: a release with no network reachable, or whose check genuinely finds
nothing newer, both end the same way today already does, quietly (`check_update()`'s `Err` branch logs once and
tries again in six hours; `Ok(None)` does nothing at all) — no card, no retry storm. A release that answers but
whose signature does not check out, or whose download is interrupted, surfaces as a refusal card
(`cards::update_refused`) rather than silently installing or crashing; this and the "an update is ready" moment
are also emitted as `app.emit("update-available", {current, version})`, so a web card can listen for the same
moment this document's native fallback card already reacts to, without this file changing again when such a
card replaces it.

What a person sees without signing, and how to open the app anyway, is written for them in [INSTALL.md](INSTALL.md#the-desktop-app).

## The browser app (PWA) from the desktop

The web UI already has a manifest and a service worker. Installing it from Chrome, Edge or Safari gives a window and a dock icon with no download (previews 36 to 38). It has **no engine inside**: it connects to a navvied on another computer, to the relay or to the hosted service. So it is the lighter choice for a person who already runs navvied somewhere, and the desktop app is the choice for a person who has nothing yet. The download page (30) offers the app first and the browser version second. Install is always the person's own click; the page never nags.

## What is built, and where it differs from the previews

Built and tested (`cargo test -p navvied-desktop-core`, 60 tests, with the real compiled `navvied` when `NAVVIED_BIN` is set): the key, the log filter, the ready line, the loopback HTTP and WebSocket clients, the supervisor (start, crash restart with 0.5, 1 and 2 second pauses, the third crash in a minute gives up, folder change, try again, usual port with fallback, stop ends the whole tree, the app being killed ends the program), the notice and tray logic, the link and drop parser, and the settings file. A test that was made to fail on purpose (log filter off, tree kill off) did fail.

Also built and tested, against a keypair generated inside the test itself, never a real one (`cargo test -p navvied-desktop --test updater_signature`, 4 tests, in CI as part of the `window` job — it needs no `updater` feature of its own, since it exercises the same two crates (`minisign`, `minisign-verify`) that signing and verifying use directly, not the compiled plugin): a correctly signed update is accepted, one signed by the wrong key is refused, a tampered artifact is refused even with the right key, and a hand-edited (malformed) signature field is refused rather than silently treated as absent.

Run for real on Linux under a virtual screen (`packages/desktop/scripts/window-check.sh`, 16 checks, in CI as the `window` job): the app starts the program, the key it runs with is a known test key, `401` without it and `200` with it, `403` for a foreign host, loopback only, the page is connected with the key, the key is in no log, setting, storage file, output, command line or window title (and the search is proven by planting a key), the program is started again after a crash on the same port with the same key, and the program goes when the app is killed. The app for this check is built with `--features test-hooks`, which is never part of a published build.

Written and compiled but not yet run on a person's screen or in CI: the Tauri window, tray, notices, dialogs, deep links, updates. These differ from the approved previews in these ways, each deliberate:

| Preview | What the app does instead | Why |
|---|---|---|
| 02, 03 connect a model | The page's own screen, until the model setup endpoints exist | Not in the engine yet (see above). |
| 09, 13 to 19, 20 to 22, 14 | Drawn by the app on top of the page (`shell-pages/overlay.js`) in the page's colours, not inside the page's own settings dialog | The page's bridge does not exist yet. The overlay is the same cards; when the page gets its own bridge the overlay can go. |
| 14 | The "keep the computer awake" switch is not there | Needs a different mechanism on each system; not built. A new switch "Show what the task is in notices and the menu" is there instead. |
| 15 | A finished task says "Your task is done. Open navvied to read the answer." with no count of changed files | The event stream carries no file contents or counts that are safe to show. |
| 15 | Clicking a notice does not open the conversation | The desktop notification plugin has no click callback (it exists on phones only), and a per-system one cannot be tested here. A click only brings the app forward where the system does that by itself: the window then shows the one conversation there is. |
| 25 | The second copy ends at once; the first window comes to the front and shows "navvied was already open" | A second copy cannot draw a dialog of its own. |
| 26 | Not possible as a window: without the WebKit library the app cannot draw anything | The `.deb` depends on it and the AppImage carries it. |
| 08 | Dropping a folder on the icon works on macOS and Windows (a folder given on the command line); on Linux only where the desktop passes the folder | A Linux launcher needs a folder association in its `.desktop` file; not set. |

### What CI has shown so far (GitHub, not a person's computer)

* Core tests pass on Linux, macOS and Windows (one fully green run so far; the Windows and macOS Intel installer jobs stay allowed to fail until a second one). The real window on a virtual screen passes all 16 key checks on Linux.
* The installers build: Linux `.deb` and `.AppImage` (about 186 MB zipped together, the AppImage carries the WebKit library), Windows `-setup.exe` (about 46 MB), macOS Intel `.dmg` (about 46 MB), and the macOS Apple silicon `.dmg`.
* **Nobody has installed or opened any installer on a real Mac or Windows computer yet.** The unsigned warning screens in INSTALL.md are described from how those systems behave, not seen on this project's files.
* The step that attaches the files to a release (`publish`) has never run, because it only runs for a tag.

## Test plan (runs in CI, no human)

Everything the app promises about the helper process is tested without a window wherever possible, so the build is verifiable on the three runners. Two helpers make that possible: a **fake sidecar** (a tiny program in the repository that prints the ready line, answers `/api/info`, and can be told to crash, to ignore a closed input, or to print a canary token on purpose) and a **canary token** (`NAVVIED_SERVE_TOKEN=CANARY-…`, a value that must never appear anywhere except where it is allowed).

The supervisor (port, token, start, restart, stop, log filter) lives in a Rust library crate `desktop-core` with no Tauri code in it, so `cargo test` covers it on macOS, Windows and Linux.

| # | What is proven | How | Where |
|---|---|---|---|
| 1 | **The sidecar contract.** `serve --http --port 0 --ready-line` prints exactly one `navvied-ready {"port":N}` line, N is the real port, and neither output stream contains the token. `/api/info` answers 401 without the token and 200 with it. A request with a foreign `Host` gets 403. The port cannot be reached through the machine's non-loopback address. | `bun test` spawning the real CLI | all 3 runners, as soon as the CLI flags exist |
| 2 | **Exit with the pipe.** Closing the sidecar's standard input ends it within 2 seconds, with a task running and without. `NAVVIED_NO_UPDATE=1` makes no network call (a local server counts requests). | `bun test` | all 3 |
| 3 | **Port.** The port used last time is reused when free; a taken one falls back to any free port; the port reported on the ready line is the one the page is sent to. | `cargo test`, a listener holds the port | all 3 |
| 4 | **Token.** 24 random bytes, base64url, never reused across launches, absent from the sidecar's command line (read from `/proc/<pid>/cmdline`, `ps -o args=` or `Get-CimInstance Win32_Process`). | `cargo test` with the fake sidecar | all 3 |
| 5 | **The token never appears in logs.** Run the whole suite with the canary. Then search every artifact: the app's log files, the captured sidecar output, crash reports, the window title, the loaded address, the WebDriver console log, the process list. The only allowed places are the sidecar's environment and the live socket. The fake sidecar prints the canary to its standard error on purpose, which proves the filter works. | `cargo test` plus a final grep step in the workflow | all 3 |
| 6 | **Start sequence.** Ready within the limit leads to "page loads"; a sidecar that never answers within 10 seconds leads to the "cannot start" state; a sidecar that exits at once leads to "blocked" (preview 24). | `cargo test`, fake clock | all 3 |
| 7 | **Crash restart.** Kill the sidecar with the strongest signal (`TerminateProcess` on Windows): a new one starts after 0.5 s, then 1 s, then 2 s; token unchanged; the new address reaches the window; the third crash within 60 seconds stops the restarts and raises "keeps stopping" (preview 22); a crash after 60 quiet seconds starts the count again. | `cargo test`, fake clock and fake sidecar | all 3 |
| 8 | **Quit kills it.** Quitting leaves no sidecar and no child of the sidecar (the fake one starts a grandchild, like a shell command would). Order: cancel, close the pipe, wait 3 seconds, kill the tree. Windows uses a job object, Linux a process group, macOS a process group. | `cargo test` | all 3 |
| 9 | **The shell dies, the sidecar goes too.** A harness program runs the supervisor, the test kills the harness with the strongest signal, and the sidecar must be gone within 3 seconds. | `cargo test` | all 3 |
| 10 | **A real task end to end.** The compiled `navvied` plus a scripted local model server (a few lines, speaks the chat API): connect over `/ws`, send a prompt, receive `text` and `done`; an `approval` event is answered; `cancel` stops a long reply. This is the same path the window uses. | `bun test` | all 3 |
| 11 | **Notices.** A scripted event stream (`approval`, then a `done` after a long turn) must produce exactly the two notices of preview 15 through a fake notifier, and none for a short turn; with the details setting off, the text carries no path or file name. | `cargo test` | all 3 |
| 12 | **The window.** Start the real app under a virtual display with `tauri-driver` (WebDriver): the page loads from the loopback address; the address has no token; `sessionStorage` holds `navvied.target`; navigating to another site is refused; an external link goes to the (fake) system opener; the response carries the content security policy; the page cannot call any native command except the three allowed. | `tauri-driver` + xvfb | Linux and Windows |
| 13 | **The same on macOS.** WebDriver does not exist for the macOS web view, so a build with the `test-hooks` feature (never in a release build, checked by a test on the shipped binary's feature list) prints a status line the test reads: address, storage key present, navigation refused. Fewer checks than 12, said openly. | `cargo test --features test-hooks` | macOS |
| 14 | **Permissions as data.** The capability files are parsed: the only remote origin is the loopback pattern and the command list equals the allowed three. Adding a command fails the test until it is reviewed. The shell pages' content security policy is compared with the expected text. | `cargo test` | any one runner |
| 15 | **Updater.** A local static server offers `latest.json`: a correct signature is accepted; a changed file, a wrong key and a replayed older version are refused with preview 19, and nothing is replaced. | `cargo test` with a throw-away key | all 3 |
| 16 | **The built artifacts.** After the real build: the `.deb` installs in a clean container and starts; the AppImage runs with `--appimage-extract-and-run`; the NSIS installer runs silently (`/S`) as an ordinary user and starts; the `.dmg` mounts, `codesign --verify --deep --strict` and `spctl --assess` pass, and the notarisation ticket is stapled (`xcrun stapler validate`). Each one then runs steps 5 and 8 from the installed location. | workflow, after the build | all 3 (signature checks only when the secrets exist) |

Not covered by any automatic test, so it stays on a short manual list before each release: how the notices and the tray icon look on each system, dropping a folder on the Dock or the taskbar, what Gatekeeper and SmartScreen say to a first-time downloader, a tray icon on stock GNOME, and a dark/light theme switch while the app is open.

Order of work when building is approved: the CLI flags with test 1, 2 and 10 first (they need no Rust at all and can be merged on their own), then `desktop-core` with tests 3 to 9 and 11, then the window with 12 to 14, then the updater and packaging with 15 and 16.

## Preview index

`preview/index.html` lists every state in order, dark and light, per system where the system matters (01 first launch, 02 and 03 connect a model, 04 and 05 chat, 06 to 09 project folder, 10 to 12 menu bar and tray, 13 close behaviour, 14 settings, 15 notices, 16 deep link, 17 to 19 updates, 20 to 22 engine crash, 23 to 27 cannot start and starting, 30 to 35 download and installers, 36 to 38 browser install).

# geneWeave Desktop

A **Tauri v2** desktop shell around the geneWeave **web build** — so the desktop app *is* the web app
in a native window, with no second UI to maintain. It adds the desktop-only pieces:

- **Global quick-capture hotkey** — `Cmd/Ctrl+Shift+K` from *any* app pops the quick-capture box to jot
  a note (the same box the web UI shows in-browser). Built on `tauri-plugin-global-shortcut`.
- **Offline cache + "open to last note"** — the app launches with no network and reopens the note you
  last had open. This lives in the **web layer** (a `localStorage` snapshot via `@weaveintel/notes`'
  shared desktop model), so it works in the webview unchanged — and is unit- + Playwright-tested.
- **Native menu + single-instance** — a real app menu (incl. Quick Capture); launching twice focuses
  the existing window.
- **Signed auto-update** — `tauri-plugin-updater` pings a signed `latest.json` and installs in the
  background. User data lives in `appConfigDir`, so updates never clobber your settings.

## How it fits

```
clients/desktop/
  package.json              Tauri CLI + JS plugin deps (needs the Rust toolchain to build)
  src-tauri/
    tauri.conf.json         window + updater config; the webview points at the geneWeave server
    Cargo.toml              Rust deps (tauri, global-shortcut, updater, single-instance)
    src/main.rs             registers the global hotkey → emits a `quick-capture` event to the web UI
    capabilities/default.json   the permissions the shell uses
```

The webview loads the geneWeave web app from its server (`http://localhost:3500` in dev; your deployed
host in production). Everything else — notes, the editor, ink, quick-capture, the offline cache — is the
**same `apps/geneweave-ui` build** the browser uses. The shell just gives it an OS window, a global
hotkey, a menu, and updates.

## Capability governance

The desktop capabilities are governed in **weaveNotes Settings** (the Builder admin), like every other
weaveNotes capability:

- `desktop_offline_enabled` — cache notes locally + reopen the last note offline,
- `quick_capture_enabled` — the global quick-capture hotkey,
- `desktop_offline_note_limit` — how many notes to cache locally.

The web app reads `GET /api/me/notes/capabilities` to honour them. A note captured or edited in the
desktop shell is stamped **"on desktop"** in the note's activity log (via `X-Client-Version`), so the
assistant's `read_note_activity` tool understands where a note was changed — and the new **`recent_notes`**
tool lets it answer "what was I just working on?".

## Build (requires Rust + the Tauri CLI — not part of the headless TS workspace)

```bash
# one-time: install Rust (https://rustup.rs) and the Tauri CLI
cd clients/desktop
npm install
# run against a local geneWeave dev server (http://localhost:3500)
npm run dev
# produce signed installers (.dmg / .msi / .AppImage) with auto-update artifacts
npm run build
```

> The Rust/native build is intentionally **out of the headless CI graph** — the testable logic
> (quick-capture parsing, recents/last-note, the offline snapshot) lives in `@weaveintel/notes` and the
> web behaviours are covered by the geneWeave Playwright suite. The Rust shell is validated on a desktop
> dev machine.

## Auto-update signing

Generate an updater key pair once and keep the **private** key secret (CI signs releases with it):

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/geneweave-updater.key
# put the PUBLIC key in src-tauri/tauri.conf.json → plugins.updater.pubkey
```

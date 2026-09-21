# Obsidian automation: what we can and can't run ourselves

**Date:** 2026-09-19
**Context:** We wanted to launch Obsidian, enable our dev plugin, fire the `obsidian://review-md`
protocol, and screenshot — all from the shell, without touching the user's real config or doing
manual GUI steps. This records exactly where the automation ceiling is, so we don't re-explore it.

## What works headlessly (verified empirically)

- **Isolated config via `--user-data-dir`.** Launching
  `/Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=<scratch>` relocates the
  *global* Obsidian state (vault registry, caches, window state) into `<scratch>` and does **not**
  touch `~/Library/Application Support/obsidian`. Confirmed: the isolated dir got all Electron
  state; the default dir was never created. This is the Obsidian Portable mechanism.
- **Pre-seeding the vault registry.** Writing `<scratch>/obsidian.json` = 
  `{"vaults":{"<16-hex-id>":{"path":"<abs vault path>","ts":<ms>,"open":true}}}` **before launch**
  auto-opens the vault with no "Open folder as vault" GUI step. The id is any random 16-hex string
  (`openssl rand -hex 8`); it is not derived from the path. Must be written **before** launch —
  Obsidian only reads the registry at startup (writing it while running gives "vault not
  registered"). Confirmed: our `.dev-vault` opened directly on relaunch.
- **`screencapture -x -o out.png`** works (Screen Recording permission is granted to the terminal).
- **Custom `obsidian://review-md` protocol** fires via `open '...'` while the app runs (standard,
  documented). Not yet exercised end-to-end because the plugin can't load until it's trusted (below).

## The one gate we cannot cross from the shell

**The "Do you trust the author of this vault?" dialog.** On first open of a vault that ships
plugins, Obsidian shows a modal with *Browse vault in Restricted Mode* / *Trust author and enable
plugins*. Until "Trust author…" is clicked, **no community plugin loads**, so our plugin's protocol
handler and POC-4 command don't exist yet.

Verified there is **no file-only bypass** (matches a working e2e reference vault,
`qawatake/obsidian-e2e-sample`):
- `.obsidian/app.json` is `{}` in a trusted, plugin-enabled vault — Restricted Mode is **not** a key
  there. The pre-1.0 `safeMode` key no longer exists.
- Pre-writing `.obsidian/community-plugins.json = ["review-md"]` *lists* the plugin as "should be
  enabled" but the trust modal still fires on first launch. (Our vault has exactly this file and the
  dialog still appeared.)
- Trust state persists in the **`--user-data-dir`**, not in the vault's `.obsidian`. So once blessed,
  a snapshot of that dir is reusable for click-free runs.

**Why our automated click failed:** `osascript`/System Events `click` needs macOS **Accessibility**
permission for the invoking terminal. It isn't granted, so the synthetic click hangs and returns
`AppleEvent timed out (-1712)`. We cannot grant Accessibility (or the CLI toggle) programmatically —
both are GUI/TCC-gated.

## The clean path (chosen)

**One-time GUI blessing, then full automation.** A human clicks *Trust author and enable plugins*
once (and, ideally, enables **Settings → General → Advanced → Command line interface**). After that:
- The isolated `--user-data-dir` is trusted forever — snapshot it and reuse for click-free relaunch.
- Obsidian 1.13.7 ships an official CLI at `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`
  (`/usr/local/bin/obsidian` once enabled). It gives `plugin:enable`, `plugin:reload`, `eval`,
  `dev:screenshot` (in-process capture — no Screen Recording permission needed), `devtools`. That is
  our downstream automation surface: drive POCs with `eval`, capture with `dev:screenshot`.

So the loop is **manual once, automated thereafter** — not manual every run. The alternative
(Playwright launching the unpacked Electron `app.asar`, clicking the trust button deterministically
in CI) is the heavier route we'd only take if we needed DOM assertions in CI.

## Implication for the plan

This does **not** change the host decision (Obsidian plugin stays preferred). It only means the POC
"go/no-go" runs need a one-time trust click to light up the plugin; the data-model half of POC-4
already passed headlessly, and POC-1's handler is built and self-reporting. After the blessing, both
verify without further manual steps.

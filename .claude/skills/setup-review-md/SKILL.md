---
name: setup-review-md
description: >-
  Check, install and prove the review-md Obsidian plugin in a vault the way users get it —
  through BRAT from the published GitHub release. Use when asked to "set up review-md",
  "install review-md", "is review-md installed", "install via BRAT", "check the plugin
  works", or to smoke-test a release in a clean vault. Runs scripts/setup-vault.mjs
  check → install → verify against the live app via obsidian-cli, with a panel screenshot.
---

# setup-review-md — check, install via BRAT, verify it works

One tool, three steps, each a single command (`scripts/setup-vault.mjs`, or the `make`
targets that wrap it). The tool never copies our local build: review-md always comes from
the GitHub release, through BRAT, like a beta tester gets it.

## When this fires

"set up review-md in my vault", "install review-md", "is review-md installed?", "install it
via BRAT", "check the plugin works", "prove the release installs in a clean vault".

## The flow

```sh
make setup-check   VAULT=/abs/path/to/vault   # read-only; exits 1 and lists what's missing
make setup-install VAULT=/abs/path/to/vault   # idempotent; BRAT, then review-md via BRAT
make setup-verify  VAULT=<vault name>         # live PASS/FAIL, exit 1 on any FAIL
make setup-check   VAULT=/abs/path/to/vault   # again: every row OK
```

Extra flags (call the script directly):

- `check --user-data-dir <dir>` — look for the vault registration in an isolated
  harness's `obsidian.json` instead of `~/Library/Application Support/obsidian`.
- `install --token-name <name>` — only for a private repo or fork (`omars-lab/review-md`
  is public, so testers don't need it). Stores
  `gh auth token` in Obsidian's secret storage under `<name>` (`[a-z0-9-]+`) and tells BRAT
  to use it. Without it BRAT gets a 404 and install stops with that hint.
  Make form: `make setup-install VAULT=… TOKEN_NAME=github-review-md`.
- `verify --screenshot <png>` — capture the panel mid-round-trip. **Read the PNG.** A DOM
  check once passed while the capture showed an empty panel (a stale frame); the picture is
  the final word.
- `verify --keep` — leave the scratch doc + sidecar in place to inspect.

What each step does, and the BRAT/Obsidian internals it leans on, is in the header comment
of `scripts/setup-vault.mjs`. The why behind the design: `docs/issues/setup-via-brat.md`.

## Before you start (once per app instance)

1. **The vault is open** in Obsidian, and **Settings → General → Command line interface is
   on**. `install` and `verify` fail fast with that hint if the CLI doesn't answer.
   For an isolated harness, `"cli": true` in `<user-data-dir>/obsidian.json` turns it on
   before launch, so there's no click.
2. **Only one Obsidian owns the CLI.** Every instance listens on the same
   `~/.obsidian-cli.sock`, and the last one launched takes it. When a harness instance runs
   next to your everyday Obsidian, the CLI talks to whichever started last.
3. **Isolated harness** (to test without touching your real config):
   write `<udd>/obsidian.json` = `{"cli":true,"vaults":{"<16 hex>":{"path":"<abs>","ts":<ms>,"open":true}}}`,
   then `open -na /Applications/Obsidian.app --args --user-data-dir=<udd>`. The registry is
   read only at startup: to switch vaults, edit it, quit that instance (by pid), relaunch.

## Manual GUI steps (only when the headless path can't reach them)

`install` turns restricted mode off with `app.plugins.setEnable(true)`, which also means the
**"Trust author and enable plugins"** dialog never appears for a vault set up this way. It
*does* appear when Obsidian starts on a vault that already has plugins and has never been
trusted in this user-data-dir (e.g. relaunching a harness on `docs/`). The dialog blocks the
CLI (every eval hangs), so clear it by hand:

1. `osascript -e 'tell application "Obsidian" to activate'`
2. `screencapture -o -x <shot.png>` and **read it**. Find the button.
3. Convert to screen points: `pt = shown_px × (screen_pts_wide / shown_width)`, e.g. ×0.756
   for a 2000-px-wide view of a 1512-pt display.
4. `/opt/homebrew/bin/cliclick c:X,Y`, then **screenshot again** to confirm it closed.
   The buttons are web content, not native controls, so AppleScript `click button` fails.
   A one-time macOS "X wants to control Y" prompt can cover the target: dismiss it first.
5. If a plain OK-style modal is stuck, Return works:
   `osascript -e 'tell application "System Events" to key code 36'`.

Turning the CLI on by hand, if `obsidian.json` can't be edited: Settings (⌘,) → General →
Advanced → Command line interface. Same screenshot → click → screenshot discipline.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `Command line interface is not enabled` | The instance that owns the socket has CLI off. Turn it on, or relaunch the intended instance last. |
| `Vault not found.` | The vault name isn't registered in *that* instance's `obsidian.json`. Register it, then relaunch. |
| BRAT `validateRepository … 404` | The repo is private (or the name is wrong). Use `--token-name`. |
| every eval hangs to the 30 s timeout | A modal is open (trust dialog, error). Clear it as above. |
| `review-md is latest` MISSING | The vault has an older build. BRAT: "Check for updates", or `install` after removing the plugin. |
| verify screenshot blank | The window was in the background (rendering pauses). `verify` activates Obsidian first. Check nothing covers the window. |

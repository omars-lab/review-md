# Setting up review-md through BRAT, and proving it works

**Status:** done 2026-09-25 (`scripts/setup-vault.mjs`, skill `setup-review-md`).

## What we wanted

A way to check whether review-md is installed in a vault, install it if not, and prove it
works, all the way a beta tester gets it: BRAT pulling the published GitHub release, never
our local build. It also had to prove the 0.1.0 release installs in a clean vault.

## What we expected vs. what happened

**Expected:** BRAT would need clicking. Its "Add a beta plugin" is a modal, and a fresh
vault shows the "Trust author and enable plugins" dialog. The plan B was driving both with
obsidian-cli plus cliclick.

**Found:** everything runs from the shell, with no clicks:

- **Restricted mode** is a localStorage flag (`enable-plugin-<appId>`) behind
  `app.plugins.isEnabled()` / `setEnable(true)`. The trust dialog only opens at startup when
  plugins exist and that flag was never set. Turning it on programmatically in a vault with
  no plugins yet means the dialog never appears.
- **BRAT's add path** is a plain method:
  `app.plugins.plugins["obsidian42-brat"].betaPlugins.addPlugin(repo, false, false, false, "", false, true, tokenName)`.
  This is the call the modal makes. It downloads the release, writes the files, adds the
  repo to `data.json` `pluginList`, and enables the plugin. Read from BRAT 2.2.0's bundled
  `main.js`; recheck it when BRAT changes.
- **The CLI switch** is `"cli": true` in the instance's `obsidian.json`, so a harness can be
  launched with it already on.

**Surprise 1, the repo is private.** `omars-lab/review-md` is private, so both the public
GitHub API and BRAT get a **404**. The release exists, but nobody without repo access can
install it. We added `install --token-name <name>`. It puts `gh auth token` into Obsidian's
secret storage, passing it through a 0600 temp file (never argv or the log), and hands BRAT
the name. BRAT records only the name (`pluginSubListFrozenVersion[].tokenName`), so updates
keep working. `check` reads the latest release through `gh` first, for the same reason.
**Beta testers will need either the repo made public or a GitHub token with repo access.**
That call is Omar's.

**Surprise 2, one CLI socket for all instances.** Every Obsidian listens on
`~/.obsidian-cli.sock`, and each new instance unlinks it and binds its own. With a harness
running next to the everyday app, the CLI reaches whichever launched last. Obsidian doesn't
key the socket per user-data-dir, so we just document it.

**Surprise 3, a PASS over an empty picture.** The first verify run passed "thread in panel",
but the screenshot taken right after showed "No comment threads yet": the capture got the
frame from before the refresh. Now the panel check requires the card to be *visible*
(`offsetParent`), and the screenshot waits for a paint. That confirmed the looked-at-it rule
again. The next run showed a leftover thread from a `--keep` run, so the create step now
clears any old scratch sidecar too.

## Result (fresh vault, isolated harness, Obsidian 1.13.7, BRAT 2.2.0)

- `check` → 7 missing
- `install` without a token → BRAT 404
- `install --token-name` → review-md 0.1.0 via BRAT
- `verify` → 8/8 PASS; screenshot read: one header thread, "1 open"
- `check` → all OK, including "installed 0.1.0, latest release 0.1.0" and BRAT tracking the repo
- a second `install` → no-op

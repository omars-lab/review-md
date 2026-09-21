---
name: demo-media
description: >-
  Capture feature screenshots and animated GIFs of the review-md Obsidian plugin
  to market it and fill a user-friendly README. Use when asked to screenshot the
  UX/features, record a demo GIF, refresh the README images or marketing assets,
  or show the plugin in action. Drives the built plugin in .dev-vault two ways —
  a manual path (Obsidian command IDs) and an x-callback path (obsidian://review-md-*
  deep links) — via scripts/capture-media.mjs, then stitches GIFs with gifski.
---

# demo-media — capture screenshots & GIFs of review-md

Produce the marketing/README media for this plugin: one crisp, cropped PNG per
feature and a few short GIFs of the interactions. Everything is driven from the
repo through `scripts/capture-media.mjs` against the live plugin in `.dev-vault`,
so a capture is one small, repeatable command — never an ad-hoc heredoc.

The concrete per-feature capture list is the rubric in
[`shot-list.md`](shot-list.md) next to this file. **Read it at run time** and work
it top to bottom; edit it (not this file) when the feature set changes.

## When this fires

"screenshot the features", "add UX screenshots to the README", "make a demo GIF",
"record the plugin in action", "refresh the marketing assets / README images".

## 0. Prerequisites (once per session)

```
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"   # repo pins Node 22 (.nvmrc)
node scripts/capture-media.mjs doctor        # obsidian-cli + gifski/ffmpeg/magick + built plugin
npm run build && npm run install:dev         # only if doctor flags the plugin as stale/missing
node scripts/capture-media.mjs reload        # load the freshly-built bundle into the vault
```

`doctor` must be all-`ok` before capturing. Obsidian must be **running with
`.dev-vault` open** (the harness talks to the live app). Final assets land in
`docs/media/` — that directory **is committed** (README images have to ship in the
repo to render on GitHub); the `.dev-vault/` staging copy stays gitignored.

## 1. The tool — one subcommand per primitive

`scripts/capture-media.mjs <sub> [flags]` (full flag list in the file header):

| subcommand | what it does |
|---|---|
| `doctor` | check obsidian-cli, gif tools, and the built plugin |
| `reload` | reload the review-md plugin in the vault |
| `cmd --id <command-id>` | run an Obsidian command — the **manual** path |
| `eval --code <js>` / `--file <f>` | run JS in the renderer (set up state, click, assert) |
| `open --file <f> [--thread <t>]` | fire `obsidian://review-md-open` — the **x-callback** path |
| `reply --file <f> --thread <t> --body <b> [--author <a>]` | fire `obsidian://review-md-reply` |
| `shot --out <png> [--selector <css>] [--pad <n>] [--settle <ms>]` | screenshot, cropped to a selector's box when given |
| `frames --dir <d> --name <p> --count <n> [--interval <ms>] [--selector <css>]` | burst of frames for a time-lapse GIF |
| `gif --frames <dir> --out <gif> [--fps <n>] [--width <n>]` | stitch PNG frames into a GIF via gifski |

`shot` without `--selector` captures the whole window; **with** `--selector` it
crops to that element's bounding box (Retina-correct, `--pad` adds breathing room).
Prefer a tight selector so README images are focused, not full-screen. Use
`--settle` to let renders/animations finish before the shot.

## 2. Two capture paths (capture every feature both ways where it applies)

The user asked for **both**. Each shot in the rubric names its manual and its
x-callback recipe; do the one that fits the feature, and for share/deep-link
features do both so the README can show the link workflow.

**Manual path** — drive the UI with command IDs and `eval`:

```
node scripts/capture-media.mjs cmd  --id review-md:open-comments-view
node scripts/capture-media.mjs cmd  --id review-md:toggle-comment-mode
node scripts/capture-media.mjs shot --out docs/media/sidebar.png \
     --selector '.workspace-leaf-content[data-type="review-md-comments"]' --pad 6 --settle 400
```

**x-callback path** — drive it with deep links (this is also the feature demo for
"share / reply by link"):

```
node scripts/capture-media.mjs open  --file design.md --thread d1a2b3
node scripts/capture-media.mjs shot  --out docs/media/deep-link-open.png \
     --selector '.workspace-leaf-content[data-type="review-md-comments"]' --pad 6 --settle 600
node scripts/capture-media.mjs reply --file design.md --thread d1a2b3 --body "looks good" --author omar
```

The `open`/`reply` links are the real `obsidian://review-md-*` API (see
`docs/api/xcallback.md`); firing them in the demo doubles as an end-to-end check
that the protocol handler still works.

## 3. GIFs — tools are already installed, no new dependency

`ffmpeg` and `magick` are present, so nothing new to install (that was the open
question). `gif` prefers `gifski` and **falls back to ffmpeg** automatically — on
this machine gifski is linked against a mismatched ffmpeg and aborts, so the tool
uses the ffmpeg palettegen/paletteuse path (clean colours, arbitrary frame names).
Two GIF shapes:

- **Scripted interaction** (preferred for feature demos): capture a frame, take an
  action, capture the next frame, repeat, then stitch. Write frames as
  `docs/media/frames/<name>/<name>-000.png`, `-001.png`, … (zero-padded so they
  sort), then:
  ```
  node scripts/capture-media.mjs shot --out docs/media/frames/comment/comment-000.png --selector '<sel>'
  node scripts/capture-media.mjs cmd  --id review-md:toggle-comment-mode
  node scripts/capture-media.mjs shot --out docs/media/frames/comment/comment-001.png --selector '<sel>'
  # …more action/shot pairs…
  node scripts/capture-media.mjs gif  --frames docs/media/frames/comment --out docs/media/comment.gif --fps 8 --width 900
  ```
- **Time-lapse** (for a spinner/animation): `frames --count N --interval MS` grabs a
  burst automatically, then `gif` stitches it.

Keep GIFs small: crop with `--selector`, cap `--width` (~900), use a low `--fps`
(6–12). The `frames/` subtree is intermediate — gitignore it and commit only the
final `.gif` (see §5).

## 4. Determinism tips

- **Reload before a run** so you capture the current build.
- **Crop, don't full-screen** — a selector box is stable across window sizes; the
  whole window is not.
- **Settle** after any command that re-renders (`--settle 300`–`600`).
- Set up state explicitly with `eval` (open a file, scroll a node into view,
  toggle a chip) rather than assuming the last session's state.
- Assert what you captured: read the PNG back and eyeball it — OCR/automation can
  silently miss the very thing the shot is meant to show (badge count, an
  "outdated" flag). Looking is the check.

## 5. Wire into the README + commit

Reference each asset from `README.md` with a relative path (`docs/media/<name>.png`).
Then, staging **by name** (never `git add -A`):

```
# .gitignore should carry:  docs/media/frames/    (intermediate frames only)
git add scripts/capture-media.mjs .claude/skills/demo-media README.md docs/media
git commit
```

Regenerating the whole set later is just re-running the rubric after `reload`.

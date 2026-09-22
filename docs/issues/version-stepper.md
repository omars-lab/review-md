# Version stepper replaces the Content Revisions accordion

## What changed

The per-card **Content Revisions** accordion (a collapsed `<details>` at the foot
of each comment card) is gone. In its place, the card's rev-stamp line is now an
inline **version stepper**:

```
‹  v6 (38238a7)  ›
```

- The centred label names the version (`revLabelFor`): `Working copy`, `v7 (b24cd88)`,
  or a bare slug when there's no v-number.
- The **left** chevron steps toward the **latest** version and is disabled once
  there; the **right** chevron steps toward **older** versions and is disabled at the
  oldest. (Left = newer, right = older — matches the "left button disabled on latest
  version" ask.)
- The stepper opens on the version the comment was **authored** against (that label
  is bold, `.is-authored`).
- Clicking the label toggles an inline preview of the anchored content **as it was in
  the selected version** — a rendered mini-diagram for a mermaid node/edge anchor,
  else a text snippet centred on the anchor quote. Cards stay compact until asked.

## Why

The accordion could only ever show **one** version — the authored one. The whole
point of stamping a comment to a revision is to ask "what did this look like then,
and how has it drifted?"; answering that meant browsing the file's history, which the
accordion couldn't do. The stepper turns the single reviewed-version peek into a walk
across every version in the file's git history (`fileRevisionOrdinals`), newest-first,
so a reviewer can step back through the anchored element commit by commit from one
control.

## How it's built

- **`fillVersionRows` is now async.** It fetches the file's version ladder once for
  the whole card batch (`fileRevisionOrdinals` → `Map<sha, vNumber>`), guards against
  the user switching files mid-await, then renders each card's row.
- **`renderVersionStepper(thread, slot, ordinals, outdated)`** builds the ordered
  version list (committed shas newest→oldest; `WORKING_REV` prepended only when the
  comment itself was authored on the working copy), finds the authored version's
  index, and wires the two chevrons + label. A `sync()` closure repaints the label,
  toggles the disabled ends, and — if the preview is open — reloads it for the newly
  selected version.
- **`showVersionPreview(...)`** fetches the body for a version via
  `plugin.bodyAtRevision(file, versionKey)` (cached per version so re-stepping is
  instant), then renders the mermaid preview or text snippet. A `box.dataset.want`
  guard drops a late fetch when the user has already stepped on.
- **`renderStaticStamp(...)`** preserves the old `on <sha>` / `working copy` stamp for
  threads with no navigable git ladder (unstamped fixtures, body-hash-only, or off a
  git work tree) — no regression for those.

## Refactor of the reviewed-body helpers

The stepper needs the body at an **arbitrary** revision, not just the thread's own
stamp, so the two old single-version helpers were generalised (and the now-dead
originals removed):

- `reviewedBodyFor(file, thread)` → **`bodyAtRevision(file, commit)`** — takes a bare
  revision key (a sha or `WORKING_REV`), applies no thread-specific outdated check,
  and keeps the rename-following retry across `historicalPaths` (see
  [reviewed-body-across-renames.md](reviewed-body-across-renames.md)).
- `reviewedMermaidPreviewSource(file, thread)` → **`mermaidPreviewSourceFromBody(body,
  thread)`** — builds the node/edge preview source from an already-fetched body, so
  the caller controls which version's body it runs against.

## Verified live

In the harness (`.dev-vault`): the working-copy thread renders `‹ Working copy ›` and
its preview loads the real mermaid node (proving the `bodyAtRevision` → preview
pipeline end-to-end). Driving `renderVersionStepper` with a six-commit ladder showed
the label stepping `v3 → v6`, the left chevron disabling at the latest version, the
right chevron enabling through to the oldest, and the authored version rendering bold.
`make check` green (typecheck, 23 unit tests, x-callback in sync, comment validation,
gitleaks).

# Dev vault moved into `docs/`; and the `--follow --reverse` bug it exposed

*2026-09-21. Pivot record — read alongside [`version-stamping.md`](version-stamping.md).*

## What forced the change

The comments panel's **Revisions filter** (a header dropdown that scopes threads to
one revision, labelled `v7 (abc1234)`) rendered no version numbers in the dev vault —
only body-hash prefixes. Root cause was the vault layout, not the feature:

- The dev vault was `./.dev-vault` (gitignored, self-contained), and its `design.md`
  was a **stale untracked copy**. `git log` in that tree returned nothing, so
  `fileRevisionOrdinals` had no history to number and every thread fell back to
  `bodyHash.slice(0,7)`.
- That fallback is why an old fixture read "committed on `d3de8c5`" — `d3de8c5` was
  never a commit, it was the *body hash* prefix (`d3de8c509bf6`), masquerading as one.

Meanwhile the real `design.md` **was** tracked at the repo root (5 commits), just not
where the plugin was reading it.

## The decision (option A1)

Make **`docs/` the Obsidian dev vault** and dogfood the product on its own tracked
docs — the review tool reviewing the repo it lives in:

- `git mv design.md → docs/designs/design.md` and `.design.comments.md →
  docs/designs/.design.comments.md` (history preserved; `--follow` traces the rename).
- Vault **config** (`docs/.obsidian/`) and throwaway fixtures (`sample.md`,
  `plate.png`, `POC-4-report.md`) are machine-local → **gitignored**. The docs and
  their **review sidecars are committed** as real artifacts: a review record now
  ships with the docs.
- Harness retargeted: `scripts/install-dev.mjs` installs into `docs/.obsidian`;
  `scripts/capture-media.mjs` defaults `--vault docs`; API-doc examples regenerate to
  `vault=docs&file=designs/design.md`. `.dev-vault` is retired (its ignore line kept
  for old checkouts).

## The bug the move exposed: `git log --follow --reverse`

`fileRevisionOrdinals` numbered revisions with:

```
git log --follow --reverse --format=%h -- <path>
```

The instant `design.md` was renamed, this returned **only the tip commit** — the
rename trace vanished. It's a known git limitation: **`--follow` must not be combined
with `--reverse`** (the follow machinery rewrites history walking backward from HEAD;
`--reverse` conflicts with it). Proof on this repo, post-move:

| command | result |
|---|---|
| `git log --follow --format=%h` | all 6 commits (incl. `R100` rename) ✓ |
| `git log --follow --reverse --format=%h` | tip commit only ✗ |

The bug was **latent** — it "worked" only while the file had never been renamed. Fix
(`src/main.ts`): drop `--reverse`, fetch newest→oldest, and `.reverse()` in JS so the
ordinal is still the 1-based position from the oldest commit.

## Fixture reconstruction

The tracked sidecar's four threads carried **no `rev` stamp** (the richer stamped
threads had only ever lived in the throwaway `.dev-vault` copy). To make the filter
demonstrable, each thread was stamped with the exact rev the plugin *would* have
written had it been authored at a real past revision — real 7-char commit, real
40-char blob, and the true body-hash **at that commit** (computed by replicating
`bodyHashFor`: `stripBlockIds(stripFrontmatter(text))` → sha256, first 12 hex):

| thread | commit | v | staleness |
|---|---|---|---|
| `d1a2b3`, `e4f5a6` | `28ae788` | v3 | outdated (body changed since; no `anchorHash` → coarse `bodyHash` fallback) |
| `a7b8c9` | `b1237be` | v4 | outdated |
| `qklp1y` | `bd9dda7` | v5 | current (`bd9dda7` body == HEAD; the move was a pure rename) |

Dropdown now: **All, v5 (bd9dda7), v4 (b1237be), v3 (28ae788)**. The mixed
current/outdated result is faithful: an `anchorHash`-less thread legitimately gets the
coarse whole-body staleness signal (see `version-stamping.md`).

## Follow-ups (not done here)

- **Live capture of the Revisions dropdown** needs Obsidian to have `docs/` opened as
  a vault once (GUI: Open folder as vault → `docs`, disable Restricted Mode, enable
  Review MD). The harness can't do that first registration headlessly. Existing
  `docs/media/*.png` stay valid — the diagrams/badges are unchanged by the move.
- The demo `shot-list.md` still references a **working-copy** thread (`c0ffee`) and a
  version-stamp "committed vs working copy" pair that aren't in the tracked sidecar; a
  fixture refresh (add one working-copy thread) would restore those shots.

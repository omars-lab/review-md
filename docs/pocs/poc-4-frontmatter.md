# POC-4 — frontmatter storage at scale (go/no-go)

**Risk:** requirement 7 stores comment threads in each file's YAML frontmatter. Does that survive
a serialize→parse round-trip at realistic scale and content, and stay usable inside Obsidian?

**PASS bar:** 50 threads with multi-message replies round-trip without corrupting the doc.

## Two halves

| Half | What it tests | How to run | Status |
|---|---|---|---|
| **Data-model** (headless) | Does the schema survive YAML round-trip at scale, incl. newlines/colons/quotes/markdown/unicode? | `npm run poc:frontmatter` | **PASS** ✅ |
| **Obsidian** (GUI) | Does `processFrontMatter` write/read 50 threads, and does the Properties panel stay usable? | Command palette → *Review MD: POC-4 seed & verify frontmatter threads* → open `POC-4-report.md` | **PASS** ✅ (2026-09-19, live) |

## Data-model result (headless — recorded 2026-09-19)

```
threads:          50
total messages:   123
frontmatter size: 25839 bytes (25.2 KB)
deep-equal round-trip: OK
RESULT: PASS
```

Uses the `yaml` package as a stand-in for Obsidian's serializer — indicative, not identical.
Bodies deliberately include a trailing colon, embedded quotes, a leading `#`, multi-line text, a
markdown link/code, and unicode diacritics (`ū ḥ ʿ`) + emoji; all round-trip byte-for-byte.

**Signal to carry forward:** 50 threads ≈ **25 KB of frontmatter**. It round-trips fine, but that is
large for a value that lives in `metadataCache` and renders in the Properties UI. The GUI half must
confirm the note stays usable; if the Properties panel chokes or the cache bloats, fall back to the
**sidecar/hybrid** storage (ids in frontmatter, bodies in `.review/`) noted in the plan. A sensible
threshold to revisit: > ~30–40 threads per file.

## Obsidian half — how to run

1. `npm run build && npm run install:dev` (already done — vault at `.dev-vault`).
2. Open `.dev-vault` as a vault in Obsidian; disable Restricted Mode; enable **Review MD** (GUI-only).
3. Open `sample.md`, run the command above.
4. Read `.dev-vault/POC-4-report.md` — it records PASS/FAIL, write time, file size, and prompts you
   to eyeball the Properties panel. Copy the observation back here.

## Obsidian half result (live — recorded 2026-09-19)

Ran via the official Obsidian CLI against the isolated sandbox instance:
`obsidian-cli eval code="app.commands.executeCommandById('review-md:poc4-seed-verify-frontmatter')"`.

```
RESULT: PASS
threads written / read back: 50 / 50 ✓
total messages:   123
unicode+newline body round-trip: OK ✓
processFrontMatter write time: 40.2 ms
resulting file size: 25474 bytes
```

This is Obsidian's **real** `processFrontMatter` serializer (not the headless `yaml` stand-in) — so
the schema round-trips for real. Usability eyeballed via in-process `obsidian-cli dev:screenshot`:
`sample.md` renders fine with the 50-thread `review` block in frontmatter — the Mermaid diagram and
the footnote both render natively, and the status bar shows **"2 properties"**: Obsidian folds the
whole `review` object into a **single nested property**, so the Properties panel does *not* explode
into 50 rows. Note stays responsive (the 50-thread write took 40 ms).

**Watch-point (unchanged):** 25 KB in `metadataCache` per file is still heavy at scale; if a real
doc pushes well past ~30–40 threads, expanding the nested `review` property in the Properties editor
and cache pressure are the first things to re-measure → fall back to sidecar/hybrid then. For the
target use (design-review threads per file), frontmatter-primary is confirmed good.

## Verdict

**PASS** (both halves). Data-model round-trips headlessly *and* through Obsidian's own serializer at
50 threads; the note stays usable. Requirement 7 (frontmatter storage) is confirmed — no need to
pivot to sidecar now; the threshold + fallback are documented for later.

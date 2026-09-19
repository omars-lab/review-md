# POC-4 — frontmatter storage at scale (go/no-go)

**Risk:** requirement 7 stores comment threads in each file's YAML frontmatter. Does that survive
a serialize→parse round-trip at realistic scale and content, and stay usable inside Obsidian?

**PASS bar:** 50 threads with multi-message replies round-trip without corrupting the doc.

## Two halves

| Half | What it tests | How to run | Status |
|---|---|---|---|
| **Data-model** (headless) | Does the schema survive YAML round-trip at scale, incl. newlines/colons/quotes/markdown/unicode? | `npm run poc:frontmatter` | **PASS** ✅ |
| **Obsidian** (GUI) | Does `processFrontMatter` write/read 50 threads, and does the Properties panel stay usable? | Command palette → *Review MD: POC-4 seed & verify frontmatter threads* → open `POC-4-report.md` | ⏳ pending one-time GUI enable |

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

## Verdict

Data-model half **passes** → the schema is sound. Go/no-go for the plugin waits only on the GUI
half (usability), not on data integrity.

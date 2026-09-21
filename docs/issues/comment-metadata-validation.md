# Validating comment-sidecar metadata

## Problem

Every comment thread lives in a `*.comments.md` sidecar's `review:` YAML
frontmatter, which is the source of truth (see [comment-sidecar.md](comment-sidecar.md)).
The plugin writes it correctly, but the sidecar is plain text that also travels
through **git, CLI tools, and agent sessions** — the primary workflow is explicitly
"edit and commit in the CLI, review in Obsidian" (see [reanchor-hook.md](reanchor-hook.md)).
So the metadata is routinely hand- and script-edited by things that are *not* the
plugin, and a bad edit can land: a dropped required field, an unknown anchor type,
a duplicated thread id — or the subtle one below.

### The all-digit-hash trap (the motivating bug)

`anchorHash`/`bodyHash` are 12-hex sha256 slugs. Roughly 0.2% of them are **all
decimal digits** (e.g. `645390782670`). In YAML an unquoted all-digit scalar is an
**integer**, not a string:

```yaml
anchorHash: 645390782670     # parsed as the NUMBER 645390782670
anchorHash: "645390782670"   # parsed as the STRING "645390782670"
```

Read back as a number it never `===` the string `sha256Short` computes, so the
per-anchor staleness check (see [version-stamping.md](version-stamping.md)) reads
that thread as **outdated forever**. This actually bit the dogfood fixture during
the per-anchor-staleness work: the one thread whose hash was all digits showed up
as "1 hidden" in the sidebar while every other (unchanged) thread was correctly
current. The plugin's own YAML writer quotes such values; only hand edits miss it.

## The gate

`scripts/validate-comments.mjs` schema-checks each sidecar and **fails the commit**
on any violation. It runs two ways, both the same command (local == CI parity):

- **pre-commit hook** `validate-comments` — `pass_filenames`, `files:
  '(^|/)\.[^/]+\.comments\.md$'`, so it re-checks exactly the staged sidecars.
- **`make validate`** (folded into `make check`) — with no file args it walks every
  sidecar git knows about (tracked or untracked-not-ignored), like the reanchor hook.

### What it checks

- frontmatter parses; `review:` is a mapping; `review.uid` a non-empty string;
  `review.threads` a list.
- each thread: `id` a unique non-empty string; `anchor.type` one of
  `text | mermaidNode | mermaidEdge | header | image`; the type's required fields
  present and non-empty (`mermaidNode`→`node`, `mermaidEdge`→`from`+`to`,
  `image`→`src`, `text`/`header`→`quote`); `messages` a list of `{author, body}`.
- `resolved` is a boolean when present.
- `rev` (when present): `bodyHash` a string; `anchorHash`, `ts`, `git.commit`,
  `git.blob` strings when present — **every scalar that must be a string is
  type-checked**, which is what catches the numeric-hash trap.

### `--fix` (the one deterministic repair)

`make validate-fix` (`--fix`) re-quotes string fields that YAML parsed as
numbers/booleans and rewrites **only** the frontmatter (the generated body is
preserved verbatim, exactly as the reanchor hook does). It's the single
auto-repairable class; structural errors (missing field, unknown type, duplicate
id) still fail and are fixed by hand. Idempotent: a clean file is a no-op.

## Why a validator and not just plugin discipline

The plugin isn't in the loop when the CLI/agent edits or commits the sidecar — the
same reason re-anchoring is a git hook, not plugin code. A gate that runs at commit
time is the only place that catches a bad edit regardless of who made it. Keeping it
a `repo: local` hook backed by a `make` target means CI, the hook, and a manual run
are the identical command.

## Related

- [version-stamping.md](version-stamping.md) — the `rev`/`anchorHash` schema the
  validator enforces and the staleness check that the numeric-hash bug broke.
- [reanchor-hook.md](reanchor-hook.md) — the sibling post-commit hook that keeps the
  same metadata up to date (WORKING_REV → real commit) after a CLI commit.
- [comment-sidecar.md](comment-sidecar.md) — why the metadata lives in a sidecar.

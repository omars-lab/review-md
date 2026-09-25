# Version-stamping comments (per committed version of a file)

## Goal

A comment should record which version of the file it was made against, so we can
(1) flag a thread as **outdated** when the reviewed content later changes, and
(2) retrieve the exact text that was reviewed, even after the file moves on.

This is the point-in-time baseline half of anchoring; durable block-ref anchoring
(see the backlog) is the other half. They compose: block-refs make an anchor
survive edits within the working file; the version stamp records the baseline the
anchor was made against.

## Schema

Each thread gets an optional `rev`:

```yaml
rev:
  anchorHash: 4b87cc1fa2fe      # sha256 of just THIS thread's anchored content (primary staleness signal)
  bodyHash: ea936ad0d737        # sha256 of the whole document BODY (frontmatter stripped) — coarse fallback
  ts: 2026-09-20T03:08:23.565Z
  git:                          # present only when the file is in a git work tree
    commit: ec14c64             # last commit that TOUCHED the md (see pivot below)
    blob: 31f7fa6…             # committed blob (HEAD:<relpath>)
```

Every scalar in `rev` (both hashes, `ts`, `git.commit`, `git.blob`) is a **string**.
A 12-hex hash that happens to be all decimal digits is a YAML integer unless
quoted, and read back as a number it never equals the string the staleness check
computes — the thread then reads "outdated" forever. The plugin's YAML writer
quotes such values automatically; hand edits must too. The `validate-comments`
hook (see [comment-metadata-validation.md](comment-metadata-validation.md)) fails
the commit on an unquoted numeric hash and `make validate-fix` re-quotes it.

## Why body hash, not a whole-file hash

`bodyHash` hashes the document body with the leading frontmatter block stripped
(`stripFrontmatter`), so it changes only when the reviewed prose/diagrams actually
change. It's git-agnostic — it works in a plain vault with no repo.

Historically this also solved a comment-churn problem: comments used to live in
the reviewed file's own frontmatter, so **any whole-file hash — including the git
blob of the working tree — changed every time a comment was added**, and keying
staleness off that would false-flag every thread the moment the next comment
landed. Stripping the frontmatter dodged that.

As of the sidecar move (see [comment-sidecar.md](comment-sidecar.md)), comments no
longer live in the reviewed file **at all** — they're in a git-tracked sibling
`.<name>.comments.md`. So the reviewed file's whole-file/blob hash is now *also*
stable across comment activity. `bodyHash` is kept regardless: it's still the
right signal (frontmatter-agnostic, git-free, fires pre-commit), and it stays
correct even if a reviewed file's own frontmatter is edited for non-review
reasons.

## Why the *committed* blob, not the working tree

`git` records `HEAD:<relpath>` — the blob of the **committed** version — not a
working-tree `hash-object`. The committed blob is what `git show <commit>:<path>`
and `git cat-file blob <blob>` resolve, giving an agent/reviewer the exact
reviewed text. (Before the sidecar move this also mattered for stability, since a
working-tree hash churned with every frontmatter comment; now comments live in the
sidecar, so the reviewed file's working tree no longer churns either — but the
committed blob remains the right thing to record for retrieval.) An untracked file
(e.g. the gitignored `.dev-vault/` dogfood copy) has
no `HEAD:<relpath>` blob, so `git` is omitted and `bodyHash` alone carries
staleness — verified: the vault copy stamps `bodyHash` only, the tracked root
`design.md` would stamp `commit`/`blob` too.

## Staleness check (consumed by the sidebar UI)

Staleness is **per-anchor**: a thread is "outdated" only when the content **it
anchors to** changed or was removed — not when the file changed *anywhere*
(Omar, 2026-09-21: "unless on our latest, we removed content"). Edit an unrelated
section and every thread whose own anchor is untouched stays current.

`isThreadOutdated(file, thread)` decides it:

1. **`anchorHash` present** (the normal case) → recompute the current text of just
   what this thread anchors to (`anchorContentFor`) and compare:
   - target **gone** (node/edge/block/heading/image removed) → **outdated**;
   - present but its hash **differs** from `rev.anchorHash` → **outdated**;
   - present and hash **matches** → **current**, no matter how much else moved.
2. **anchor can't be precisely extracted** (returns `undefined`) or **no
   `anchorHash`** (legacy thread) → fall back to the coarse whole-body `bodyHash`
   compare below.

`anchorContentFor` extracts per anchor type: a **mermaidNode**'s declaration
(id + shape + label, via the shared `MERMAID_SHAPES` regex), a **mermaidEdge**'s
link line (`from … --> … to`), a **text** anchor's `^blockId` block text (or, with
no block id, whether its quote still appears), a **header**'s heading text, an
**image**'s `src`. Content is whitespace-normalised, so reflowing without changing
the words is not a change.

`anchorHash` is stamped by `createThread` **after** any `^blockId` is placed (so a
text anchor hashes the block it will actually resolve to), while `bodyHash`/`git`
are computed **before** that write (so our own `^id` insertion never flips the
thread's git stamp to the working-copy sentinel).

### Why not whole-file `bodyHash`?

`bodyHash` (whole body, frontmatter stripped) was the *only* signal before this
pivot, and it over-fires: it flags **every** stamped thread the moment **any** part
of the doc changes. On the dogfood `design.md`, editing prose far from a diagram
flagged a thread on an untouched mermaid node as outdated — the false positive that
prompted the pivot. `bodyHash` is kept only as the fallback for anchors we can't
extract precisely; it never over-rides a computable `anchorHash`.

`git.blob`/`git.commit` are deliberately *not* used for staleness. `git` is for
**identity and retrieval** only: "commented on `<commit>`" and
`git show <commit>:<file>` to recover the exact reviewed text.

## Pivot: the *last-touching* commit, not HEAD

Recording `commit` as bare `HEAD` was wrong. A file's meaningful "version" is the
last commit that actually **changed that file**, not whatever HEAD happens to be —
HEAD moves on with every unrelated commit, so a stamp of `HEAD` would drift away
from the content it named even though the reviewed bytes never changed.

Evidence from the dogfood vault: `design.md` was last edited in `50ba884`, but by
the time the sidebar rendered, HEAD had moved three commits on to `fb70035`
(mermaid restyle work that never touched `design.md`). Stamping `HEAD` would have
labelled the thread `on fb70035` — a commit where the reviewed file is byte-for-byte
identical to `50ba884`. The stamp must read `on 50ba884`.

So `gitRevFor` resolves the commit with:

```
git rev-list -1 --abbrev-commit HEAD -- <relpath>   # last commit touching the file
git rev-parse HEAD:<relpath>                          # its committed blob
```

`rev-list -1 … -- <path>` walks back from HEAD and stops at the first commit that
modified `<path>`. `blob` stays `HEAD:<relpath>` because the working tree at that
path equals the last-touching commit's version (nothing since changed it), so the
blob is stable and `git show <commit>:<path>` still recovers the exact text.

## Working-copy comments (uncommitted rev)

A file can be commented on before its latest edits are committed. In that state
there is no last-touching commit for the *current* body, so the thread is stamped
with the `WORKING_REV` sentinel (`"working"`) instead of a `git.commit` — but the
working-tree blob (`git hash-object`) *is* recorded, since that's the key the
re-anchor step matches on. The sidebar shows **"working copy"** rather than
`on <commit>`. Because the commit fires in the CLI (not Obsidian), re-anchoring
runs as a **post-commit hook**, not in the plugin: on the commit that lands the
file it swaps `WORKING_REV` for the real last-touching commit once the recorded
blob matches `HEAD:<path>`. See [reanchor-hook.md](reanchor-hook.md) for the full
options evaluation. `bodyHash` still carries staleness in the working state exactly
as for committed threads.

## Robustness

- No Node access (mobile / restricted renderer) → `git` omitted, `bodyHash` still
  computed via Web Crypto.
- Each `git` subprocess call has a 4s timeout so a slow/hung repo can't freeze
  thread creation.
- `rev` is optional; pre-existing threads without it simply show no version info.
- An anchor type we can't extract precisely (`anchorContentFor` → `undefined`)
  degrades to the `bodyHash` compare rather than guessing; a legacy thread with a
  `bodyHash` but no `anchorHash` behaves exactly as before this pivot.
- Every `rev` scalar is validated as a **string** by the `validate-comments`
  pre-commit hook, closing the all-digit-hash-parsed-as-integer trap for good.

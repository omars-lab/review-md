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
  bodyHash: ea936ad0d737        # sha256 of the document BODY (frontmatter stripped)
  ts: 2026-09-20T03:08:23.565Z
  git:                          # present only when the file is in a git work tree
    commit: 8dfd923             # last commit that TOUCHED the md (see pivot below)
    blob: 31f7fa6…             # committed blob (HEAD:<relpath>)
```

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

Staleness is decided by **`bodyHash` alone**: current body hash differs from the
stored `rev.bodyHash` → the reviewed content changed since the comment. This
fires immediately (pre-commit), works in non-git vaults, and — crucially — does
**not** trip on comment churn, since the body excludes frontmatter.

`git.blob`/`git.commit` are deliberately *not* used for staleness. `git` is for
**identity and retrieval** only: "commented on `<commit>`" and
`git show <commit>:<file>` to recover the exact reviewed text. (Historically
`git.blob` = `HEAD:<relpath>` included the frontmatter comments, so a comment-only
commit would false-flag it — the churn problem `bodyHash` dodges. With the sidecar
move that specific hazard is gone, but `bodyHash` remains the sole staleness signal
because it's git-free and frontmatter-agnostic.)

## Pivot: the *last-touching* commit, not HEAD

Recording `commit` as bare `HEAD` was wrong. A file's meaningful "version" is the
last commit that actually **changed that file**, not whatever HEAD happens to be —
HEAD moves on with every unrelated commit, so a stamp of `HEAD` would drift away
from the content it named even though the reviewed bytes never changed.

Evidence from the dogfood vault: `design.md` was last edited in `28ae788`, but by
the time the sidebar rendered, HEAD had moved three commits on to `85930ea`
(mermaid restyle work that never touched `design.md`). Stamping `HEAD` would have
labelled the thread `on 85930ea` — a commit where the reviewed file is byte-for-byte
identical to `28ae788`. The stamp must read `on 28ae788`.

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
with the `WORKING_REV` sentinel (`"working"`) instead of a `git.commit`, and the
sidebar shows **"working copy"** rather than `on <commit>`. On the next commit that
touches the file, a post-commit hook re-anchors those working threads to the new
commit (see the design doc + backlog). `bodyHash` still carries staleness in the
working state exactly as for committed threads.

## Robustness

- No Node access (mobile / restricted renderer) → `git` omitted, `bodyHash` still
  computed via Web Crypto.
- Each `git` subprocess call has a 4s timeout so a slow/hung repo can't freeze
  thread creation.
- `rev` is optional; pre-existing threads without it simply show no version info.

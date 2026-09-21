# Re-anchoring working-copy comments to their commit (#42)

## Problem

A thread authored against the uncommitted working copy is stamped with the
`WORKING_REV` sentinel (`"working"`) and the working-tree blob (`git hash-object`)
— see [version-stamping.md](version-stamping.md). Once the reviewed file is
committed, that thread should stop saying **"working copy"** and instead name the
commit that landed it, so the version stamp and `git show <commit>:<path>`
retrieval work like any committed thread.

The invariant that makes this reliable (verified in a scratch repo): a dirty
file's recorded working blob (`git hash-object -- <path>`) equals `HEAD:<path>`
once that exact content is committed. So the re-anchor is a pure lookup — no
diffing, no guessing:

```
for each thread with rev.git.commit == "working":
    if git rev-parse HEAD:<reviewed-path>  ==  thread.rev.git.blob:
        thread.rev.git.commit = git rev-list -1 --abbrev-commit HEAD -- <reviewed-path>
        # blob is already identical; only the sentinel changes
```

## The deciding constraint: commits happen in the CLI, not Obsidian

review-md's primary workflow (see [design.md](../designs/design.md#how-its-used--the-primary-workflow)):

- **Editing + committing happen in the CLI** — usually a Claude Code session.
- **Reviewing happens in Obsidian** — which writes only the sidecar, never commits
  the reviewed file.

So at the moment a file is committed, **Obsidian may be closed and the plugin not
running.** That single fact decides the mechanism.

## Options evaluated

### A. In-plugin, lazy (rejected)

Re-anchor when the plugin next loads/renders a `WORKING_REV` thread. Zero install,
self-heals, works however the commit was made.

Rejected: it re-anchors only when someone *next opens the doc in Obsidian*. In the
real workflow the commit happens in the CLI and Obsidian is often never reopened
on that file, so the on-disk sidecar would stay stamped `"working"` indefinitely —
wrong for the git history and for agents/reviewers reading the sidecar from the
CLI. The plugin is the wrong owner because **the plugin never commits.**

### B. Post-commit hook (chosen)

A `post-commit` hook re-anchors at commit time, in the same CLI session that made
the commit — exactly when the landing happens, plugin or no plugin. Installed
through the **pre-commit framework the repo already uses**
(`.pre-commit-config.yaml`, `make hooks` → `pre-commit install --hook-type
post-commit`), so:

- the hook file is managed by pre-commit — the existing `pre-commit` hook is
  **chained, never clobbered** (CLAUDE.md: never overwrite another mechanism's
  hook);
- install is one documented command that matches the existing `make hooks` habit;
- it stays local==CI-parity in shape with the other checks.

The re-anchor logic lives in `scripts/reanchor-comments.mjs` (plain Node, no
plugin, no build step), invoked by the hook. It walks tracked `*.comments.md`
sidecars, applies the lookup above, and rewrites only the matched threads.

### C. Both (deferred)

B as the always-on path plus A as a fallback for threads committed outside the
hook. Not needed yet — B covers the stated workflow. If working threads ever get
committed on a machine without the hook installed, add A later as a self-heal.
Kept out now to avoid doubling the surface (CLAUDE.md: ship by ROI).

## Why post-commit, and why it leaves the sidecar dirty

The real commit SHA doesn't exist until *after* the commit, so the stamp can only
be written **post-commit** (a pre-commit hook would know the staged blob but not
the SHA). Post-commit runs after the commit object exists, rewrites the sidecar,
and leaves it as an **unstaged working change** with a one-line notice per
re-anchored thread. The same CLI/Claude Code session then commits the sidecar in
its next commit — natural in an agent session, and honest in history (the
re-anchor is its own small change).

Rejected alternative: `git commit --amend` from the hook to fold the sidecar into
the just-made commit. That rewrites history (dangerous once pushed) and risks
hook recursion; the one-commit lag is the safer trade. Documented so a future
session doesn't "fix" it into an amend.

## Guardrails

- The hook is a no-op when no sidecar has a `WORKING_REV` thread, and when a
  thread's blob doesn't match `HEAD:<path>` (file committed with *different*
  content than was reviewed — stays `"working"`, correctly, until it lands
  verbatim). Idempotent: re-running finds nothing to change.
- Each `git` call is bounded; a sidecar that fails to parse is skipped with a
  warning, never dropped or rewritten blind.
- Sidecars are matched to their reviewed file by name (`.design.comments.md` →
  `design.md`); a sidecar whose reviewed file is untracked or absent is skipped.

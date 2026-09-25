# History rewrite changed every commit ID — stored IDs had to follow

**2026-09-25.** Before opening the beta, the repo went public, and Omar asked to rewrite
history so commits carry his GitHub noreply address instead of a work email
(`git filter-repo --mailmap`, then force-push of every branch and the `0.1.0` tag).
File contents were untouched — every branch's tree hash matched before and after.

## What broke

Rewriting author details gives every commit a new ID. The code never stores commit
IDs, but **review threads do**: each thread's `rev.git.commit` records the commit it
was written against, and the version stepper and the Revisions dropdown look those
commits up with `git show` / `git log`. The dogfood threads in
`docs/designs/.design.comments.md` pointed at `28ae788`, `b1237be` and `bd9dda7` —
IDs that no longer exist on any branch. They still resolved on the machine that did
the rewrite (old objects linger locally), so nothing looked wrong there; on a fresh
clone the stepper would have lost those versions.

Docs and the capture shot list quote the same IDs (plus `38238a7`, `42cdea2`,
`85930ea`, `8dfd923`) as evidence; those would have become dead references.

## Fix

`filter-repo` writes the old → new mapping to `.git/filter-repo/commit-map`. Each
old short ID was swapped for its new one in every tracked file (checked first that
none appeared as a full 40-character ID, where a prefix swap would garble it). The
stored `rev.git.blob` values needed no change — contents are identical — and they
confirm the mapping: the design doc at new `1551edf` is blob `faf932b…`, exactly
what thread `a7b8c9` recorded.

| old | new |
|---|---|
| `28ae788` | `50ba884` |
| `38238a7` | `3b03b61` |
| `42cdea2` | `b87b326` |
| `85930ea` | `fb70035` |
| `8dfd923` | `ec14c64` |
| `b1237be` | `1551edf` |
| `bd9dda7` | `3f82635` |

## For next time

- Any history rewrite must also rewrite commit IDs stored in `*.comments.md`
  sidecars. Users' own vaults are affected the same way if *they* rewrite a repo that
  holds review threads.
- A local check passing proves little here: the old commits are still in the local
  object store. Check against a fresh clone, or with `git branch -a --contains <id>`.
- Merged PRs on GitHub keep their original commits (and author email); only GitHub
  Support can purge those.

# Older threads showed OUTDATED after any edit to the doc

**2026-09-26.**

## What we saw

Building `reviews diff` on the design doc: all three open threads were marked OUTDATED
by both `reviews stats` and the plugin, yet `reviews diff` showed each one's diagram box
or arrow word-for-word the same as when it was reviewed.

## Why

A thread is outdated when the thing it points at changed. The precise check hashes that
passage when the thread is written (`rev.anchorHash`). Threads written before that stamp
existed have only `rev.bodyHash`, a hash of the whole doc, so any edit anywhere — a new
section, a typo fix — flagged every one of them. Those threads are the ones a reviewer
has been waiting on longest, so they're the worst to cry wolf on.

## What changed

Most threads also carry the git version the reviewer saw (`rev.git.blob` /
`rev.git.commit`). When there's no passage stamp, the plugin and the CLI now pull that
version from git and compare just the commented passage then and now
(`anchorChanged` in `src/pure.ts`, built on the same `anchorContentIn` both use for
stamped threads). The whole-doc hash is the last resort: no git, the reviewed version
is gone, or the anchor can't be pinned down.

Order, in both `isThreadOutdated` (plugin) and `staleness` (CLI):

1. passage stamp (`anchorHash`)
2. passage in the reviewed git version vs today
3. whole-doc hash

The reviewed text is cached per commit (plugin) or blob (CLI), since many threads share
one version and a commit's content never changes.

Result on the design doc: open + outdated went from 3 to 0, which matches what `diff`
shows.

# Git commands ran from the file's folder, so pathspecs for nested files matched nothing

## Symptom

The version stepper showed only a working-copy row and static stamps for
`docs/designs/design.md` — no v1…v6 ladder — even though the file has six real
commits of history and four threads stamped to real commits (`28ae788`, `b1237be`,
`bd9dda7`). `fileRevisionOrdinals` returned an **empty map**. This only surfaced once
the harness ran against the real `docs/` vault; the earlier `.dev-vault` is gitignored
(no history at all), so the empty result there looked expected and hid the bug.

## Root cause

`gitContext` ran every git command with `-C <dir>`, where `dir` is the *file's own
directory* (`dirname(abs)` = `docs/designs`), but built `rel` **relative to the repo
root** (`docs/designs/design.md`) and passed that as the pathspec.

Git resolves a pathspec relative to the current working directory. So the plugin ran:

```
git -C docs/designs log --follow -- docs/designs/design.md
```

which looks for `docs/designs/docs/designs/design.md` — nothing — and returns empty,
with exit 0 and no error. Every **pathspec**-based call was affected for any file not
sitting at the vault root: `log --follow` (ordinals), `status --porcelain` and
`rev-list -1` (live stamping in `gitRevFor`), `log --follow --name-only`
(`historicalPaths`).

The **tree-ish** calls — `git rev-parse HEAD:<rel>` and `git show <commit>:<rel>` —
kept working, because a `<tree>:<path>` is always resolved from the repo root
regardless of cwd. That asymmetry is exactly why it half-worked and stayed hidden: a
thread could still fetch a body, but the history it was supposed to walk came back
empty.

## Fix

Run every real git command **from the repo root**, not the file's folder. `gitContext`
now probes `rev-parse --show-toplevel` once from the file's directory (that call takes
no pathspec, so cwd is harmless), then binds `run` to `-C <root>`. `rel` stays
repo-root-relative, so pathspecs and tree-ish paths now agree.

```ts
const root = await exec(dir, ["rev-parse", "--show-toplevel"]);
if (!root) return null;
const run = (args, trim = true) => exec(root, args, trim);
return { run, rel: nodePath.relative(root, abs) };
```

## Why it went unnoticed

The whole revision feature was demoed on `design.md` while it lived at the **vault
root** (`design.md`), where `dir` *is* the root and `rel` has no leading folder — so
the cwd/pathspec mismatch was a no-op. The move into `docs/designs/` (commit
`38238a7`) is the same rename that broke `--follow --reverse` v-numbering
(see [reviewed-body-across-renames.md](reviewed-body-across-renames.md)); it also
quietly relocated the file *below* the vault root and exposed this. Verifying the
stepper against the real git-tracked vault — not the synthetic `.dev-vault` — is what
made it visible.

## Guard

The lesson is the CLAUDE.md "look at the actual render / verify against real state"
rule: a feature "verified" only against an injected synthetic ordinals map can hide a
data-layer bug that a real repository would have caught on the first open. The stepper
chrome was correct; the git plumbing under it was not.

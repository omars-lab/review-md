---
name: release
description: >-
  Cut a review-md release: bump the version, check everything agrees, and publish the
  GitHub release that ships both the Obsidian plugin (BRAT, store, zip) and the Claude
  Code plugin (reviews skill + CLI). Use when asked to "release", "cut 0.x.y", "ship a
  beta", "publish a new version", "bump the version", or "why doesn't BRAT / the Claude
  plugin see the new version".
---

# release — ship both plugins from one commit

One version number covers everything. What reads it:

| What | Reads from | Gets |
|---|---|---|
| BRAT, the community store | the GitHub release tagged `<version>` (no `v`) | `main.js`, `manifest.json`, `styles.css` |
| Manual install | the same release | `review-md-<version>.zip` (unzip into `.obsidian/plugins/`) |
| Claude Code plugin | `main` (`.claude-plugin/marketplace.json` → `plugins/review-md/`) | the skill + bundled `bin/reviews.mjs` |
| CLI without Claude Code | the same release | `reviews.mjs` (Node 18+) |

So a release is: **the version bump merged to `main`, then a GitHub release cut
from `main`.**

## Steps

1. **Pick the version.** Publishing is outward-facing, so the version number needs
   the user's go. Betas are `0.1.x`, for example.
2. **Branch, bump, commit:** `make version V=<x.y.z>`. This updates `manifest.json`,
   `package.json`, `versions.json` and `plugins/review-md/.claude-plugin/plugin.json`
   together. Stage those four by name and commit "Release <x.y.z>".
3. **Check:** `make check`, then `make release-check`. `release-check` builds, checks
   that the four versions agree, that the CLI bundle is fresh (`make cli` if not), that
   `claude plugin validate .` passes, and that the zip builds. It also needs a clean
   tree and a tag that isn't taken yet.
4. **PR and merge to `main`.** From here the Claude plugin is live: users get it with
   `claude plugin update review-md@review-md`, or automatically.
5. **Release from `main`:** `git switch main && git pull`, then
   `make release` (optionally `node scripts/release.mjs --notes "…"`). It tags HEAD and
   uploads the five assets to the release.
6. **Prove it:** `gh release view <x.y.z>` should list all five assets. Then
   `make setup-verify VAULT=<name>` against a BRAT vault (see the `setup-review-md`
   skill). For the Claude plugin, install it the way users do, then remove it:
   `claude plugin marketplace add omars-lab/review-md` →
   `claude plugin install review-md@review-md` →
   `claude -p "run: command -v reviews && reviews stats docs"` →
   `claude plugin uninstall review-md@review-md` →
   `claude plugin marketplace remove review-md`.

## Gotchas

- The tag must equal `manifest.json`'s version exactly, with no `v` prefix. BRAT
  silently finds nothing otherwise.
- `plugins/review-md/bin/reviews.mjs` is committed, so edits to `scripts/reviews.mjs`
  or `src/pure.ts` need `make cli`. The pre-commit hook and `make check` catch a stale
  bundle.
- Test the plugin by installing it, not only with `--plugin-dir`. That flag runs the
  skills but doesn't put `bin/` on PATH, so `reviews` looks missing when it isn't (see
  `docs/issues/packaging.md`).
- Never force-move or delete a published tag: BRAT users have already pulled it. Fix
  forward with the next patch version.

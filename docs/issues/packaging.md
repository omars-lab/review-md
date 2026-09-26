# Packaging: install outside the clone (Claude plugin, zip, standalone CLI)

**2026-09-26.** Until now, everything agent-side (the `reviews` CLI, the `reviews`
skill) only worked inside a clone of this repo: the CLI imported `../src/pure.ts` and
needed `node_modules/yaml`, and the skill lived in `.claude/skills/`. The Obsidian
plugin could only be installed through BRAT or a source build.

## What we did

- **The CLI is bundled into one file.** `scripts/build-cli.mjs` runs esbuild over
  `scripts/reviews.mjs` to produce `plugins/review-md/bin/reviews.mjs`, with no
  dependencies, and it runs on Node 18+. The bundle is committed because a Claude
  plugin installs straight from git, with no build step. `make cli-check` (in
  `make check` and pre-commit) fails when the bundle lags its sources.
- **The repo is a Claude Code marketplace.** `.claude-plugin/marketplace.json` points
  at `plugins/review-md/`, which holds the plugin manifest, the bundled CLI and the
  `reviews` skill. Install with
  `/plugin marketplace add omars-lab/review-md` → `/plugin install review-md@review-md`.
- **The skill lives in one place.** The plugin skill holds the loop. The in-repo skill
  `.claude/skills/reviews` says to follow it, but run `npm run reviews --` (source) and
  log the dogfood notes.
- **Release assets.** `make release` also uploads `review-md-<v>.zip`, which unzips to a
  `review-md/` folder for `.obsidian/plugins/`, plus the standalone `reviews.mjs`.
  `make version` bumps the Claude plugin's `plugin.json` in lock-step, and
  `release.mjs` refuses to publish if it disagrees.

## Problems we hit and what we changed

1. **`Dynamic require of "process" is not supported`.** `yaml` is CommonJS, and it
   `require`s node builtins. Inside an ESM bundle that throws at startup. Fix: the
   bundle's banner defines a real `require` with `createRequire(import.meta.url)`.
   It's verified by running the bundle from outside the repo on Node 18.19.
2. **The plugin's `bin/` wasn't on PATH.** The docs say files in a plugin's `bin/`
   are added to the Bash tool's PATH. On Claude Code 2.1.283 with `--plugin-dir`,
   `command -v reviews` found nothing (exit 127). `${CLAUDE_PLUGIN_ROOT}` *is* filled
   in inside SKILL.md, so the skill now names the full path,
   `${CLAUDE_PLUGIN_ROOT}/bin/reviews`, and doesn't rely on PATH. We checked it end to
   end: a fresh `claude -p --plugin-dir plugins/review-md` session used the skill, ran
   the bundled CLI and listed the right waiting thread. The `bin/reviews` shell wrapper
   stays, for when PATH does work.

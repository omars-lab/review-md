# Host decision — Obsidian plugin (confirmed 2026-09-19)

The plan's gate: **build the Obsidian plugin iff POC-1 and POC-4 both pass.** Both passed **live**
in a real Obsidian 1.13.7 instance (not just headlessly), so the decision is settled: **build the
Obsidian plugin.** No pivot to the standalone renderer (POC-5 stays unrun).

| Gate POC | Question | Result | Evidence |
|---|---|---|---|
| **POC-1** | Does `obsidian://review-md` open the right file + jump to a `^block` + call back? | **PASS** | `open 'obsidian://review-md?vault=.dev-vault&file=sample.md&thread=anchor-me'` → `POC-1-report.md` = RESULT: PASS. `docs/pocs/poc-1-protocol.md`. |
| **POC-4** | Does frontmatter storage scale (50 threads) through Obsidian's own serializer? | **PASS** | CLI `eval` ran the seed/verify command → 50/50 threads, 123 msgs, 40 ms, 25.5 KB, unicode OK. Note renders fine (mermaid + footnote native), Properties shows one nested `review` property. `docs/pocs/poc-4-frontmatter.md`. |

## Why this is trustworthy (not just green checks)

- Runs were against a **real Obsidian**, in an **isolated `--user-data-dir` sandbox** that never
  touched the user's config (`docs/issues/obsidian-automation-gate.md`).
- POC-4 used Obsidian's **actual `processFrontMatter`**, so YAML fidelity is the real thing, not the
  headless `yaml` package.
- Usability was **looked at**, not inferred: an in-process `dev:screenshot` confirmed the note stays
  usable with 50 threads in frontmatter.

## Automation harness that made this repeatable

1. `scripts/install-dev.mjs` → symlinks the built plugin into `.dev-vault/.obsidian/plugins/` and
   lists it in `community-plugins.json`.
2. Pre-write `<user-data-dir>/obsidian.json` (vault registry, `open:true`) **before** launch.
3. `Obsidian --user-data-dir=<scratch>` → auto-opens `.dev-vault`.
4. One-time GUI blessing: *Trust author…* + enable **Command line interface** (unscriptable; persists
   in the user-data-dir, so snapshot + reuse for click-free reruns).
5. Drive + verify from the shell: `obsidian-cli eval …` (run commands / assert state),
   `obsidian-cli dev:screenshot …` (in-process capture, no Screen Recording permission),
   `open 'obsidian://review-md?…'` (protocol).

## What's next (per the plan's phased build)

Gate cleared → proceed to **P1 (data layer)** and beyond. Remaining spikes (POC-2 text re-anchoring,
POC-3 image, **POC-6 mermaid augmented render / req 9**) shape *how* comment types work; they don't
gate the host choice.

---
name: reviews
description: >-
  Work the review comments on this repo's own docs (review-md dogfooding): find the open
  threads, act on each, reply on the thread — and log what the `reviews` CLI was missing.
  Use when asked to "address review comments", "what feedback is open", "answer the
  review threads", "what's waiting on me in the docs", "find comments about X", or "reply
  to the comment on <doc>" in the review-md repo. Runs the CLI from source
  (npm run reviews -- …).
---

# reviews (in this repo) — the loop, run from source, plus the dogfood log

The loop itself lives in the Claude Code plugin's skill,
[`plugins/review-md/skills/reviews/SKILL.md`](../../../plugins/review-md/skills/reviews/SKILL.md).
Follow it, with two differences here:

1. **Run the source, not the bundle.** Wherever it says `reviews <command>`, run
   `npm run reviews -- <command>` — that is `scripts/reviews.mjs`, so a change you just
   made is what you're testing. (The plugin ships `plugins/review-md/bin/reviews.mjs`,
   bundled by `make cli`.)
2. **Log the dogfood** in [`notes.md`](notes.md) after each run: one dated line per
   thing that was useful, confusing or missing. Missing features go to
   `docs/backlog.md` too — that's where the next CLI features come from.

---
name: reviews
description: >-
  Work the review comments people left on Markdown docs with review-md: find the open
  threads, act on each (fix the doc, answer the question), and reply on the thread so the
  reviewer sees it. Use when asked to "address review comments", "what feedback is open",
  "answer the review threads", "what's waiting on me in the docs", "find comments about X",
  or "reply to the comment on <doc>". Drives the `reviews` CLI (npm run reviews -- …);
  reading is offline from the clone, replies go through Obsidian.
---

# reviews — work the open review threads

review-md keeps each doc's comment threads in a git-tracked sidecar next to it
(`.<name>.comments.md`). The `reviews` CLI reads those from the clone and answers
through Obsidian, so the plugin stays the only writer. This skill is the loop an
agent runs over them — and a standing dogfood of the CLI: every run, note what
helped and what was missing in [`notes.md`](notes.md).

`npm run reviews -- help` lists the commands; `help <command>` gives flags and examples.
Use the CLI's own help rather than guessing flags.

## The loop

1. **Where is feedback waiting?**
   `npm run reviews -- stats <folder>` — open / resolved / outdated per doc.
2. **What is waiting on me?**
   `npm run reviews -- list <folder> --open --waiting claude` — open threads where
   someone else spoke last. Add `--json` to work through them programmatically; each
   file's `file` is the on-disk path to pass back to `show`/`reply`.
   Looking for one topic: `npm run reviews -- find "<words>" <folder> --open`.
3. **Act on each thread.** Read the anchor (what the thread points at — a passage, a
   diagram node or edge, an image, a link) and the messages. Then either change the doc,
   or answer the question. **OUTDATED** means the doc changed since the thread was
   written — read the current text before answering; the point may already be addressed.
   `reviewed against: <commit>` lets you see what the reviewer saw:
   `git show <commit>:<path>`.
4. **Reply on the thread** with what you did, naming the commit if you changed the doc:
   `npm run reviews -- reply <doc.md> <id> "Reworded in abc123 — …" --author claude`.
   It waits until the reply is in the sidecar: `reply landed on <id>` (exit 0) means
   done; exit 4 means it never arrived — Obsidian not running with that vault open, or
   a dialog in the way. Fix that and send again. `--dry-run` prints the URL without
   sending it. Replies are visible to everyone who reads the doc — keep them factual.
5. **Log the dogfood** in [`notes.md`](notes.md): one dated line per thing that was
   useful, confusing or missing. Missing features go to `docs/backlog.md` as well.

## Don't

- Don't edit sidecars by hand — reply through the CLI so the plugin writes them.
- Don't resolve threads for the reviewer; there is no resolve command, on purpose for
  now (see notes.md). Say it's done in the reply and let them close it.
- Don't reply to a thread you haven't acted on just to clear the queue.

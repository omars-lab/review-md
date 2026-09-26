---
name: reviews
description: >-
  Work the review comments people left on Markdown docs with the review-md Obsidian
  plugin: find the open threads, act on each (fix the doc, answer the question), and
  reply on the thread so the reviewer sees it. Use when asked to "address review
  comments", "what feedback is open", "answer the review threads", "what's waiting on me
  in the docs", "find comments about X", or "reply to the comment on <doc>", or when a
  repo has `.<name>.comments.md` files next to its docs. Drives the `reviews` CLI;
  reading works offline from the clone, replies go through Obsidian.
---

# reviews — work the open review threads

review-md keeps each doc's comment threads in a git-tracked file next to it
(`.<name>.comments.md`). The `reviews` command reads those straight from the clone,
and answers through Obsidian, so the Obsidian plugin stays the only thing that writes
them.

`reviews` is on PATH while this plugin is installed and enabled. If the shell can't
find it (e.g. the plugin was loaded with `--plugin-dir`), run it by its full path,
`${CLAUDE_PLUGIN_ROOT}/bin/reviews`. It needs only Node 18+. `reviews help` lists
the commands and `reviews help <command>` gives flags and examples — check the help
rather than guessing flags.

## The loop

1. **Where is feedback waiting?**
   `reviews stats <folder>` — open / resolved / outdated threads per doc.
2. **What is waiting on me?**
   `reviews list <folder> --open --waiting claude` — open threads where someone else
   spoke last. Add `--json` to work through them one by one; each file's `file` is the
   path on disk to pass back to `show`/`reply`.
   Looking for one topic: `reviews find "<words>" <folder> --open`.
3. **Act on each thread.** Read the anchor (what the thread points at — a passage, a
   diagram node or edge, an image, a link) and the messages. Then change the doc, or
   answer the question. **OUTDATED** means the doc changed since the thread was
   written — read the current text before answering; the point may already be handled.
   `reviewed against: <commit>` shows what the reviewer saw: `git show <commit>:<path>`.
4. **Reply on the thread** with what you did, naming the commit if you changed the doc:
   `reviews reply <doc.md> <id> "Reworded in abc123 — …" --author claude`.
   It waits until the reply is in the comments file: `reply landed on <id>` (exit 0)
   means done; exit 4 means it never arrived — Obsidian isn't running with that vault
   open, or a dialog is in the way. Fix that and send again. `--dry-run` prints the URL
   without sending it. Replies are visible to everyone who reads the doc — keep them
   factual.

Exit codes: 0 OK · 2 bad usage · 3 no comments file / no such thread · 4 Obsidian
didn't take it.

## When there's nothing to read

- `no comments on <doc> yet` — nobody has reviewed that doc. Nothing to do.
- Replies need the review-md Obsidian plugin in the vault. If it isn't installed:
  in Obsidian, install **BRAT**, run **BRAT: Add a beta plugin** with
  `omars-lab/review-md`, then enable **Review MD** — or unzip `review-md-<version>.zip`
  from https://github.com/omars-lab/review-md/releases into
  `<vault>/.obsidian/plugins/`.

## Don't

- Don't edit the `.comments.md` files by hand — reply through `reviews` so the plugin
  writes them.
- Don't resolve threads for the reviewer; there's no resolve command yet. Say it's done
  in the reply and let them close it.
- Don't reply to a thread you haven't acted on just to clear the queue.

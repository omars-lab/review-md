---
name: reviews
description: >-
  Work the review comments people left on Markdown docs with the review-md Obsidian
  plugin: find the open threads, act on each (fix the doc, answer the question), and
  reply on the thread so the reviewer sees it. Use when asked to "address review
  comments", "what feedback is open", "answer the review threads", "what's waiting on me
  in the docs", "find comments about X", "reply to the comment on <doc>", or "review
  <doc> and leave comments", "watch for new comments", "monitor the review threads while
  you work", "tell me when someone comments", or when a
  repo has `.<name>.comments.md` files next to its docs. Drives the `reviews` CLI
  (including `reviews watch`, which streams new comments, replies and resolves as they
  arrive); reading works offline from the clone, replies go through Obsidian.
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
   Checking back later: add `--since 2h` (or a date) to see only threads with new
   messages since then.
3. **Act on each thread.** Read the anchor (what the thread points at — a passage, a
   diagram node or edge, an image, a link) and the messages. Then change the doc, or
   answer the question. **OUTDATED** means the commented passage changed since the
   thread was written (`now reads:` shows it today) — the point may already be handled.
   `reviews diff <doc.md> <id>` prints the passage as the reviewer saw it next to
   today's (`changed` / `unchanged` / `gone`).
4. **Reply on the thread** with what you did, naming the commit if you changed the doc:
   `reviews reply <doc.md> <id> "Reworded in abc123 — …" --author claude`.
   It waits until the reply is in the comments file: `reply landed on <id>` (exit 0)
   means done; exit 4 means it never arrived — Obsidian isn't running with that vault
   open, or a dialog is in the way. Fix that and send again. `--dry-run` prints the URL
   without sending it. Replies are visible to everyone who reads the doc — keep them
   factual.
5. **Close what's done.** When you made the change the thread asked for, add
   `--resolve` to the reply so it stops showing as open. Leave it open when you
   answered a question, pushed back, or aren't sure it's settled — the reviewer
   decides then. `reviews resolve <doc.md> <id>` resolves on its own; `--reopen`
   undoes it.

## Monitoring comments while you work

The loop above finds what was there when you looked. To notice comments a person
leaves *while* you work, run `reviews watch` under a long-running monitor (in Claude
Code, the `Monitor` tool): it keeps running and prints one line per change, and each
line wakes you.

```sh
reviews watch <folder> --exclude-author claude --heartbeat 0
```

- `--exclude-author <you>` — the name you reply as. Without it, every reply you send
  wakes you again. Repeat it (or comma-separate) for several names.
- `--heartbeat 0` — under a monitor every line wakes you, so turn off the
  once-a-minute "still running" line. Leave it on (default 60s) when logging to a file.
- `--replay` — first emit every thread that is already open (`thread_open`), so
  nothing left before the watch started is missed. Without it, start-up prints one
  `watching` line with the counts (`open=3` …); run the loop above for those.

Each line is `<UTC time> pid=<n> ev=<event> file=<path in the vault> thread=<id>
author=<name> msg="<first 200 characters, one line>"` (`--json` for one JSON object
per line, full text). What each event means and what to do:

| event | what happened | what to do |
|---|---|---|
| `thread_new` | someone started a thread (msg = its first message) | `reviews show <doc> <id>`, act, reply |
| `message_new` | a new message on a thread | read it; reply if it's waiting on you |
| `message_edited` | a message's text was changed | re-read it |
| `thread_resolved` / `thread_reopened` | closed / opened again (author only when a message came with it) | reopened = still waiting on someone |
| `anchor_lost` | an open thread's passage, box or arrow is gone from the doc | `reviews diff <doc> <id>`; say where it went |
| `thread_removed` | a thread or its whole comments file was deleted | nothing to answer |
| `file_renamed` | a doc and its comments moved (`from=` old path) | use the new path |
| `parse_retry` | a comments file was caught mid-write | nothing; it's read again next pass |

`file=` is the path inside the vault; the doc on disk is `<vault>/<file>`, which is
what `show`/`reply` take. `heartbeat`, `watching`, `watch_fallback`, `scan_error` and
`stopped` are housekeeping.

Watch is the read side only. Answer through `reviews reply` / `reviews resolve` (or
the `obsidian://review-md-reply` URL) as in the loop, so Obsidian stays the only
writer — and your reply doesn't come back to you as long as you excluded your name.

No long-running process (cron, a scheduled loop): `reviews watch <folder> --once
--state <file>` compares against what the state file saw last time, prints what
changed since, saves the new state and exits. The first run only records.

## Reviewing a doc yourself

Asked to review a doc, leave your points where they apply, as a reviewer would:
`reviews comment <doc.md> "<point>" --quote "<words from the passage>"` — or
`--node <id>` for a diagram box, `--from <id> --to <id>` for an arrow. It prints the
new thread's id once it's in the comments file (exit 4 if it never arrived, as with
reply). One thread per point; don't restate the passage in the message.

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
- Don't resolve a thread you only answered or disagreed with (see step 5).
- Don't reply to a thread you haven't acted on just to clear the queue.

#!/usr/bin/env node
// reviews — the review-md command line: read, search and answer comment threads from
// a shell or an agent, without clicking through Obsidian.
//
// Threads live in git-tracked sidecars `<dir>/.<name>.comments.md` whose YAML
// frontmatter (`review:`) is the source of truth (docs/agent-contract.md). Reading
// commands (list, find, show, stats) parse those files directly and never write.
// `watch` is the long-running reader: it prints one line per new thread, message or
// resolve as they arrive (the diffing lives in src/watch.ts), and never writes either.
// Commands that change or open something (open, reply) go through the plugin's
// obsidian:// URLs, so Obsidian stays the only writer. Markdown output is the same
// digest the plugin's "Copy open threads for AI" command produces (threadsDigest in
// src/pure.ts). Run `reviews help` for the command list.
//
// Exit codes: 0 = OK (even with zero threads), 2 = usage error, 3 = no sidecar /
// thread not found, 4 = couldn't reach Obsidian.

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, renameSync, watch as fsWatch } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, basename, extname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  filterThreads,
  threadsDigest,
  stripFrontmatter,
  stripBlockIds,
  latestTs,
  sinceCutoff,
  anchorContentIn,
  anchorChanged,
  anchorWhere,
  anchorForTarget,
  WORKING_REV,
} from "../src/pure.ts";
import {
  parseSidecar,
  diffSnapshots,
  replayEvents,
  snapshotCounts,
  formatEvent,
  formatLogLine,
} from "../src/watch.ts";

// ---- Hashing: the plugin's sha256Short/bodyHash (src/pure.ts) are async Web Crypto;
// these are the same recipes on node:crypto, pinned equal by test/pure.test.ts.
function sha256Short(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
function bodyHash(text) {
  return sha256Short(stripBlockIds(stripFrontmatter(text)));
}

/** Is a thread outdated, and what does its passage say today? The plugin's rule
 *  (isThreadOutdated), most precise first: the passage stamp (anchorHash); else the
 *  passage in the git version the reviewer saw vs today's; else the whole-doc hash.
 *  So an edit elsewhere in the doc leaves a thread current. `current` is the
 *  anchored text today (null when it's gone), for the digest's "now reads". */
function staleness(t, text, doc) {
  if (text == null || !t.rev) return { outdated: false };
  const anchor = t.anchor ?? {};
  const current = anchorContentIn(text, anchor);
  const withCurrent = (outdated) => (current === undefined ? { outdated } : { outdated, current });
  if (t.rev.anchorHash && current !== undefined) {
    return withCurrent(current === null || sha256Short(current) !== t.rev.anchorHash);
  }
  const git = t.rev.git;
  if (git && git.commit !== WORKING_REV) {
    const thenText = reviewedText(doc, git);
    const changed = thenText == null ? undefined : anchorChanged(thenText, text, anchor);
    if (changed !== undefined) return withCurrent(changed);
  }
  return withCurrent(t.rev.bodyHash ? t.rev.bodyHash !== bodyHash(text) : false);
}

// ---- Sidecar location: MUST match ReviewMdPlugin.sidecarPathFor.
function sidecarPathFor(file) {
  return join(dirname(file), `.${basename(file, extname(file))}.comments.md`);
}
const SIDECAR = /^\.(.+)\.comments\.md$/;
/** Folders never worth walking: git internals, deps, Obsidian's own config/trash. */
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash"]);

/** Every reviewed doc under `root` that has a sidecar, sorted by path. */
function reviewedDocsUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else {
        const m = e.name.match(SIDECAR);
        if (m) out.push(join(dir, `${m[1]}.md`));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Parse one doc's sidecar → { uid, threads } with `outdated` on each thread. */
function readDoc(file) {
  const raw = readFileSync(sidecarPathFor(file), "utf8");
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const review = fmMatch ? parseYaml(fmMatch[1])?.review : null;
  // Missing file or rev → unknown (not flagged stale).
  const text = existsSync(file) ? readFileSync(file, "utf8") : null;
  const threads = (review?.threads ?? []).map((t) => ({
    ...t,
    messages: t.messages ?? [],
    ...staleness(t, text, file),
  }));
  return { uid: review?.uid ?? null, threads };
}

/** The vault a path sits in: the nearest folder up the tree holding `.obsidian/`. */
function vaultRootOf(path) {
  let dir = resolve(existsSync(path) && statSync(path).isDirectory() ? path : dirname(path));
  for (;;) {
    if (existsSync(join(dir, ".obsidian"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Load a doc or a folder into digest files. Folder paths are relative to the vault
 *  root when there is one (so obsidian:// links resolve), else to the folder. */
function load(target, filter) {
  const isDir = existsSync(target) && statSync(target).isDirectory();
  if (!isDir && !existsSync(sidecarPathFor(target))) {
    fail(3, `no comments on ${target} yet (no ${sidecarPathFor(target)})`);
  }
  const root = vaultRootOf(target) ?? (isDir ? resolve(target) : resolve(dirname(target)));
  const docs = isDir ? reviewedDocsUnder(target) : [target];
  return docs.map((file) => {
    const { uid, threads } = readDoc(file);
    return { file, path: relative(root, resolve(file)), uid, threads: filterThreads(threads, filter) };
  });
}

/** Keep threads whose last message isn't by `author` (all of them when no author).
 *  Files keep their slot even when emptied — the digest skips empty ones itself. */
function waitingOn(files, author) {
  if (!author) return files;
  const who = author.toLowerCase();
  return files.map((f) => ({
    ...f,
    threads: f.threads.filter((t) => (t.messages.at(-1)?.author ?? "").toLowerCase() !== who),
  }));
}

/** Keep threads with a message newer than `since` (all of them when not given). */
function activeSince(files, since) {
  if (!since) return files;
  const cutoff = sinceCutoff(since, Date.now());
  if (cutoff === null) fail(2, `--since wants an age like 2h or 3d, or a date like 2026-09-26 (got "${since}")`);
  return files.map((f) => ({ ...f, threads: f.threads.filter((t) => latestTs(t) > cutoff) }));
}

function fail(code, msg) {
  console.error(`reviews: ${msg}`);
  process.exit(code);
}

// ---- Argument parsing: positionals + a fixed set of flags per command.

const VALUE_FLAGS = new Set([
  "text", "vault", "author", "waiting", "since", "quote", "node", "from", "to", "interval", "heartbeat", "state",
]);
/** Value flags that may be given more than once (or comma-separated); collected into an array. */
const LIST_FLAGS = new Set(["exclude-author"]);
const BOOL_FLAGS = new Set(["open", "unresolved", "json", "dry-run", "help", "resolve", "reopen", "replay", "once"]);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        if (argv[i + 1] === undefined) fail(2, `--${name} needs a value`);
        flags[name] = argv[++i];
      } else if (LIST_FLAGS.has(name)) {
        if (argv[i + 1] === undefined) fail(2, `--${name} needs a value`);
        const vals = argv[++i].split(",").map((v) => v.trim()).filter(Boolean);
        flags[name] = [...(flags[name] ?? []), ...vals];
      } else if (BOOL_FLAGS.has(name)) flags[name] = true;
      else fail(2, `unknown flag --${name} (see: reviews help)`);
    } else pos.push(a);
  }
  return { flags, pos };
}

/** The vault name for obsidian:// links: --vault, else the vault folder's name. */
function vaultName(target, flags) {
  if (flags.vault) return flags.vault;
  const root = vaultRootOf(target);
  if (!root) fail(2, `can't tell which vault ${target} is in (no .obsidian/ above it) — pass --vault <name>`);
  return basename(root);
}

/** Hand a URL to Obsidian (macOS `open`), or just print it with --dry-run. */
function openUrl(url, flags) {
  if (flags["dry-run"]) {
    process.stdout.write(url + "\n");
    return;
  }
  try {
    execFileSync("open", [url], { stdio: "inherit", timeout: 10_000 });
    process.stdout.write(`sent to Obsidian: ${url}\n`);
  } catch (err) {
    fail(4, `couldn't open the URL (is Obsidian installed?): ${err.message}`);
  }
}

const url = (action, params) =>
  `obsidian://${action}?${new URLSearchParams(params).toString().replace(/\+/g, "%20")}`;

/** The doc as the reviewer saw it: the stamped blob (survives renames), else the
 *  file at the stamped commit. null when git can't produce it. Cached, since many
 *  threads on a doc share one reviewed version. */
const reviewedCache = new Map();
function reviewedText(doc, git) {
  const key = `${resolve(doc)}\0${git.blob ?? ""}\0${git.commit}`;
  if (!reviewedCache.has(key)) reviewedCache.set(key, readReviewed(doc, git));
  return reviewedCache.get(key);
}
function readReviewed(doc, git) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", dirname(resolve(doc)), ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
  return (git.blob && run(["cat-file", "-p", git.blob])) ?? run(["show", `${git.commit}:./${basename(doc)}`]);
}

// ---- Commands

const COMMANDS = {
  list: {
    usage:
      "reviews list <doc.md | folder> [--open] [--text <words>] [--waiting <name>] [--since <age|date>] [--vault <name>] [--json]",
    summary: "Print the threads on a doc, or every doc under a folder",
    help: `Prints each thread: where it's anchored, open/resolved, OUTDATED when the doc
changed since it was written, the version it was written against, and every message.

  --open            open threads only (--unresolved works too)
  --text <words>    only threads whose messages, authors or anchor contain the words
  --waiting <name>  only threads where <name> didn't write the last message — what's
                    waiting on you (e.g. --waiting claude)
  --since <when>    only threads with a message since then: an age (30m, 2h, 3d, 1w)
                    or a date (2026-09-26, 2026-09-26T09:00Z) — what's new since
                    you last looked
  --vault <name>    add open/reply obsidian:// links per thread (the name is found
                    automatically when the folder has a .obsidian/ above it)
  --json            JSON instead of Markdown. A single doc gives
                    { uid, file, vaultPath, threads }; a folder gives
                    { root, files: [{ file, vaultPath, uid, threads }] }. \`file\` is the
                    path on disk (pass it back to show/reply); vaultPath is Obsidian's.

Examples:
  reviews list docs/designs/design.md --open
  reviews list docs --open --vault docs
  reviews list docs --since 1d`,
    run({ flags, pos }) {
      const target = pos[0];
      if (!target) fail(2, `usage: ${this.usage}`);
      const filter = { includeResolved: !(flags.open || flags.unresolved), text: flags.text };
      const files = activeSince(waitingOn(load(target, filter), flags.waiting), flags.since);
      if (flags.json) return printJson(target, files);
      const vault = flags.vault ?? (vaultRootOf(target) ? basename(vaultRootOf(target)) : undefined);
      process.stdout.write(threadsDigest(files, { scope: target, filter, vault }));
    },
  },

  find: {
    usage: "reviews find <words> [folder] [--open] [--waiting <name>] [--since <age|date>] [--json]",
    summary: "Find threads mentioning some text, across a folder (default: here)",
    help: `Case-insensitive search over message bodies, authors and what the thread is
anchored to — the same match as the panel's search box. Resolved threads are
included (marked "resolved") unless --open. --waiting and --since work as in list.

Examples:
  reviews find frontmatter docs
  reviews find "claude" --open`,
    run({ flags, pos }) {
      const [words, target = "."] = pos;
      if (!words) fail(2, `usage: ${this.usage}`);
      const filter = { includeResolved: !flags.open, text: words };
      const files = activeSince(waitingOn(load(target, filter), flags.waiting), flags.since);
      if (flags.json) return printJson(target, files);
      const vault = vaultRootOf(target) ? basename(vaultRootOf(target)) : undefined;
      process.stdout.write(threadsDigest(files, { scope: target, filter, vault }));
    },
  },

  show: {
    usage: "reviews show <doc.md> <thread-id> [--json]",
    summary: "Print one thread in full",
    help: `Prints one thread, with its open and reply links when the doc is in a vault.

Example:
  reviews show docs/designs/design.md d1a2b3`,
    run({ flags, pos }) {
      const [doc, id] = pos;
      if (!doc || !id) fail(2, `usage: ${this.usage}`);
      const [f] = load(doc, { includeResolved: true });
      const t = f.threads.find((x) => x.id === id);
      if (!t) fail(3, `no thread ${id} on ${doc} (try: reviews list ${doc})`);
      if (flags.json) return process.stdout.write(JSON.stringify({ file: f.path, ...t }, null, 2) + "\n");
      const vault = vaultRootOf(doc) ? basename(vaultRootOf(doc)) : undefined;
      process.stdout.write(
        threadsDigest([{ ...f, threads: [t] }], { scope: `${f.path} · ${id}`, filter: { includeResolved: !!t.resolved }, vault }),
      );
    },
  },

  diff: {
    usage: "reviews diff <doc.md> <thread-id> [--json]",
    summary: "The commented passage as the reviewer saw it, next to today's",
    help: `Pulls the doc as the reviewer saw it from git and prints just the commented
passage (or diagram box, arrow, image, link) then and now, so you can tell whether
the point was already handled: changed, unchanged, or gone. Read-only; the "then"
side needs the doc in a git clone.

Example:
  reviews diff docs/designs/design.md d1a2b3`,
    run({ flags, pos }) {
      const [doc, id] = pos;
      if (!doc || !id) fail(2, `usage: ${this.usage}`);
      const [f] = load(doc, { includeResolved: true });
      const t = f.threads.find((x) => x.id === id);
      if (!t) fail(3, `no thread ${id} on ${doc} (try: reviews list ${doc})`);
      const anchor = t.anchor ?? {};
      const git = t.rev?.git;
      const missing = !git
        ? "the doc wasn't in git when the comment was written"
        : git.commit === WORKING_REV
          ? "the comment was written on uncommitted edits"
          : null;
      const thenText = missing ? null : reviewedText(doc, git);
      const why = missing ?? (thenText == null ? `git can't find ${git.commit} here` : null);
      const then = thenText == null ? undefined : anchorContentIn(thenText, anchor);
      const now = existsSync(doc) ? anchorContentIn(readFileSync(doc, "utf8"), anchor) : null;
      const state =
        now === null ? "gone" : then === undefined || now === undefined ? "unknown" : then === now ? "unchanged" : "changed";
      if (flags.json) {
        const out = { file: f.path, id, commit: git?.commit ?? null, state, then: then ?? null, now: now ?? null };
        return process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      }
      const say = (v) => (v === null ? "(not in the doc)" : v === undefined ? "(can't pin this anchor down)" : `“${v}”`);
      process.stdout.write(
        [
          `[${id}] ${anchorWhere(anchor)} — ${state}`,
          `then (${git?.commit ?? "no commit"}): ${why ? `(unavailable: ${why})` : say(then)}`,
          `now: ${say(now)}`,
        ].join("\n") + "\n",
      );
    },
  },

  stats: {
    usage: "reviews stats [folder] [--json]",
    summary: "Count open, resolved and outdated threads per doc",
    help: `One row per doc with comments, plus a total — a quick "where is review
feedback waiting?" before diving in.

Example:
  reviews stats docs`,
    run({ flags, pos }) {
      const target = pos[0] ?? ".";
      const rows = load(target, { includeResolved: true }).map((f) => ({
        file: f.path,
        open: f.threads.filter((t) => !t.resolved).length,
        resolved: f.threads.filter((t) => t.resolved).length,
        outdated: f.threads.filter((t) => !t.resolved && t.outdated).length,
      }));
      if (flags.json) return process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      const total = rows.reduce(
        (s, r) => ({ open: s.open + r.open, resolved: s.resolved + r.resolved, outdated: s.outdated + r.outdated }),
        { open: 0, resolved: 0, outdated: 0 },
      );
      const lines = ["| doc | open | resolved | open + outdated |", "|---|---|---|---|"];
      for (const r of rows) lines.push(`| ${r.file} | ${r.open} | ${r.resolved} | ${r.outdated} |`);
      lines.push(`| **total** | ${total.open} | ${total.resolved} | ${total.outdated} |`);
      process.stdout.write(lines.join("\n") + "\n");
    },
  },

  watch: {
    usage:
      "reviews watch [folder] [--exclude-author <name>]... [--replay] [--interval <s>] [--heartbeat <s>] [--json] [--once --state <file>]",
    summary: "Print a line as each new comment, reply or resolve arrives",
    help: `Keeps running and prints one line per change to the threads under the folder
(default: here), so an agent under a long-running monitor wakes when someone
comments. Read-only: it never writes a comments file.

On start it prints one "watching" line with the counts; it does not replay what's
already there unless --replay. Then one line per event:

  thread_new       a thread was started            (author, first message)
  message_new      a new message on a thread       (author, the message)
  message_edited   a message's text changed
  thread_resolved  a thread was resolved           (author when a message just came with it)
  thread_reopened  a resolved thread was opened again
  anchor_lost      an open thread's passage, box or arrow is gone from the doc
  thread_removed   a thread, or its whole comments file, was deleted
  file_renamed     a doc and its comments moved   (from = the old path)
  thread_open      --replay only: a thread already open when the watch started

Each line: <UTC time> pid=<n> ev=<event> file=<path in the vault> thread=<id>
author=<name> msg="<text, one line, cut at 200 characters>". Housekeeping lines use
the same shape: watching, heartbeat, parse_retry (a comments file caught mid-write —
read again next pass, never reported as removed), watch_fallback, scan_error,
stopped.

  --exclude-author <name>  drop events by this author — your own replies (repeat,
                           or comma-separate, for several)
  --replay                 first emit every open thread (thread_open), so nothing
                           left before the watch started is missed
  --interval <s>           poll every <s> seconds as well as listening for file
                           changes (default 5; the listener misses synced and renamed
                           files on macOS, the poll doesn't)
  --heartbeat <s>          a heartbeat line every <s> seconds (default 60; 0 = none)
  --json                   one JSON object per line instead (msg not cut)
  --once --state <file>    no long-running process: compare against the state file,
                           print what changed since, save the new state, exit. The
                           first run only records (and prints the watching line).

Stops cleanly on Ctrl-C / SIGTERM. Exit 2 on bad usage.

Examples:
  reviews watch docs --exclude-author claude
  reviews watch docs --exclude-author claude --replay --heartbeat 0
  reviews watch docs --once --state .reviews-watch.json   # from cron or a loop`,
    run({ flags, pos }) {
      const target = pos[0] ?? ".";
      if (!existsSync(target) || !statSync(target).isDirectory()) fail(2, `watch wants a folder (got "${target}")`);
      const num = (name, dflt, min) => {
        if (flags[name] === undefined) return dflt;
        const n = Number(flags[name]);
        if (!Number.isFinite(n) || n < min) fail(2, `--${name} wants a number of seconds${min > 0 ? " above 0" : ""} (got "${flags[name]}")`);
        return n;
      };
      const opts = {
        exclude: flags["exclude-author"] ?? [],
        interval: num("interval", 5, 0.05),
        heartbeat: num("heartbeat", 60, 0),
        json: !!flags.json,
        replay: !!flags.replay,
      };
      if (opts.interval <= 0) fail(2, "--interval must be above 0");
      if (flags.once) {
        if (!flags.state) fail(2, "--once needs --state <file> to remember what it saw last time");
        return watchOnce(target, flags.state, opts);
      }
      if (flags.state) fail(2, "--state goes with --once");
      watchLive(target, opts);
    },
  },

  open: {
    usage: "reviews open <doc.md> [thread-id] [--vault <name>] [--dry-run]",
    summary: "Open a doc in Obsidian, focused on a thread",
    help: `Sends obsidian://review-md-open to Obsidian. The path is taken relative to the
vault (the nearest folder with .obsidian/ above it). --dry-run prints the URL instead.

Example:
  reviews open docs/designs/design.md d1a2b3`,
    run({ flags, pos }) {
      const [doc, thread] = pos;
      if (!doc) fail(2, `usage: ${this.usage}`);
      openUrl(url("review-md-open", { vault: vaultName(doc, flags), file: vaultPath(doc), ...(thread ? { thread } : {}) }), flags);
    },
  },

  reply: {
    usage: "reviews reply <doc.md> <thread-id> <message> [--author <name>] [--resolve] [--vault <name>] [--dry-run]",
    summary: "Reply to a thread (through Obsidian, which stays the only writer)",
    help: `Sends obsidian://review-md-reply, so the reply is written by the plugin exactly as
if typed in the panel. The author defaults to "claude". Checks the thread exists
first, then waits (up to 10s) until the reply shows up in the sidecar — exit 0 means
it landed, exit 4 means it didn't (Obsidian closed, vault not open, a dialog in the
way). --resolve also resolves the thread once the reply is in. --dry-run prints the
URL and sends nothing.

Examples:
  reviews reply docs/designs/design.md d1a2b3 "Moved to the sidecar in 3f82635." --author claude
  reviews reply docs/designs/design.md d1a2b3 "Fixed in 3f82635." --resolve`,
    run({ flags, pos }) {
      const [doc, id, ...words] = pos;
      const body = words.join(" ");
      if (!doc || !id || !body) fail(2, `usage: ${this.usage}`);
      const [f] = load(doc, { includeResolved: true });
      const before = f.threads.find((t) => t.id === id);
      if (!before) fail(3, `no thread ${id} on ${doc} (try: reviews list ${doc})`);
      const vault = vaultName(doc, flags);
      openUrl(
        url("review-md-reply", { vault, file: vaultPath(doc), thread: id, author: flags.author ?? "claude", body }),
        flags,
      );
      if (flags["dry-run"]) {
        if (flags.resolve) setResolved(doc, id, true, vault, flags);
        return;
      }
      // The URL is fire-and-forget; the sidecar is the truth. Wait for the new message.
      const landed = () => {
        const t = readDoc(doc).threads.find((x) => x.id === id);
        return t && t.messages.length > before.messages.length && t.messages.at(-1).body === body;
      };
      if (!waitFor(landed, 10_000)) {
        fail(4, `reply to ${id} didn't land in 10s — is Obsidian running with vault "${vault}" open, and no dialog in the way?`);
      }
      process.stdout.write(`reply landed on ${id}\n`);
      if (flags.resolve) setResolved(doc, id, true, vault, flags);
    },
  },

  comment: {
    usage:
      "reviews comment <doc.md> <message> (--quote <words> | --node <id> | --from <id> --to <id>) [--author <name>] [--vault <name>] [--dry-run]",
    summary: "Start a thread on a passage, diagram box or arrow (through Obsidian)",
    help: `Sends obsidian://review-md-comment, so the plugin writes the thread exactly as if a
reviewer had clicked there. Say what to comment on with one of:
  --quote <words>       the first passage or heading containing these words
  --node <id>           a diagram box, by its mermaid id
  --from <id> --to <id> a diagram arrow
The target is checked against the doc first (exit 3 if it isn't there). A passage gets
a ^id written at its end, as when commenting by hand. Waits (up to 10s) for the thread
to show up in the comments file and prints its id; exit 4 means it didn't land. The
author defaults to "claude". --dry-run prints the URL and sends nothing.

Examples:
  reviews comment docs/designs/design.md "Say what happens on timeout." --quote "retries the export"
  reviews comment docs/designs/design.md "Who owns this box?" --node Plugin
  reviews comment docs/designs/design.md "Is this sync or async?" --from Plugin --to Sidecar`,
    run({ flags, pos }) {
      const [doc, ...words] = pos;
      const body = words.join(" ");
      if (!doc || !body) fail(2, `usage: ${this.usage}`);
      if (!existsSync(doc)) fail(3, `no such doc: ${doc}`);
      const target = { quote: flags.quote, node: flags.node, from: flags.from, to: flags.to };
      if (!target.quote && !target.node && !target.from && !target.to) fail(2, `say what to comment on — usage: ${this.usage}`);
      if (!!target.from !== !!target.to) fail(2, "an arrow needs both --from and --to");
      const anchor = anchorForTarget(readFileSync(doc, "utf8"), target);
      if (typeof anchor === "string") fail(3, anchor);
      const vault = vaultName(doc, flags);
      const params = { vault, file: vaultPath(doc), author: flags.author ?? "claude", body };
      for (const k of ["quote", "node", "from", "to"]) if (target[k]) params[k] = target[k];
      const ids = () => (existsSync(sidecarPathFor(doc)) ? readDoc(doc).threads.map((t) => t.id) : []);
      const before = new Set(ids());
      openUrl(url("review-md-comment", params), flags);
      if (flags["dry-run"]) return;
      let started;
      const landed = () => (started = ids().find((id) => !before.has(id)));
      if (!waitFor(landed, 10_000)) {
        fail(4, `the thread didn't land in 10s — is Obsidian running with vault "${vault}" open, and no dialog in the way?`);
      }
      process.stdout.write(`${started} started on ${anchorWhere(anchor)}\n`);
    },
  },

  resolve: {
    usage: "reviews resolve <doc.md> <thread-id> [--reopen] [--vault <name>] [--dry-run]",
    summary: "Resolve a thread, or reopen it (through Obsidian)",
    help: `Sends obsidian://review-md-resolve and waits (up to 10s) until the sidecar shows the
new state — exit 0 means it's stored, exit 4 means it didn't land. Resolve a thread once
it's answered or fixed, so it stops showing as open. --reopen opens it again.
To answer and close in one go: reviews reply <doc> <id> "<message>" --resolve.

Examples:
  reviews resolve docs/designs/design.md d1a2b3
  reviews resolve docs/designs/design.md d1a2b3 --reopen`,
    run({ flags, pos }) {
      const [doc, id] = pos;
      if (!doc || !id) fail(2, `usage: ${this.usage}`);
      const [f] = load(doc, { includeResolved: true });
      if (!f.threads.some((t) => t.id === id)) fail(3, `no thread ${id} on ${doc} (try: reviews list ${doc})`);
      setResolved(doc, id, !flags.reopen, vaultName(doc, flags), flags);
    },
  },

  help: {
    usage: "reviews help [command]",
    summary: "Show the commands, or one command in detail",
    help: "",
    run({ pos }) {
      const cmd = pos[0] && COMMANDS[pos[0]];
      if (pos[0] && !cmd) fail(2, `no command "${pos[0]}" (see: reviews help)`);
      process.stdout.write(cmd ? commandHelp(pos[0]) : overview());
    },
  },
};

/** Poll `check` every 250ms until it's true or `ms` pass. Synchronous on purpose:
 *  the CLI is one-shot, and Atomics.wait sleeps without a busy loop. */
function waitFor(check, ms) {
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (const end = Date.now() + ms; Date.now() < end; Atomics.wait(tick, 0, 0, 250)) {
    try {
      if (check()) return true;
    } catch {
      // Sidecar mid-write — try again next tick.
    }
  }
  return false;
}

/** Send review-md-resolve and wait until the sidecar shows the new state. */
function setResolved(doc, id, resolved, vault, flags) {
  openUrl(url("review-md-resolve", { vault, file: vaultPath(doc), thread: id, state: resolved ? "resolved" : "open" }), flags);
  if (flags["dry-run"]) return;
  const landed = () => readDoc(doc).threads.find((x) => x.id === id)?.resolved === resolved;
  if (!waitFor(landed, 10_000)) {
    fail(4, `${id} didn't change in 10s — is Obsidian running with vault "${vault}" open, and no dialog in the way?`);
  }
  process.stdout.write(`${id} ${resolved ? "resolved" : "reopened"}\n`);
}

// ---- watch: the I/O half (walking, fs.watch, polling, the clock). The diffing and
// line formats are pure, in src/watch.ts.

/** Reads every sidecar under `target` into a snapshot (vault-relative doc path →
 *  { uid, threads }), re-reading a sidecar and its doc only when either's size or
 *  mtime moved. A sidecar that doesn't parse is listed in `unreadable` and not
 *  cached, so the next pass tries it again. */
function makeScanner(target) {
  const root = vaultRootOf(target) ?? resolve(target);
  const cache = new Map(); // doc path → { stamp, doc }
  const stampOf = (p) => {
    try {
      const st = statSync(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "-";
    }
  };
  return () => {
    const snapshot = {};
    const unreadable = [];
    for (const file of reviewedDocsUnder(target)) {
      const key = relative(root, resolve(file));
      const side = sidecarPathFor(file);
      const stamp = `${stampOf(side)}|${stampOf(file)}`;
      const hit = cache.get(key);
      if (hit?.stamp === stamp) {
        snapshot[key] = hit.doc;
        continue;
      }
      let raw;
      try {
        raw = readFileSync(side, "utf8");
      } catch (err) {
        if (err.code === "ENOENT") continue; // gone since the walk: missing, not torn
        unreadable.push({ key, stamp, why: err.code ?? err.message });
        continue;
      }
      const doc = parseSidecar(raw, parseYaml);
      if (!doc) {
        unreadable.push({ key, stamp, why: raw.length ? "not valid review frontmatter yet" : "empty" });
        continue;
      }
      let text = null;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        // No doc (renamed away, or never there): anchors count as not lost.
      }
      // Lost = the passage/box/arrow is gone (anchorContentIn → null). No doc, or an
      // anchor that can't be pinned down, is not lost.
      for (const t of doc.threads) if (!t.resolved && text != null && anchorContentIn(text, t.anchor) === null) t.lost = true;
      cache.set(key, { stamp, doc });
      snapshot[key] = doc;
    }
    for (const key of cache.keys()) if (!(key in snapshot)) cache.delete(key);
    return { root, snapshot, unreadable };
  };
}

/** Line writer for watch: text (formatLogLine) or --json, timestamped in UTC. A
 *  closed stdout (the monitor went away) ends the watch quietly. */
function makeEmitter(json) {
  const pid = process.pid;
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const out = (line) => process.stdout.write(line + "\n");
  return {
    event(e) {
      const ts = new Date().toISOString();
      out(json ? JSON.stringify({ ts, pid, ...e }) : formatEvent(e, ts, pid));
    },
    log(ev, fields = {}) {
      const ts = new Date().toISOString();
      out(json ? JSON.stringify({ ts, pid, ev, ...fields }) : formatLogLine(ts, pid, ev, fields));
    },
  };
}

/** Log a sidecar that didn't parse — once per version of it, so a file left broken
 *  doesn't print (and wake a monitor) on every poll. */
function makeRetryLogger(emit) {
  const told = new Map(); // key → stamp already reported
  return (unreadable) => {
    for (const u of unreadable) {
      if (told.get(u.key) === u.stamp) continue;
      told.set(u.key, u.stamp);
      emit.log("parse_retry", { file: u.key, msg: u.why });
    }
    const now = new Set(unreadable.map((u) => u.key));
    for (const key of told.keys()) if (!now.has(key)) told.delete(key);
  };
}

function watchLive(target, opts) {
  const emit = makeEmitter(opts.json);
  const scan = makeScanner(target);
  const reportRetries = makeRetryLogger(emit);
  const exclude = opts.exclude.length ? opts.exclude.join(",") : undefined;

  const first = scan();
  let state = diffSnapshots({}, first.snapshot, { unreadable: first.unreadable.map((u) => u.key) });
  let snapshot = state.snapshot;
  let missing = [];

  // fs.watch wakes a pass early; the poll is the guarantee. Either may be missing.
  let watcher = null;
  let debounce = null;
  const passSoon = () => {
    clearTimeout(debounce);
    debounce = setTimeout(pass, 250);
  };
  try {
    watcher = fsWatch(target, { recursive: true }, (_type, name) => {
      if (!name || /\.md$/.test(String(name))) passSoon();
    });
    watcher.on("error", (err) => {
      emit.log("watch_fallback", { msg: `file listener failed, polling only: ${err.message}` });
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    emit.log("watch_fallback", { msg: `no file listener here, polling only: ${err.message}` });
  }

  const counts = snapshotCounts(snapshot);
  emit.log("watching", {
    root: first.root,
    folder: target,
    ...counts,
    interval: opts.interval,
    heartbeat: opts.heartbeat,
    fswatch: watcher ? "on" : "off",
    exclude,
    replay: opts.replay ? "on" : undefined,
  });
  reportRetries(first.unreadable);
  if (opts.replay) for (const e of replayEvents(snapshot, { exclude: opts.exclude })) emit.event(e);

  function pass() {
    let read;
    try {
      read = scan();
    } catch (err) {
      emit.log("scan_error", { msg: err.message });
      return;
    }
    reportRetries(read.unreadable);
    const d = diffSnapshots(snapshot, read.snapshot, {
      exclude: opts.exclude,
      unreadable: read.unreadable.map((u) => u.key),
      missing,
      now: Date.now(),
    });
    snapshot = d.snapshot;
    missing = d.missing;
    for (const e of d.events) emit.event(e);
  }

  const poll = setInterval(pass, opts.interval * 1000);
  const beat = opts.heartbeat > 0 ? setInterval(() => emit.log("heartbeat", snapshotCounts(snapshot)), opts.heartbeat * 1000) : null;
  const stop = (signal) => {
    clearInterval(poll);
    if (beat) clearInterval(beat);
    clearTimeout(debounce);
    watcher?.close();
    emit.log("stopped", { signal });
    process.exitCode = 0;
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

/** `--once`: diff against the state file, print, save the new state, exit. The
 *  state file is the only thing watch ever writes, and only where you point it. */
function watchOnce(target, statePath, opts) {
  const emit = makeEmitter(opts.json);
  const read = makeScanner(target)();
  let saved = null;
  if (existsSync(statePath)) {
    try {
      saved = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (err) {
      fail(2, `can't read the state file ${statePath} (${err.message}) — delete it to start over`);
    }
  }
  const unreadable = read.unreadable.map((u) => u.key);
  for (const u of read.unreadable) emit.log("parse_retry", { file: u.key, msg: u.why });
  let next;
  if (!saved) {
    next = diffSnapshots({}, read.snapshot, { unreadable });
    emit.log("watching", { root: read.root, folder: target, ...snapshotCounts(next.snapshot), state: statePath, first: "yes" });
    if (opts.replay) for (const e of replayEvents(next.snapshot, { exclude: opts.exclude })) emit.event(e);
  } else {
    next = diffSnapshots(saved.snapshot ?? {}, read.snapshot, {
      exclude: opts.exclude,
      unreadable,
      missing: saved.missing ?? [],
      now: Date.now(),
    });
    for (const e of next.events) emit.event(e);
  }
  const tmp = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ root: read.root, at: new Date().toISOString(), snapshot: next.snapshot, missing: next.missing }) + "\n");
  renameSync(tmp, statePath);
}

/** A doc's path inside its vault, for obsidian:// URLs. */
function vaultPath(doc) {
  const root = vaultRootOf(doc);
  return root ? relative(root, resolve(doc)) : doc;
}

function printJson(target, files) {
  const isDir = existsSync(target) && statSync(target).isDirectory();
  // `file` is always the on-disk path, so it can be passed straight back to
  // `show`/`reply`; `vaultPath` is the same doc as Obsidian (and the links) name it.
  const out = isDir
    ? { root: target, files: files.map(({ file, path, uid, threads }) => ({ file, vaultPath: path, uid, threads })) }
    : { uid: files[0].uid, file: files[0].file, vaultPath: files[0].path, threads: files[0].threads };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

function overview() {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  return [
    "reviews — read, search and answer review-md comment threads",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(width)}  ${c.summary}`),
    "",
    "Run `reviews help <command>` (or `reviews <command> --help`) for details.",
    "Reading commands (watch too) never write; open and reply go through Obsidian.",
    "",
  ].join("\n");
}

function commandHelp(name) {
  const c = COMMANDS[name];
  return `${c.usage}\n\n${c.summary}.${c.help ? `\n\n${c.help}` : ""}\n`;
}

function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === "-h" || name === "--help") return process.stdout.write(overview());
  const cmd = COMMANDS[name];
  if (!cmd) fail(2, `no command "${name}" (see: reviews help)`);
  const args = parseArgs(rest);
  if (args.flags.help) return process.stdout.write(commandHelp(name));
  cmd.run(args);
}

main();

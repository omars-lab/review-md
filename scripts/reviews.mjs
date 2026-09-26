#!/usr/bin/env node
// reviews — the review-md command line: read, search and answer comment threads from
// a shell or an agent, without clicking through Obsidian.
//
// Threads live in git-tracked sidecars `<dir>/.<name>.comments.md` whose YAML
// frontmatter (`review:`) is the source of truth (docs/agent-contract.md). Reading
// commands (list, find, show, stats) parse those files directly and never write.
// Commands that change or open something (open, reply) go through the plugin's
// obsidian:// URLs, so Obsidian stays the only writer. Markdown output is the same
// digest the plugin's "Copy open threads for AI" command produces (threadsDigest in
// src/pure.ts). Run `reviews help` for the command list.
//
// Exit codes: 0 = OK (even with zero threads), 2 = usage error, 3 = no sidecar /
// thread not found, 4 = couldn't reach Obsidian.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
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
  WORKING_REV,
} from "../src/pure.ts";

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

const VALUE_FLAGS = new Set(["text", "vault", "author", "waiting", "since"]);
const BOOL_FLAGS = new Set(["open", "unresolved", "json", "dry-run", "help", "resolve", "reopen"]);

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
    "Reading commands never write; open and reply go through Obsidian.",
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

#!/usr/bin/env node
// reanchor-comments — post-commit re-anchoring of working-copy comment threads (#42).
//
// review-md's workflow (see docs/issues/reanchor-hook.md): editing + committing
// happen in the CLI (usually a Claude Code session), reviewing happens in Obsidian.
// A thread authored in Obsidian against the *uncommitted* working copy is stamped
// with the WORKING_REV sentinel ("working") + the working-tree blob. When the CLI
// later commits that file, THIS script — run as a post-commit hook — re-anchors the
// thread to the landed commit. The plugin can't: it isn't running when the CLI commits.
//
// Mechanism (a pure lookup, per the verified invariant that a dirty file's
// `git hash-object` blob == HEAD:<path> once committed verbatim):
//   for each thread with rev.git.commit == "working":
//     if rev.git.blob == HEAD:<reviewed-path>:
//        rev.git.commit = last commit that touched <reviewed-path>   # blob unchanged
//
// It rewrites ONLY the sidecar frontmatter (the source of truth); the generated
// body carries no commit info, so it's left byte-for-byte untouched. The rewritten
// sidecar is left as an UNSTAGED working change for the same session to commit —
// post-commit can't stage into the commit that already happened, and amending would
// rewrite history (see the issue doc). Idempotent: a second run finds nothing.
//
// Usage:
//   node scripts/reanchor-comments.mjs [--dry-run] [--quiet]
//   (no args → walk every *.comments.md sidecar git knows about: tracked OR
//    untracked-but-not-ignored — a new sidecar is often still untracked when the
//    reviewed file is committed. Gitignored sidecars are skipped, and their
//    ignored reviewed file has no HEAD blob to match anyway.)
//
// Exit codes: 0 = ran OK (whether or not anything changed), 1 = unexpected error.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const WORKING_REV = "working"; // MUST match src/main.ts WORKING_REV
const GIT_TIMEOUT_MS = 4000; // bound each git call so a hung repo can't freeze the hook

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const dryRun = flags.has("--dry-run");
const quiet = flags.has("--quiet");

/** Run a git command, returning trimmed stdout, or null on any failure. */
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

/** A sidecar `<dir>/.<name>.comments.md` reviews `<dir>/<name>.md` (review-md is
 *  markdown-only; the reviewed extension isn't encoded in the sidecar name, so we
 *  assume `.md` and verify the file is actually committed before using it). */
function reviewedPathFor(sidecar) {
  const dir = dirname(sidecar);
  const name = basename(sidecar).replace(/^\./, "").replace(/\.comments\.md$/, "");
  return join(dir === "." ? "" : dir, `${name}.md`);
}

/** Split a sidecar into { yaml, body }, where `body` starts at the closing `---`
 *  fence and runs to EOF. Returns null if there's no leading `---` frontmatter.
 *  The body is preserved verbatim on rewrite — we never regenerate it. */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n(---[\s\S]*)$/);
  if (!m) return null;
  return { yaml: m[1], body: m[2] }; // body = `---` fence + everything after
}

function main() {
  // Tracked (--cached) plus untracked-not-ignored (--others --exclude-standard):
  // a freshly-created sidecar may not be committed yet when the reviewed file lands.
  const listing = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listing == null) {
    if (!quiet) console.error("[reanchor] not a git work tree — skipping");
    return;
  }
  const sidecars = listing
    .split("\0")
    .filter((p) => p && /(^|\/)\.[^/]+\.comments\.md$/.test(p));

  let reanchored = 0;
  for (const sidecar of sidecars) {
    if (!existsSync(sidecar)) continue;
    let raw;
    try {
      raw = readFileSync(sidecar, "utf8");
    } catch (err) {
      console.error(`[reanchor] cannot read ${sidecar}: ${err.message} — skipping`);
      continue;
    }
    const split = splitFrontmatter(raw);
    if (!split) continue;

    let review;
    try {
      review = parseYaml(split.yaml)?.review;
    } catch (err) {
      console.error(`[reanchor] bad frontmatter in ${sidecar}: ${err.message} — skipping`);
      continue;
    }
    const threads = review?.threads;
    if (!Array.isArray(threads)) continue;

    const working = threads.filter((t) => t?.rev?.git?.commit === WORKING_REV);
    if (!working.length) continue;

    const reviewed = reviewedPathFor(sidecar);
    const headBlob = git(["rev-parse", `HEAD:${reviewed}`]); // null if not committed
    if (!headBlob) continue; // reviewed file not in HEAD yet → threads stay "working"

    let changed = false;
    for (const t of working) {
      if (t.rev.git.blob !== headBlob) continue; // committed content differs from what was reviewed
      const commit = git(["rev-list", "-1", "--abbrev-commit", "HEAD", "--", reviewed]);
      if (!commit) continue;
      if (!dryRun) t.rev.git.commit = commit; // blob already equals headBlob — leave it
      changed = true;
      reanchored++;
      if (!quiet) console.log(`[reanchor] ${sidecar}: thread ${t.id} → ${commit} (was working copy)`);
    }
    if (!changed || dryRun) continue;

    // Rewrite ONLY the frontmatter; preserve the generated body verbatim.
    const fm = stringifyYaml({ review }).trimEnd();
    writeFileSync(sidecar, `---\n${fm}\n${split.body}`, "utf8");
  }

  if (!quiet && reanchored > 0) {
    console.log(
      `[reanchor] ${reanchored} thread(s) re-anchored${dryRun ? " (dry run — nothing written)" : ""}` +
        (dryRun ? "" : " — commit the updated sidecar(s) to record it"),
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`[reanchor] unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
}

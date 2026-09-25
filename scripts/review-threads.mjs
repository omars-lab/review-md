#!/usr/bin/env node
// review-threads — headless reader for the review-md comment sidecar (P5 agent loop).
//
// The `review-design` agent needs its findings input WITHOUT running Obsidian:
// comment threads live in a git-tracked sibling sidecar `<dir>/.<basename>.comments.md`,
// whose YAML frontmatter (`review:`) is the source of truth (see docs/agent-contract.md).
// This tool locates that sidecar, parses it, flags stale threads by re-deriving the
// same `bodyHash` the plugin stamps, and prints the threads — JSON for a program, or a
// readable findings digest for a human/agent. It never mutates anything.
//
// Usage:
//   node scripts/review-threads.mjs <reviewed-file.md> [--unresolved] [--json]
//   npm run threads -- <reviewed-file.md> [--unresolved] [--json]
//
// Exit codes: 0 = read OK (even with zero threads), 2 = usage error, 3 = no sidecar.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";

// ---- Hashing: MUST match src/main.ts (stripFrontmatter → stripBlockIds → sha256[:12]).
// bodyHash is the sole staleness signal; re-derive it here so an agent can tell a
// thread that was reviewed against the current text from a stale one, off-Obsidian.
function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}
function stripBlockIds(text) {
  return text
    .replace(/[ \t]+\^[A-Za-z0-9_-]+[ \t]*$/gm, "")
    .replace(/^\^[A-Za-z0-9_-]+[ \t]*$/gm, "");
}
function bodyHash(text) {
  return createHash("sha256")
    .update(stripBlockIds(stripFrontmatter(text)))
    .digest("hex")
    .slice(0, 12);
}

// ---- Sidecar location: MUST match ReviewMdPlugin.sidecarPathFor.
function sidecarPathFor(file) {
  return join(dirname(file), `.${basename(file, extname(file))}.comments.md`);
}

// ---- One-line description of where a thread is anchored (all anchor shapes).
function anchorWhere(a = {}) {
  switch (a.type) {
    case "mermaidNode":
      return `diagram node ${a.node}`;
    case "mermaidEdge":
      return `diagram edge ${a.from} → ${a.to}`;
    case "image":
      return `image ${a.src}`;
    case "link":
      return `link ${a.quote ? `“${String(a.quote).replace(/\s+/g, " ").slice(0, 60)}” ` : ""}→ ${a.href ?? ""}`;
    case "text":
    default:
      return a.quote ? `“${String(a.quote).replace(/\s+/g, " ").slice(0, 100)}”` : a.type ?? "text";
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const file = positional[0];
  if (!file) {
    console.error("usage: review-threads <reviewed-file.md> [--unresolved] [--json]");
    process.exit(2);
  }
  const asJson = flags.has("--json");
  const unresolvedOnly = flags.has("--unresolved");

  const sidecar = sidecarPathFor(file);
  if (!existsSync(sidecar)) {
    console.error(`no sidecar for ${file} (expected ${sidecar}) — no comments yet`);
    process.exit(3);
  }

  const raw = readFileSync(sidecar, "utf8");
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const review = fmMatch ? parseYaml(fmMatch[1])?.review : null;
  const threads = review?.threads ?? [];

  // Staleness: re-derive the reviewed file's current bodyHash and compare to each
  // thread's stamped rev.bodyHash. Missing file or rev → unknown (not flagged stale).
  const currentHash = existsSync(file) ? bodyHash(readFileSync(file, "utf8")) : null;
  const outdated = (t) => (t.rev?.bodyHash && currentHash ? t.rev.bodyHash !== currentHash : false);

  let selected = threads;
  if (unresolvedOnly) selected = selected.filter((t) => !t.resolved);

  if (asJson) {
    const enriched = selected.map((t) => ({ ...t, outdated: outdated(t) }));
    process.stdout.write(JSON.stringify({ uid: review?.uid ?? null, file, threads: enriched }, null, 2) + "\n");
    return;
  }

  // Findings digest: unresolved threads with the anchor quote are the agent's input.
  const lines = [`# review-md findings — ${file}`, ""];
  if (currentHash) lines.push(`current bodyHash: ${currentHash}`, "");
  if (!selected.length) {
    lines.push(unresolvedOnly ? "_No open threads._" : "_No threads._");
  }
  for (const t of selected) {
    const tags = [t.resolved ? "resolved" : "open", outdated(t) ? "OUTDATED" : null].filter(Boolean);
    lines.push(`## [${t.id}] ${anchorWhere(t.anchor)}  (${tags.join(", ")})`);
    if (t.rev) lines.push(`reviewed against: ${t.rev.git?.commit ?? t.rev.bodyHash} · ${t.rev.ts}`);
    if (!t.messages?.length) lines.push("", "_(no messages)_");
    for (const m of t.messages ?? []) lines.push("", `**${m.author}** · ${m.ts}`, "", m.body);
    lines.push("");
  }
  process.stdout.write(lines.join("\n").trimEnd() + "\n");
}

main();

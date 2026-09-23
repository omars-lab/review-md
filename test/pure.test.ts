/**
 * Unit tests for the obsidian-free pure layer (src/pure.ts).
 *
 * Run with plain Node — no deps, no bundler: `node --test` strips the `.ts`
 * natively (needs Node ≥ 22.6; the repo pins 22.22.3 via .nvmrc). `make test`
 * wires this into the local gate. There is deliberately NO CI service — these
 * run pre-commit and on demand.
 *
 * Each suite pins a behaviour a past bug or design decision depends on, so a
 * regression trips here instead of in a live review session:
 *   - stripFrontmatter: the empty-frontmatter strip (audit bug #10).
 *   - bodyHash: block-id / frontmatter insensitivity, and parity with the
 *     node:crypto reimplementation in scripts/review-threads.mjs.
 *   - ordinalsFromLog: the newest→oldest reversal that the `--follow` + `--reverse`
 *     git incompatibility forced into JS (docs/issues/docs-vault-and-follow-reverse.md).
 *   - revKeyOf / revLabelFor: the Revisions-filter identity + labels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  WORKING_REV,
  stripFrontmatter,
  stripBlockIds,
  removeBlockIdFromText,
  blockTextFor,
  sha256Short,
  bodyHash,
  ordinalsFromLog,
  revKeyOf,
  revLabelFor,
  snippetAround,
  middleEllipsis,
  mermaidBlocksFrom,
  effectiveReviewer,
  diffThreads,
} from "../src/pure.ts";
import type { ThreadLike } from "../src/pure.ts";

test("stripFrontmatter removes a normal YAML block, keeps the body", () => {
  const text = "---\ntitle: Hi\ntags: [a, b]\n---\n# Body\n\nprose\n";
  assert.equal(stripFrontmatter(text), "# Body\n\nprose\n");
});

test("stripFrontmatter strips an EMPTY frontmatter block (audit bug #10)", () => {
  // `---\n---\n` has no middle lines; the middle must be optional or the whole
  // doc gets hashed as body and the block never strips.
  assert.equal(stripFrontmatter("---\n---\nbody\n"), "body\n");
  assert.equal(stripFrontmatter("---\n---\n"), "");
});

test("stripFrontmatter is a no-op when there is no frontmatter", () => {
  assert.equal(stripFrontmatter("# Just a heading\n"), "# Just a heading\n");
  assert.equal(stripFrontmatter("no dashes here"), "no dashes here");
});

test("stripFrontmatter handles CRLF line endings", () => {
  assert.equal(stripFrontmatter("---\r\na: 1\r\n---\r\nbody\r\n"), "body\r\n");
});

test("stripFrontmatter does not strip a horizontal rule mid-document", () => {
  // A `---` that isn't a leading fenced block must be left alone.
  const text = "# Title\n\ntext\n\n---\n\nmore\n";
  assert.equal(stripFrontmatter(text), text);
});

test("stripBlockIds drops trailing and standalone block-id markers", () => {
  assert.equal(stripBlockIds("a line ^abc123"), "a line");
  assert.equal(stripBlockIds("para\n^xy-z_1\n"), "para\n\n");
  assert.equal(stripBlockIds("no marker here"), "no marker here");
});

test("removeBlockIdFromText removes only the named id", () => {
  assert.equal(removeBlockIdFromText("line one ^keep\nline two ^drop", "drop"), "line one ^keep\nline two");
  assert.equal(removeBlockIdFromText("^solo\nnext", "solo"), "next");
});

test("blockTextFor extracts the block around an id, marker stripped", () => {
  const text = "# H\n\nfirst para\nstill first ^p1\n\nsecond para ^p2\n";
  assert.equal(blockTextFor(text, "p1"), "first para\nstill first");
  assert.equal(blockTextFor(text, "p2"), "second para");
  assert.equal(blockTextFor(text, "missing"), null);
});

test("bodyHash ignores block-id markers (adding an anchor never flips staleness)", async () => {
  const before = "# Doc\n\nA sentence to review.\n";
  const after = "# Doc\n\nA sentence to review. ^cmt-9f2\n";
  assert.equal(await bodyHash(before), await bodyHash(after));
});

test("bodyHash ignores frontmatter churn but tracks body edits", async () => {
  const a = "---\nreviewed: false\n---\nBody text.\n";
  const b = "---\nreviewed: true\nextra: field\n---\nBody text.\n";
  const c = "---\nreviewed: false\n---\nBody text changed.\n";
  assert.equal(await bodyHash(a), await bodyHash(b), "frontmatter change must not move the hash");
  assert.notEqual(await bodyHash(a), await bodyHash(c), "a body edit must move the hash");
});

test("bodyHash stays in sync with scripts/review-threads.mjs (node:crypto)", async () => {
  // The .mjs mirror hashes stripBlockIds(stripFrontmatter(text)) with node:crypto,
  // sliced to 12 hex. If the pure layer and the mirror ever drift, staleness
  // computed in-plugin and by the CLI disagree — pin them equal.
  const text = "---\na: 1\n---\nSome reviewed prose. ^id-1\n\nMore. ^id-2\n";
  const mirror = createHash("sha256").update(stripBlockIds(stripFrontmatter(text))).digest("hex").slice(0, 12);
  assert.equal(await bodyHash(text), mirror);
});

test("sha256Short returns a 12-hex-char digest by default", async () => {
  const h = await sha256Short("hello");
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.equal(h, createHash("sha256").update("hello").digest("hex").slice(0, 12));
});

test("ordinalsFromLog numbers oldest=1, newest=highest (the --follow reversal)", () => {
  // `git log` prints newest-first; a rename forbids `--reverse` alongside
  // `--follow`, so the reversal happens here. Newest commit → highest v.
  const log = "ccc7777\nbbb4444\naaa1111\n"; // newest → oldest, as git emits
  const ord = ordinalsFromLog(log);
  assert.equal(ord.get("aaa1111"), 1, "oldest commit is v1");
  assert.equal(ord.get("bbb4444"), 2);
  assert.equal(ord.get("ccc7777"), 3, "newest commit gets the highest ordinal");
});

test("ordinalsFromLog tolerates blank lines and stray whitespace", () => {
  const ord = ordinalsFromLog("  b222  \n\na111\n");
  assert.equal(ord.get("a111"), 1);
  assert.equal(ord.get("b222"), 2);
  assert.equal(ord.size, 2);
});

test("ordinalsFromLog on an empty log is an empty map", () => {
  assert.equal(ordinalsFromLog("").size, 0);
  assert.equal(ordinalsFromLog("\n\n").size, 0);
});

test("revKeyOf prefers git commit, then bodyHash, else null", () => {
  assert.equal(revKeyOf({ git: { commit: "abc1234" }, bodyHash: "deadbeef0000" }), "abc1234");
  assert.equal(revKeyOf({ bodyHash: "deadbeef0000" }), "deadbeef0000");
  assert.equal(revKeyOf({}), null);
  assert.equal(revKeyOf(undefined), null);
  assert.equal(revKeyOf({ git: { commit: WORKING_REV } }), WORKING_REV);
});

test("revLabelFor labels working copy, git versions, and bare hashes", () => {
  const ordinals = new Map([["b24cd88aa", 7]]);
  assert.equal(revLabelFor(WORKING_REV, ordinals), "Working copy");
  assert.equal(revLabelFor("b24cd88aa", ordinals), "v7 (b24cd88)");
  assert.equal(revLabelFor("deadbeef0000", ordinals), "deadbee", "no ordinal → 7-char slug");
});

test("snippetAround centres on the quote when present", () => {
  const body = `${"x".repeat(300)}NEEDLE${"y".repeat(300)}`;
  const snip = snippetAround(body, "NEEDLE", 20);
  assert.ok(snip.includes("NEEDLE"));
  assert.ok(snip.startsWith("…") && snip.endsWith("…"), "elided on both ends");
  assert.ok(snip.length < body.length);
});

test("snippetAround falls back to the head when the quote is gone", () => {
  const body = "z".repeat(1000);
  const snip = snippetAround(body, "absent", 10);
  assert.ok(snip.endsWith("…"));
  assert.ok(snip.length <= 21); // radius*2 + the ellipsis
});

test("middleEllipsis elides only when over the limit, keeping both ends", () => {
  assert.equal(middleEllipsis("short", 180), "short");
  const long = "START" + "m".repeat(300) + "END";
  const out = middleEllipsis(long, 40);
  assert.ok(out.startsWith("START"));
  assert.ok(out.endsWith("END"));
  assert.ok(out.includes(" … "));
  assert.ok(out.length < long.length);
});

test("mermaidBlocksFrom extracts each fence body in document order", () => {
  const doc = [
    "# Doc",
    "",
    "```mermaid",
    "flowchart TB",
    "  A[Start] --> B[End]",
    "```",
    "",
    "prose between",
    "",
    "```mermaid",
    "flowchart LR",
    "  X --> Y",
    "```",
    "",
  ].join("\n");
  const blocks = mermaidBlocksFrom(doc);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes("A[Start] --> B[End]"));
  assert.ok(blocks[1].includes("X --> Y"));
  assert.ok(!blocks[0].includes("```"), "the fence markers are not captured");
});

test("mermaidBlocksFrom ignores non-mermaid fences and handles CRLF", () => {
  const doc = "```js\nconst x = 1;\n```\r\n\r\n```mermaid\r\nflowchart TB\r\n  A --> B\r\n```\r\n";
  const blocks = mermaidBlocksFrom(doc);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].includes("A --> B"));
  assert.ok(!blocks[0].includes("const x"));
});

test("mermaidBlocksFrom returns [] when there is no mermaid", () => {
  assert.deepEqual(mermaidBlocksFrom("# just prose\n\nno diagrams here"), []);
});

test("effectiveReviewer trims a set name and falls back to 'reviewer' when blank", () => {
  assert.equal(effectiveReviewer("Omar"), "Omar");
  assert.equal(effectiveReviewer("  Omar  "), "Omar");
  // Blank / whitespace-only → the generic default, never a specific person's name.
  assert.equal(effectiveReviewer(""), "reviewer");
  assert.equal(effectiveReviewer("   "), "reviewer");
});

// ---- Comments panel: surgical-update diff ----

/** A small thread factory so each diff test states only what it varies. */
function thread(id: string, over: Partial<ThreadLike> = {}): ThreadLike {
  return {
    id,
    resolved: false,
    anchor: { type: "text", quote: `quote ${id}` },
    messages: [{ author: "omar", ts: "2026-09-19T10:00:00Z", body: `first ${id}` }],
    rev: { bodyHash: "abc", git: { commit: "1234567" } },
    ...over,
  };
}

test("diffThreads: identical lists produce an empty diff (the no-op write path)", () => {
  // Every write triggers two refreshes (the caller's and notifyReviewChanged's);
  // the second must find nothing to do, or it would churn DOM for no reason.
  const a = [thread("t1"), thread("t2")];
  const b = [thread("t1"), thread("t2")];
  assert.deepEqual(diffThreads(a, b), { added: [], removed: [], changed: [] });
});

test("diffThreads names added and removed ids, in list order", () => {
  const prev = [thread("t1"), thread("t2"), thread("t3")];
  const next = [thread("t3"), thread("t4"), thread("t5")];
  const d = diffThreads(prev, next);
  assert.deepEqual(d.added, ["t4", "t5"]);
  assert.deepEqual(d.removed, ["t1", "t2"]);
  assert.deepEqual(d.changed, []);
});

test("diffThreads attributes a reply to `messages` only", () => {
  const before = thread("t1");
  const after = thread("t1", {
    messages: [...before.messages, { author: "claude", ts: "2026-09-19T10:05:00Z", body: "reply" }],
  });
  assert.deepEqual(diffThreads([before], [after]).changed, [{ id: "t1", fields: ["messages"] }]);
});

test("diffThreads sees an in-place body edit and a delete as `messages` changes", () => {
  const before = thread("t1", {
    messages: [
      { author: "omar", ts: "1", body: "a" },
      { author: "omar", ts: "2", body: "b" },
    ],
  });
  const edited = thread("t1", {
    messages: [
      { author: "omar", ts: "1", body: "a (edited)" },
      { author: "omar", ts: "2", body: "b" },
    ],
  });
  const deleted = thread("t1", { messages: [{ author: "omar", ts: "2", body: "b" }] });
  assert.deepEqual(diffThreads([before], [edited]).changed, [{ id: "t1", fields: ["messages"] }]);
  assert.deepEqual(diffThreads([before], [deleted]).changed, [{ id: "t1", fields: ["messages"] }]);
});

test("diffThreads attributes a resolve toggle to `resolved` and a re-anchor to `anchor`/`rev`", () => {
  const base = thread("t1");
  const resolved = thread("t1", { resolved: true });
  assert.deepEqual(diffThreads([base], [resolved]).changed, [{ id: "t1", fields: ["resolved"] }]);
  // The post-commit re-anchor hook rewrites rev.git.commit (working → sha) and
  // may add a blockId to the anchor: both are "rebuild the card" changes.
  const reanchored = thread("t1", {
    anchor: { type: "text", quote: "quote t1", blockId: "cmt-1" },
    rev: { bodyHash: "abc", git: { commit: "89abcde" } },
  });
  assert.deepEqual(diffThreads([base], [reanchored]).changed, [{ id: "t1", fields: ["anchor", "rev"] }]);
});

test("diffThreads reports several fields on one thread together, other threads untouched", () => {
  const prev = [thread("t1"), thread("t2")];
  const next = [
    thread("t1", { resolved: true, messages: [...thread("t1").messages, { author: "x", ts: "3", body: "y" }] }),
    thread("t2"),
  ];
  const d = diffThreads(prev, next);
  assert.deepEqual(d.changed, [{ id: "t1", fields: ["resolved", "messages"] }]);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test("diffThreads treats a missing rev and an absent rev as equal", () => {
  const a = thread("t1", { rev: undefined });
  const b = thread("t1");
  delete (b as { rev?: unknown }).rev;
  assert.deepEqual(diffThreads([a], [b]), { added: [], removed: [], changed: [] });
});

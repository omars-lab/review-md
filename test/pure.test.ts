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
  threadMatches,
  sortThreads,
  latestTs,
  anchorLineIn,
  commentedLines,
  startsFolded,
  FOLD_OVER,
  anchorWhere,
  filterThreads,
  threadsDigest,
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

test("bodyHash stays in sync with scripts/reviews.mjs (node:crypto)", async () => {
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

// ---- Comments panel: search / sort / position / fold ----

test("threadMatches: empty or blank query matches everything", () => {
  assert.equal(threadMatches(thread("t1"), ""), true);
  assert.equal(threadMatches(thread("t1"), "   "), true);
});

test("threadMatches is a case-insensitive substring over body, author, anchor text and type label", () => {
  const t = thread("t1", {
    anchor: { type: "mermaidEdge", from: "URL", to: "PH", quote: "URL → PH" },
    messages: [{ author: "Omar", ts: "1", body: "does the Handler validate the vault?" }],
  });
  assert.equal(threadMatches(t, "handler"), true); // body
  assert.equal(threadMatches(t, "OMAR"), true); // author
  assert.equal(threadMatches(t, "url → ph"), true); // anchor quote
  assert.equal(threadMatches(t, "edge"), true); // type label (mermaidEdge → "edge")
  assert.equal(threadMatches(t, "t1"), true); // id
  assert.equal(threadMatches(t, "sidecar"), false);
});

test("latestTs is the newest message stamp, else rev.ts, else 0", () => {
  const t = thread("t1", {
    messages: [
      { author: "a", ts: "2026-09-19T10:00:00Z", body: "" },
      { author: "b", ts: "2026-09-21T10:00:00Z", body: "" },
      { author: "c", ts: "2026-09-20T10:00:00Z", body: "" },
    ],
  });
  assert.equal(latestTs(t), Date.parse("2026-09-21T10:00:00Z"));
  assert.equal(latestTs(thread("t2", { messages: [], rev: { ts: "2026-09-01T00:00:00Z" } })), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(latestTs(thread("t3", { messages: [], rev: undefined })), 0);
});

/** Four threads: t1 oldest, t3 newest, t2 resolved (and newer than t1), t4 by another author. */
function sample(): ThreadLike[] {
  return [
    thread("t1", { messages: [{ author: "omar", ts: "2026-09-19T10:00:00Z", body: "" }] }),
    thread("t2", { resolved: true, messages: [{ author: "omar", ts: "2026-09-19T12:00:00Z", body: "" }] }),
    thread("t3", { messages: [{ author: "omar", ts: "2026-09-19T11:00:00Z", body: "" }] }),
    thread("t4", { messages: [{ author: "claude", ts: "2026-09-19T10:30:00Z", body: "" }] }),
  ];
}
const ids = (ts: ThreadLike[]) => ts.map((t) => t.id);

test("sortThreads recency: newest activity first, resolved threads always last", () => {
  assert.deepEqual(ids(sortThreads(sample(), "recency")), ["t3", "t4", "t1", "t2"]);
  // A reply on the oldest thread bumps it to the top.
  const s = sample();
  s[0].messages.push({ author: "claude", ts: "2026-09-19T13:00:00Z", body: "reply" });
  assert.deepEqual(ids(sortThreads(s, "recency")), ["t1", "t3", "t4", "t2"]);
});

test("sortThreads position: by anchor line, unknown positions last, resolved after open", () => {
  const positions = new Map([
    ["t1", 40],
    ["t3", 5],
    ["t2", 1],
  ]);
  assert.deepEqual(ids(sortThreads(sample(), "position", positions)), ["t3", "t1", "t4", "t2"]);
  // No positions at all → ties fall back to recency.
  assert.deepEqual(ids(sortThreads(sample(), "position")), ["t3", "t4", "t1", "t2"]);
});

test("sortThreads author: first author A→Z (case-insensitive), then recency", () => {
  assert.deepEqual(ids(sortThreads(sample(), "author")), ["t4", "t3", "t1", "t2"]);
  const s = sample();
  s[3].messages[0].author = "Zed";
  assert.deepEqual(ids(sortThreads(s, "author")), ["t3", "t1", "t4", "t2"]);
});

test("sortThreads does not mutate its input", () => {
  const s = sample();
  sortThreads(s, "recency");
  assert.deepEqual(ids(s), ["t1", "t2", "t3", "t4"]);
});

const BODY = [
  "---", // 0
  "title: x", // 1
  "---", // 2
  "# Design", // 3
  "", // 4
  "Intro paragraph mentioning CS in prose.", // 5
  "", // 6
  "```mermaid", // 7
  "flowchart LR", // 8
  "  URL[Link] --> PH[Protocol handler]", // 9
  "  PH --> CS[Comment store]", // 10
  "  CS --> MA[Mermaid augmenter]", // 11
  "```", // 12
  "", // 13
  "## Storage ^h-store", // 14
  "", // 15
  "The sidecar holds every thread. ^blk-1", // 16
  "", // 17
  "![diagram](media/arch.png)", // 18
  "See [the API](docs/api/index.md) for details.", // 19
  "", // 20
  "```mermaid", // 21
  "stateDiagram-v2", // 22
  "  Store --> Done", // 23
  "```", // 24
].join("\n");

test("anchorLineIn text/header: block id first, then the quote, then the recorded line", () => {
  assert.equal(anchorLineIn(BODY, { type: "text", blockId: "blk-1", quote: "gone" }), 16);
  assert.equal(anchorLineIn(BODY, { type: "text", quote: "holds every thread" }), 16);
  assert.equal(anchorLineIn(BODY, { type: "text", quote: "not in the doc", line: 3 }), 3);
  assert.equal(anchorLineIn(BODY, { type: "text", quote: "not in the doc" }), null);
  assert.equal(anchorLineIn(BODY, { type: "header", blockId: "h-store" }), 14);
  assert.equal(anchorLineIn(BODY, { type: "header", quote: "Storage" }), 14);
});

test("anchorLineIn mermaidNode: first mention inside a mermaid fence, never prose", () => {
  assert.equal(anchorLineIn(BODY, { type: "mermaidNode", node: "CS" }), 10); // line 5 is prose
  assert.equal(anchorLineIn(BODY, { type: "mermaidNode", node: "PH" }), 9);
  assert.equal(anchorLineIn(BODY, { type: "mermaidNode", node: "Store" }), 23); // second diagram
  assert.equal(anchorLineIn(BODY, { type: "mermaidNode", node: "Nope" }), null);
  assert.equal(anchorLineIn(BODY, { type: "mermaidNode", node: "C" }), null); // whole-word only
});

test("anchorLineIn mermaidEdge: the link line, else from's line in a fence that has both ends", () => {
  assert.equal(anchorLineIn(BODY, { type: "mermaidEdge", from: "URL", to: "PH" }), 9);
  assert.equal(anchorLineIn(BODY, { type: "mermaidEdge", from: "CS", to: "MA" }), 11);
  // No such link, but both endpoints in the first fence → where `from` appears.
  assert.equal(anchorLineIn(BODY, { type: "mermaidEdge", from: "MA", to: "URL" }), 11);
  assert.equal(anchorLineIn(BODY, { type: "mermaidEdge", from: "URL", to: "Done" }), null);
});

test("anchorLineIn image and link: the source line, image by file name when src is an app URL", () => {
  assert.equal(anchorLineIn(BODY, { type: "image", src: "media/arch.png" }), 18);
  assert.equal(anchorLineIn(BODY, { type: "image", src: "app://obsidian/vault/media/arch.png?123" }), 18);
  assert.equal(anchorLineIn(BODY, { type: "link", href: "docs/api/index.md" }), 19);
  assert.equal(anchorLineIn(BODY, { type: "link", href: "https://elsewhere", quote: "the API" }), 19);
  assert.equal(anchorLineIn(BODY, { type: "mystery" }), null);
});

test("commentedLines: open passage threads by line, diagrams and resolved left out", () => {
  const text = "# Title\n\nFirst para. ^a1\n\nSecond para mentions [[api]].\n";
  const lines = commentedLines(text, [
    thread("t1", { anchor: { type: "text", blockId: "a1" } }),
    thread("t2", { anchor: { type: "text", blockId: "a1" } }),
    thread("t3", { anchor: { type: "link", href: "api" } }),
    thread("t4", { anchor: { type: "header", quote: "Title" }, resolved: true }),
    thread("t5", { anchor: { type: "mermaidNode", node: "A" } }),
    thread("t6", { anchor: { type: "text", quote: "not in the doc" } }),
  ]);
  assert.deepEqual([...lines], [
    [2, ["t1", "t2"]],
    [4, ["t3"]],
  ]);
});

test("startsFolded: resolved threads and threads longer than FOLD_OVER start folded", () => {
  const msg = { author: "a", ts: "1", body: "" };
  assert.equal(startsFolded(thread("t1")), false);
  assert.equal(startsFolded(thread("t1", { resolved: true })), true);
  assert.equal(startsFolded(thread("t1", { messages: Array(FOLD_OVER).fill(msg) })), false);
  assert.equal(startsFolded(thread("t1", { messages: Array(FOLD_OVER + 1).fill(msg) })), true);
});

test("anchorWhere names every anchor type in one line", () => {
  assert.equal(anchorWhere({ type: "mermaidNode", node: "CS" }), "diagram node CS");
  assert.equal(anchorWhere({ type: "mermaidEdge", from: "A", to: "B" }), "diagram edge A → B");
  assert.equal(anchorWhere({ type: "image", src: "a.png" }), "image a.png");
  assert.equal(anchorWhere({ type: "link", quote: "the API", href: "api.md" }), "link “the API” → api.md");
  assert.equal(anchorWhere({ type: "header", quote: "Intro\n  text" }), "“Intro text”");
  assert.equal(anchorWhere({ type: "text" }), "text");
});

test("filterThreads: open only by default, resolved on request, text narrows", () => {
  const ts = [thread("a"), thread("b", { resolved: true }), thread("c")];
  assert.deepEqual(filterThreads(ts).map((t) => t.id), ["a", "c"]);
  assert.deepEqual(filterThreads(ts, { includeResolved: true }).map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(filterThreads(ts, { text: "FIRST C" }).map((t) => t.id), ["c"]);
});

test("threadsDigest: per-file sections, state tags, links only with a vault, empty files dropped", () => {
  const files = [
    { path: "a b.md", threads: [{ ...thread("t1"), outdated: true }] },
    { path: "empty.md", threads: [] },
  ];
  const plain = threadsDigest(files, { scope: "vault", filter: { text: "first" } });
  assert.match(plain, /^# review-md comments — vault\n\n1 thread \(open, matching “first”\) in 1 file\./);
  assert.match(plain, /## a b\.md\n\n### \[t1\] “quote t1” \(open, OUTDATED\)\nreviewed against: 1234567/);
  assert.doesNotMatch(plain, /empty\.md|obsidian:\/\//);
  const linked = threadsDigest(files, { scope: "vault", vault: "My Vault" });
  assert.match(linked, /open: obsidian:\/\/review-md-open\?vault=My%20Vault&file=a%20b\.md&thread=t1/);
  assert.match(threadsDigest([], { scope: "x" }), /_No threads match\._/);
});

test("threadsDigest: a lead-in says what to do, and outdated threads show today's text", () => {
  const files = [
    {
      path: "d.md",
      threads: [
        { ...thread("t1"), outdated: true, current: "the new\n  wording" },
        { ...thread("t2"), outdated: true, current: null },
        { ...thread("t3"), current: "ignored when not outdated" },
      ],
    },
  ];
  const out = threadsDigest(files, { scope: "d.md" });
  assert.match(out, /These are review comments people left/);
  assert.match(out, /### \[t1\][^\n]*\nreviewed against: [^\n]*\nnow reads: “the new wording”/);
  assert.match(out, /### \[t2\][^\n]*\nreviewed against: [^\n]*\nnow: \(no longer in the doc\)/);
  assert.doesNotMatch(out, /ignored when not outdated/);
  assert.doesNotMatch(threadsDigest([], { scope: "x" }), /These are review comments/);
});

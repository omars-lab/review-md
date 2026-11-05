/**
 * `anchor.source`: where in the repo's source a thread points. `reviews list --json`
 * and `show --json` work it out when they print (it is never stored in the comments
 * file). One entry per thread: { file, line, how: "line", commit, dirty }.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts", "reviews.mjs");
const DOC = join(ROOT, "docs", "designs", "design.md");

const reviews = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8" }));

test("source: list --json gives each thread one how:line entry with the live line", () => {
  const { threads } = reviews("list", DOC);
  const lines = readFileSync(DOC, "utf8").split("\n");
  const node = threads.find((t: any) => t.id === "d1a2b3"); // mermaidNode CS
  assert.equal(node.anchor.source.length, 1);
  const [s] = node.anchor.source;
  assert.equal(s.file, "docs/designs/design.md", "path from the git root, forward slashes");
  assert.equal(s.how, "line");
  assert.match(lines[s.line - 1], /CS\["Comment store/, "1-based line that holds the diagram node");
  const head = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(s.commit, head);
  assert.equal(typeof s.dirty, "boolean");
  for (const t of threads) assert.equal(t.anchor.source.length, 1, t.id);
});

test("source: show --json carries it too, and the sidecar file is not changed", () => {
  const sidecar = join(ROOT, "docs", "designs", ".design.comments.md");
  const before = readFileSync(sidecar, "utf8");
  const t = reviews("show", DOC, "qklp1y"); // mermaidEdge
  assert.match(readFileSync(DOC, "utf8").split("\n")[t.anchor.source[0].line - 1], /URL/);
  assert.equal(readFileSync(sidecar, "utf8"), before);
  assert.ok(!before.includes("source:"), "never stored");
});

test("source: outside git the file is the path from the vault root; no known line means no line", () => {
  const vault = mkdtempSync(join(tmpdir(), "reviews-source-"));
  mkdirSync(join(vault, ".obsidian"));
  mkdirSync(join(vault, "notes"));
  const doc = join(vault, "notes", "a.md");
  writeFileSync(doc, "# A\n\nfirst\n\nthe walk is long\n");
  const thread = (id: string, anchor: string) =>
    `    - id: ${id}\n      anchor:\n${anchor}\n      resolved: false\n      messages:\n        - author: omar\n          ts: 2026-10-12T18:04:11Z\n          body: hi\n`;
  writeFileSync(
    join(vault, "notes", ".a.comments.md"),
    "---\nreview:\n  uid: srctest00001\n  threads:\n" +
      thread("aaa111", "        type: text\n        quote: the walk is long") +
      thread("bbb222", "        type: text\n        line: 2") + // recorded 0-based line 2 is the third line
      thread("ccc333", "        type: text") + // nothing to go on
      "---\n",
  );
  assert.ok(existsSync(doc));
  const { threads } = reviews("list", doc);
  const by = Object.fromEntries(threads.map((t: any) => [t.id, t.anchor.source[0]]));
  assert.deepEqual(by.aaa111, { file: "notes/a.md", line: 5, how: "line" }, "no commit or dirty without git");
  assert.deepEqual(by.bbb222, { file: "notes/a.md", line: 3, how: "line" }, "falls back to the recorded line");
  assert.deepEqual(by.ccc333, { file: "notes/a.md", how: "line" }, "line left out, not guessed");
});

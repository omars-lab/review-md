// `reviews open`, run as the shipped CLI against a throwaway vault: given a doc, or
// given only a thread id copied from `reviews list`. --dry-run prints the URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../plugins/review-md/bin/reviews.mjs", import.meta.url));

const sidecar = (ids: string[]) =>
  [
    "---",
    "review:",
    "  uid: fixture",
    "  threads:",
    ...ids.flatMap((id) => [
      `    - id: ${id}`,
      "      anchor:",
      "        type: text",
      "        quote: Hello",
      "      resolved: false",
      "      messages:",
      "        - author: omar",
      "          ts: 2026-09-29T10:00:00Z",
      "          body: a question",
    ]),
    "---",
    "",
  ].join("\n");

/** vault/ (.obsidian) holding notes/a.md [aaa111, dup333] and notes/sub/b.md [bbb222, dup333]. */
function makeVault() {
  const vault = join(mkdtempSync(join(tmpdir(), "reviews-open-")), "vault");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  mkdirSync(join(vault, "notes/sub"), { recursive: true });
  const doc = (dir: string, name: string, ids: string[]) => {
    writeFileSync(join(vault, dir, `${name}.md`), "# Hello\n\nHello there.\n");
    writeFileSync(join(vault, dir, `.${name}.comments.md`), sidecar(ids));
  };
  doc("notes", "a", ["aaa111", "dup333"]);
  doc("notes/sub", "b", ["bbb222", "dup333"]);
  return vault;
}

const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, "open", ...args, "--dry-run"], { cwd, encoding: "utf8" });

test("open: a doc and a thread id give the URL for that doc", () => {
  const vault = makeVault();
  try {
    const r = run(vault, "notes/a.md", "aaa111");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "obsidian://review-md-open?vault=vault&file=notes%2Fa.md&thread=aaa111\n");
  } finally {
    rmSync(join(vault, ".."), { recursive: true, force: true });
  }
});

test("open: a thread id alone finds its doc, in a subfolder too", () => {
  const vault = makeVault();
  try {
    const r = run(vault, "bbb222");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "obsidian://review-md-open?vault=vault&file=notes%2Fsub%2Fb.md&thread=bbb222\n");
    // A folder narrows the search; the path in the URL stays relative to the vault.
    const inFolder = run(join(vault, "notes"), "aaa111", "sub/..");
    assert.equal(inFolder.status, 0, inFolder.stderr);
    assert.equal(inFolder.stdout, "obsidian://review-md-open?vault=vault&file=notes%2Fa.md&thread=aaa111\n");
  } finally {
    rmSync(join(vault, ".."), { recursive: true, force: true });
  }
});

test("open: an unknown id exits 3, an id on two docs exits 2 naming both", () => {
  const vault = makeVault();
  try {
    const missing = run(vault, "zzz999");
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /no doc or thread zzz999 under \./);
    assert.equal(missing.stdout, "");

    const dup = run(vault, "dup333");
    assert.equal(dup.status, 2);
    assert.match(dup.stderr, /notes\/a\.md/);
    assert.match(dup.stderr, /notes\/sub\/b\.md/);
    // Naming the doc settles it.
    assert.equal(run(vault, "notes/sub/b.md", "dup333").status, 0);
    // So does a folder holding only one of them.
    assert.equal(run(vault, "dup333", "notes/sub").stdout, "obsidian://review-md-open?vault=vault&file=notes%2Fsub%2Fb.md&thread=dup333\n");
  } finally {
    rmSync(join(vault, ".."), { recursive: true, force: true });
  }
});

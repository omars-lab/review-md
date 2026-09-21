#!/usr/bin/env node
/**
 * POC-4 (headless half) — does the review-md frontmatter schema survive a
 * YAML serialize→parse round-trip at realistic scale, with realistic content?
 *
 * This tests the DATA-MODEL risk only. It uses the `yaml` package as a stand-in
 * for Obsidian's frontmatter serializer (indicative, not identical — the
 * Obsidian-specific risks, Properties-UI rendering and metadataCache bloat, are
 * verified in the GUI step documented in docs/pocs/poc-4-frontmatter.md).
 *
 * PASS bar: N=50 threads with multi-message replies round-trip deeply-equal,
 * including bodies containing newlines, colons, quotes, markdown and unicode.
 */
import YAML from "yaml";
import assert from "node:assert";

const N = 50;
const id = () => Math.random().toString(36).substring(2, 8);

// Bodies chosen to stress YAML: colon, quotes, newline, markdown, unicode, leading '#'.
const BODIES = [
  "why radial here? seems arbitrary",
  'key: value looking text with "quotes" and a trailing colon:',
  "multi-line\nreply with a second line\n- and a bullet\n- another",
  "# looks like a heading and `code` and [a link](https://x.test)",
  "unicode ✓ diacritics ū ḥ ʿ emoji 🎯 — keep intact",
];

function makeThread(i) {
  const tid = id();
  const anchor =
    i % 5 === 0
      ? { type: "image", src: `img/plate-${i}.png` }
      : { type: "text", line: i * 3, blockId: tid, quote: `anchored phrase number ${i}` };
  const messages = Array.from({ length: (i % 4) + 1 }, (_, m) => ({
    author: m % 2 === 0 ? "omar" : "claude",
    ts: new Date(Date.UTC(2026, 8, 19, 10, i % 60, m % 60)).toISOString(),
    body: BODIES[(i + m) % BODIES.length],
  }));
  return { id: tid, anchor, resolved: i % 7 === 0, messages };
}

const fm = {
  review: {
    uid: id() + id(),
    threads: Array.from({ length: N }, (_, i) => makeThread(i)),
  },
};

const yamlText = YAML.stringify(fm);
const parsed = YAML.parse(yamlText);

let ok = true;
const problems = [];
try {
  assert.deepStrictEqual(parsed, fm);
} catch (e) {
  ok = false;
  problems.push("deep-equal FAILED: " + e.message.split("\n").slice(0, 4).join(" "));
}

// Spot-check a unicode/newline body survived exactly.
const sample = fm.review.threads.find((t) => t.messages.some((m) => m.body.includes("ū")));
if (sample) {
  const rt = parsed.review.threads.find((t) => t.id === sample.id);
  const before = sample.messages.map((m) => m.body).join("|");
  const after = rt.messages.map((m) => m.body).join("|");
  if (before !== after) {
    ok = false;
    problems.push("unicode/newline body diverged after round-trip");
  }
}

const bytes = Buffer.byteLength(yamlText, "utf8");
const totalMessages = fm.review.threads.reduce((n, t) => n + t.messages.length, 0);

console.log("── POC-4 frontmatter round-trip (headless) ──");
console.log(`threads:        ${N}`);
console.log(`total messages: ${totalMessages}`);
console.log(`frontmatter size: ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`);
console.log(`deep-equal round-trip: ${ok ? "OK" : "FAILED"}`);
if (problems.length) problems.forEach((p) => console.log("  ! " + p));
console.log("\n── sample of serialized YAML (first 20 lines) ──");
console.log(yamlText.split("\n").slice(0, 20).join("\n"));
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"} (data-model half; GUI half pending — see docs/pocs/poc-4-frontmatter.md)`);
process.exit(ok ? 0 : 1);

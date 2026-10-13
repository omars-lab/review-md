/**
 * The shared thread shape (schema/thread.schema.json). review-md and
 * development-manager's page comments both hand threads out in this shape, so one
 * reader understands both (docs/agent-contract.md, "One shape, two tools").
 *
 * Pins three things:
 *   - what `reviews list --json` really prints fits the schema;
 *   - every review-md anchor type fits;
 *   - a page comment's thread fits too: an `element` anchor, a quote with the words
 *     either side, a `status` of dismissed, pictures. A reader written for
 *     review-md must not be thrown by those, so the schema must not be either.
 *
 * A small checker covers the keywords the schema uses, so no library is needed.
 * development-manager keeps a pinned copy of the schema and runs the same kind of
 * check on its side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const schema = JSON.parse(readFileSync(join(ROOT, "schema", "thread.schema.json"), "utf8"));

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  minItems?: number;
  maxLength?: number;
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function check(s: Schema, v: unknown, at = "$"): string[] {
  const errs: string[] = [];
  if (s.type) {
    const types = ([] as string[]).concat(s.type);
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "number" && types.includes("integer"))) errs.push(`${at}: ${t} is not ${types.join("|")}`);
  }
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  if (typeOf(v) === "object") {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in o)) errs.push(`${at}: missing ${k}`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in o && o[k] !== undefined) errs.push(...check(sub, o[k], `${at}.${k}`));
  }
  if (Array.isArray(v)) {
    if (s.minItems && v.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems}`);
    if (s.items) v.forEach((x, i) => errs.push(...check(s.items!, x, `${at}[${i}]`)));
  }
  if (typeof v === "string" && s.maxLength && v.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
  return errs;
}

const msg = { author: "omar", ts: "2026-10-12T18:04:11.000Z", body: "This should say how long the walk is." };
const rev = { bodyHash: "3f9a1c0b7e22", ts: "2026-10-12T18:04:11.000Z", git: { commit: "51b4ad3", blob: "HEAD:docs/sample.md" } };

test("schema: the checker catches a bad thread", () => {
  assert.notDeepEqual(check(schema, { id: "x" }), []);
  assert.notDeepEqual(check(schema, { id: "x", resolved: "no", anchor: { type: "text" }, messages: [msg] }), []);
  assert.notDeepEqual(check(schema, { id: "x", resolved: false, anchor: { type: "text" }, messages: [] }), []);
});

test("schema: what `reviews list --json` prints fits", () => {
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "reviews.mjs"), "list", join(ROOT, "docs", "designs", "design.md"), "--json"], { encoding: "utf8" });
  const { threads } = JSON.parse(out);
  assert.ok(threads.length > 0, "the sample doc has threads");
  for (const t of threads) assert.deepEqual(check(schema, t), [], t.id);
});

test("schema: every review-md anchor type fits", () => {
  const anchors = [
    { type: "text", quote: "the walk", line: 12, index: 0, blockId: "a1b2c3" },
    { type: "header", quote: "Getting there" },
    { type: "link", href: "https://example.com", quote: "example" },
    { type: "mermaidNode", node: "A", quote: "Start" },
    { type: "mermaidEdge", from: "A", to: "B", quote: "A → B" },
    { type: "image", src: "shots/hub-42.png" },
  ];
  for (const anchor of anchors) {
    const t = { id: "d1a2b3", resolved: false, anchor, rev: { ...rev, anchorHash: "0c1d2e3f4a5b" }, messages: [msg], outdated: false };
    assert.deepEqual(check(schema, t), [], anchor.type);
  }
});

test("schema: a page comment's thread fits, and an unknown anchor type is allowed", () => {
  const page = {
    id: "t_8f3a2c",
    resolved: true,
    status: "dismissed",
    anchor: {
      type: "element",
      commentId: null,
      css: "main > section:nth-of-type(2) > div.card",
      tag: "div",
      label: "Zilker Park",
      quote: { exact: "Zilker Park", prefix: "Day 2 ", suffix: " 20 min walk" },
      box: { fx: 0.4, fy: 0.2 },
    },
    rev: { bodyHash: "9c41d0e2aa10", ts: "2026-10-12T18:04:11.000Z", git: { commit: "abc1234", dirty: true }, landed: { commit: "def5678" } },
    page: { url: "http://127.0.0.1:8766/trips/sample/", path: "/trips/sample/", title: "Sample trip" },
    viewport: { w: 390, h: 844, dpr: 3, scrollX: 0, scrollY: 1200, scheme: "light" },
    messages: [msg, { author: "claude", ts: "2026-10-12T18:10:00.000Z", body: "Not an issue: it already says 20 min.", commit: "def5678" }],
    waiting: null,
    history: [{ status: "dismissed", author: "claude", ts: "2026-10-12T18:10:00.000Z", note: "already there" }],
    shots: [{ role: "comment", ts: "2026-10-12T18:04:11.000Z", icloud: "data/page-comments/t_8f3a2c.png", sha: "0a1b2c3d4e5f" }],
    lost: true,
  };
  assert.deepEqual(check(schema, page), []);
  assert.deepEqual(check(schema, { ...page, anchor: { type: "somethingNew" } }), [], "readers skip anchor types they don't know");
});

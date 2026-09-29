/**
 * Unit tests for `reviews watch`'s pure half (src/watch.ts): what counts as a change
 * between two looks at a folder's threads, and how it prints. Each case is one of
 * the ways a watch could lie to the agent reading it — waking it for its own reply,
 * reading a half-written file as "every thread deleted", or replaying the past.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import {
  diffSnapshots,
  replayEvents,
  snapshotCounts,
  parseSidecar,
  formatEvent,
  formatLogLine,
  logValue,
  WATCH_MSG_MAX,
  RESOLVE_ATTRIBUTION_MS,
} from "../src/watch.ts";
import type { WatchSnapshot, WatchThread } from "../src/watch.ts";

const msg = (author: string, body: string, ts = "2026-09-27T10:00:00.000Z") => ({ author, ts, body });
const thread = (id: string, messages: ReturnType<typeof msg>[], extra: Partial<WatchThread> = {}): WatchThread => ({
  id,
  resolved: false,
  anchor: { type: "text", quote: "q" },
  messages,
  ...extra,
});
const snap = (docs: Record<string, WatchThread[]>, uid: (f: string) => string | null = (f) => `uid-${f}`): WatchSnapshot =>
  Object.fromEntries(Object.entries(docs).map(([f, threads]) => [f, { uid: uid(f), threads }]));

const base = snap({ "a.md": [thread("t1", [msg("omar", "first")])] });

test("watch: nothing changed → no events, snapshot kept", () => {
  const d = diffSnapshots(base, structuredClone(base));
  assert.deepEqual(d.events, []);
  assert.deepEqual(d.snapshot, base);
  assert.deepEqual(d.missing, []);
});

test("watch: a new thread → thread_new with its first message and author", () => {
  const next = snap({ "a.md": [...base["a.md"].threads, thread("t2", [msg("omar", "why?")])] });
  assert.deepEqual(diffSnapshots(base, next).events, [
    { ev: "thread_new", file: "a.md", thread: "t2", author: "omar", msg: "why?" },
  ]);
});

test("watch: a new sidecar is new threads, and replies already on it are messages", () => {
  const next = snap({ ...{ "a.md": base["a.md"].threads }, "b.md": [thread("t9", [msg("ana", "q"), msg("omar", "a")])] });
  assert.deepEqual(
    diffSnapshots(base, next).events.map((e) => [e.ev, e.file, e.author]),
    [
      ["thread_new", "b.md", "ana"],
      ["message_new", "b.md", "omar"],
    ],
  );
});

test("watch: a reply → message_new; an edit → message_edited", () => {
  const replied = snap({ "a.md": [thread("t1", [msg("omar", "first"), msg("ana", "done", "2026-09-27T11:00:00.000Z")])] });
  assert.deepEqual(diffSnapshots(base, replied).events, [
    { ev: "message_new", file: "a.md", thread: "t1", author: "ana", msg: "done" },
  ]);
  const edited = snap({ "a.md": [thread("t1", [msg("omar", "first, reworded")])] });
  assert.deepEqual(
    diffSnapshots(base, edited).events.map((e) => e.ev),
    ["message_edited"],
  );
});

test("watch: resolve and reopen; the resolver is the author of a just-written message, else unknown", () => {
  const now = Date.parse("2026-09-27T10:00:30.000Z");
  const resolved = snap({ "a.md": [thread("t1", base["a.md"].threads[0].messages, { resolved: true })] });
  const r = diffSnapshots(base, resolved, { now }).events;
  assert.deepEqual(r.map((e) => [e.ev, e.author]), [["thread_resolved", "omar"]]);
  // The last message is old: who resolved it isn't known.
  const later = diffSnapshots(base, resolved, { now: now + RESOLVE_ATTRIBUTION_MS * 2 }).events;
  assert.equal(later[0].author, "");
  assert.deepEqual(diffSnapshots(resolved, base, { now }).events.map((e) => e.ev), ["thread_reopened"]);
});

test("watch: --exclude-author drops the agent's own reply and its reply-and-resolve, case-insensitively", () => {
  const now = Date.parse("2026-09-27T11:00:10.000Z");
  const next = snap({
    "a.md": [thread("t1", [msg("omar", "first"), msg("Claude", "fixed", "2026-09-27T11:00:00.000Z")], { resolved: true })],
  });
  assert.deepEqual(diffSnapshots(base, next, { exclude: ["claude"], now }).events, []);
  // …but someone else's message in the same pass still comes through.
  const both = snap({
    "a.md": [thread("t1", [msg("omar", "first"), msg("claude", "fixed", "2026-09-27T11:00:00.000Z"), msg("ana", "thanks", "2026-09-27T11:00:05.000Z")])],
  });
  assert.deepEqual(
    diffSnapshots(base, both, { exclude: ["claude"], now }).events.map((e) => [e.ev, e.author]),
    [["message_new", "ana"]],
  );
});

test("watch: a torn / unparseable sidecar emits nothing and keeps its last good reading", () => {
  // The pass that caught it mid-write has no entry for a.md, and says so.
  const d = diffSnapshots(base, {}, { unreadable: ["a.md"] });
  assert.deepEqual(d.events, []);
  assert.deepEqual(d.snapshot, base);
  assert.deepEqual(d.missing, [], "a torn file is not a missing one");
  // The next clean read reports only what really changed.
  const next = snap({ "a.md": [thread("t1", [msg("omar", "first"), msg("ana", "hi", "2026-09-27T11:00:00.000Z")])] });
  assert.deepEqual(diffSnapshots(d.snapshot, next).events.map((e) => e.ev), ["message_new"]);
});

test("watch: parseSidecar reads a sidecar, and returns null (retry) for torn ones", () => {
  const good = [
    "---",
    "review:",
    "  uid: u1",
    "  threads:",
    "    - id: t1",
    "      anchor: { type: text, quote: hi }",
    "      resolved: false",
    "      messages:",
    "        - { author: omar, ts: 2026-09-27T10:00:00.000Z, body: first }",
    "---",
    "",
    "# Comments",
  ].join("\n");
  const doc = parseSidecar(good, parseYaml);
  assert.equal(doc?.uid, "u1");
  assert.deepEqual(doc?.threads[0].messages, [msg("omar", "first")]);
  assert.equal(parseSidecar("", parseYaml), null, "empty (truncated before the write)");
  assert.equal(parseSidecar(good.slice(0, 60), parseYaml), null, "cut off inside the frontmatter");
  assert.equal(parseSidecar("---\nreview: [unclosed\n---\n", parseYaml), null, "YAML that doesn't parse");
  assert.equal(parseSidecar("---\ntitle: x\n---\n", parseYaml), null, "no review: key");
  assert.deepEqual(parseSidecar("---\nreview:\n  uid: u2\n---\n", parseYaml), { uid: "u2", threads: [] }, "a real sidecar with no threads");
});

test("watch: a deleted sidecar is held one pass, then its threads are removed", () => {
  const first = diffSnapshots(base, {});
  assert.deepEqual(first.events, [], "a delete-and-recreate blip must not read as a deletion");
  assert.deepEqual(first.missing, ["a.md"]);
  // It came back: nothing happened.
  assert.deepEqual(diffSnapshots(first.snapshot, base, { missing: first.missing }).events, []);
  // Still gone on the next pass: removed.
  const second = diffSnapshots(first.snapshot, {}, { missing: first.missing });
  assert.deepEqual(second.events, [{ ev: "thread_removed", file: "a.md", thread: "t1", author: "", msg: "first" }]);
  assert.deepEqual(second.snapshot, {});
  assert.deepEqual(second.missing, []);
});

test("watch: a renamed doc is one file_renamed, not every thread removed and re-added", () => {
  const moved = snap({ "sub/b.md": base["a.md"].threads }, () => "uid-a.md");
  assert.deepEqual(diffSnapshots(base, moved).events, [{ ev: "file_renamed", file: "sub/b.md", from: "a.md" }]);
  // No uid: the same thread ids pair them. A reply that landed with the move still shows.
  const noUid = snap({ "a.md": base["a.md"].threads }, () => null);
  const movedReplied = snap({ "c.md": [thread("t1", [msg("omar", "first"), msg("ana", "moved it", "2026-09-27T11:00:00.000Z")])] }, () => null);
  assert.deepEqual(
    diffSnapshots(noUid, movedReplied).events.map((e) => e.ev),
    ["file_renamed", "message_new"],
  );
});

test("watch: anchor_lost fires once when an open thread's passage goes, not for resolved ones", () => {
  const lost = snap({ "a.md": [thread("t1", base["a.md"].threads[0].messages, { lost: true })] });
  assert.deepEqual(diffSnapshots(base, lost).events.map((e) => e.ev), ["anchor_lost"]);
  assert.deepEqual(diffSnapshots(lost, structuredClone(lost)).events, [], "still lost: no repeat");
  const resolvedLost = snap({ "a.md": [thread("t1", base["a.md"].threads[0].messages, { lost: true, resolved: true })] });
  assert.deepEqual(diffSnapshots(base, resolvedLost).events.map((e) => e.ev), ["thread_resolved"]);
});

test("watch: replay emits every open thread (newest message), skipping resolved and ones the agent answered last", () => {
  const s = snap({
    "a.md": [
      thread("open1", [msg("omar", "q1")]),
      thread("done", [msg("omar", "q2")], { resolved: true }),
      thread("answered", [msg("omar", "q3"), msg("claude", "a3")]),
    ],
    "b.md": [thread("open2", [msg("omar", "q4"), msg("ana", "+1")], { lost: true })],
  });
  assert.deepEqual(
    replayEvents(s, { exclude: ["claude"] }).map((e) => [e.ev, e.file, e.thread, e.author]),
    [
      ["thread_open", "a.md", "open1", "omar"],
      ["thread_open", "b.md", "open2", "ana"],
      ["anchor_lost", "b.md", "open2", ""],
    ],
  );
  // Without --replay a first look is silent: diffing from the watch's own start
  // snapshot yields nothing, and the counts line says what's there.
  assert.deepEqual(diffSnapshots(s, structuredClone(s)).events, []);
  assert.deepEqual(snapshotCounts(s), { files: 2, threads: 4, open: 3, lost: 1 });
});

test("watch: lines are greppable key=value, msg quoted, one line, cut", () => {
  const long = "x".repeat(WATCH_MSG_MAX + 50);
  const line = formatEvent(
    { ev: "message_new", file: "Notes/My doc.md", thread: "t1", author: "Omar Eid", msg: `line one\nsaid "hi" \\ ${long}` },
    "2026-09-27T10:00:00.000Z",
    42,
  );
  assert.ok(line.startsWith('2026-09-27T10:00:00.000Z pid=42 ev=message_new file="Notes/My doc.md" thread=t1 author="Omar Eid" msg="line one said \\"hi\\" \\\\ x'));
  assert.ok(!line.includes("\n"));
  assert.ok(line.endsWith('…"'));
  assert.equal(logValue("plain"), "plain");
  assert.equal(logValue(""), '""');
  assert.equal(formatLogLine("T", 1, "heartbeat", { files: 3, open: 2, skipped: undefined }), "T pid=1 ev=heartbeat files=3 open=2");
});

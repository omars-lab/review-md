/**
 * The pure half of `reviews watch`: what changed between two looks at a folder's
 * comment threads, and how each change prints as one line. Obsidian-free and
 * I/O-free, so it runs under `node --test` like src/pure.ts; the CLI
 * (scripts/reviews.mjs) owns the file walking, fs.watch, polling and the clock.
 *
 * A snapshot is what one pass read: per reviewed doc (its vault-relative path), the
 * sidecar's uid and threads. A sidecar that couldn't be read on this pass — caught
 * mid-write, torn, not YAML yet — is passed as `unreadable`, and its last good
 * reading is carried over untouched: a half-written file must never read as
 * "every thread on this doc was removed".
 */

// Type-only (erased), so this module loads under plain Node with no path games; the
// CLI works out `lost` with pure.ts's anchorContentIn before handing threads over.
import type { ThreadLike } from "./pure";

/** One thread as the watcher remembers it. `lost`: the thing it points at is gone
 *  from the doc (only worked out for open threads; resolved ones don't matter). */
export interface WatchThread extends ThreadLike {
  lost?: boolean;
}

export interface WatchDoc {
  uid: string | null;
  threads: WatchThread[];
}

/** Vault-relative doc path → what its sidecar held on the last good read. */
export type WatchSnapshot = Record<string, WatchDoc>;

export type WatchEventName =
  | "thread_open" // --replay: a thread that was already open when the watch started
  | "thread_new" // a thread started since the last look
  | "message_new" // a new message on an existing thread
  | "message_edited" // an existing message's text changed
  | "thread_resolved"
  | "thread_reopened"
  | "anchor_lost" // an open thread's passage / box / arrow is gone from the doc
  | "thread_removed" // a thread (or the whole sidecar) was deleted
  | "file_renamed"; // a doc and its sidecar moved; `from` is the old path

export interface WatchEvent {
  ev: WatchEventName;
  file: string;
  thread?: string;
  /** Who did it, when the sidecar says: a message's author. "" when unknown. */
  author?: string;
  /** The message text (the newest one for a thread-level event). */
  msg?: string;
  /** file_renamed: the doc's previous path. */
  from?: string;
}

export interface DiffOptions {
  /** Drop events by these authors (case-insensitive), e.g. the agent's own replies. */
  exclude?: string[];
  /** Docs whose sidecar couldn't be parsed this pass: keep their last reading. */
  unreadable?: Iterable<string>;
  /** Docs already missing on the previous pass (that call's `missing`). A sidecar
   *  must be missing twice in a row before its threads count as removed — sync
   *  tools and some editors delete and re-create a file, and that blip must not
   *  read as a deletion. */
  missing?: Iterable<string>;
  /** Clock (epoch ms) for attributing a resolve — see resolveAuthor. */
  now?: number;
}

/** A resolve/reopen isn't stamped with who did it. When the thread's newest message
 *  is this recent, it's taken to be the resolver's — `reviews reply … --resolve`
 *  and "reply and resolve" in the panel both write the message first — so an
 *  excluded author's own resolve doesn't wake them. Older than this: unknown (""). */
export const RESOLVE_ATTRIBUTION_MS = 2 * 60_000;

function resolveAuthor(t: WatchThread, now: number | undefined): string {
  const last = t.messages.at(-1);
  if (!last || now === undefined) return "";
  const at = Date.parse(last.ts);
  return !Number.isNaN(at) && now - at >= 0 && now - at <= RESOLVE_ATTRIBUTION_MS ? last.author : "";
}

const msgKey = (m: { author: string; ts: string; body: string }) => `${m.author}\u0000${m.ts}\u0000${m.body}`;
const whoKey = (m: { author: string; ts: string }) => `${m.author}\u0000${m.ts}`;

/**
 * A sidecar's `review:` frontmatter as the watcher needs it, or null when the file
 * can't be read as one right now: no closed frontmatter block, YAML that doesn't
 * parse, or no `review:` key — what a sidecar caught mid-write looks like. The
 * caller retries on its next pass rather than reading null as "no threads".
 * `parseYaml` is passed in so this layer stays dependency-free.
 */
export function parseSidecar(raw: string, parseYaml: (src: string) => unknown): WatchDoc | null {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  let review: { uid?: unknown; threads?: unknown } | undefined;
  try {
    review = (parseYaml(fm[1]) as { review?: typeof review } | null)?.review;
  } catch {
    return null;
  }
  if (!review || typeof review !== "object") return null;
  const threads = Array.isArray(review.threads) ? (review.threads as WatchThread[]) : [];
  return {
    uid: typeof review.uid === "string" ? review.uid : null,
    threads: threads
      .filter((t) => t && typeof t.id === "string")
      .map((t) => ({
        id: t.id,
        resolved: !!t.resolved,
        anchor: t.anchor ?? {},
        messages: (Array.isArray(t.messages) ? t.messages : []).map((m) => ({
          author: String(m?.author ?? ""),
          ts: String(m?.ts ?? ""),
          body: String(m?.body ?? ""),
        })),
      })),
  };
}

/** Events for one doc's threads, before → after. */
function diffDoc(file: string, before: WatchThread[], after: WatchThread[], now: number | undefined): WatchEvent[] {
  const out: WatchEvent[] = [];
  const prev = new Map(before.map((t) => [t.id, t]));
  const next = new Set(after.map((t) => t.id));
  for (const t of after) {
    const old = prev.get(t.id);
    if (!old) {
      const first = t.messages[0];
      out.push({ ev: "thread_new", file, thread: t.id, author: first?.author ?? "", msg: first?.body ?? "" });
      // Any replies already on it when first seen count as messages too.
      for (const m of t.messages.slice(1)) out.push({ ev: "message_new", file, thread: t.id, author: m.author, msg: m.body });
      if (!t.resolved && t.lost) out.push({ ev: "anchor_lost", file, thread: t.id, author: "", msg: first?.body ?? "" });
      continue;
    }
    const seen = new Set(old.messages.map(msgKey));
    const who = new Map(old.messages.map((m) => [whoKey(m), m.body]));
    for (const m of t.messages) {
      if (seen.has(msgKey(m))) continue;
      const edited = who.has(whoKey(m));
      out.push({ ev: edited ? "message_edited" : "message_new", file, thread: t.id, author: m.author, msg: m.body });
    }
    if (old.resolved !== t.resolved) {
      out.push({
        ev: t.resolved ? "thread_resolved" : "thread_reopened",
        file,
        thread: t.id,
        author: resolveAuthor(t, now),
        msg: t.messages.at(-1)?.body ?? "",
      });
    }
    if (!t.resolved && t.lost && !(old.lost && !old.resolved)) {
      out.push({ ev: "anchor_lost", file, thread: t.id, author: "", msg: t.messages.at(-1)?.body ?? "" });
    }
  }
  for (const t of before) {
    if (!next.has(t.id)) out.push({ ev: "thread_removed", file, thread: t.id, author: "", msg: t.messages.at(-1)?.body ?? "" });
  }
  return out;
}

/** Same doc under a new name? Its sidecar carries a stable uid; failing that, the
 *  same non-empty set of thread ids. */
function sameDoc(a: WatchDoc, b: WatchDoc): boolean {
  if (a.uid && b.uid) return a.uid === b.uid;
  const ids = (d: WatchDoc) => d.threads.map((t) => t.id).sort().join("\u0000");
  return a.threads.length > 0 && ids(a) === ids(b);
}

function excluded(e: WatchEvent, exclude: Set<string>): boolean {
  return !!e.author && exclude.has(e.author.toLowerCase());
}

/**
 * Everything that happened between two looks, in a stable order (by doc path, then
 * the order threads sit in the sidecar). Also returns what to remember for the next
 * call: `snapshot` is `next` with each unreadable doc's last good reading carried
 * over — so a torn sidecar emits nothing now, and whatever really changed shows up
 * on the pass that reads it cleanly — and with each doc missing for the first time
 * held over too, listed in `missing` (pass it back as `opts.missing`).
 */
export function diffSnapshots(
  prev: WatchSnapshot,
  next: WatchSnapshot,
  opts: DiffOptions = {},
): { events: WatchEvent[]; snapshot: WatchSnapshot; missing: string[] } {
  const unreadable = new Set(opts.unreadable ?? []);
  const missedBefore = new Set(opts.missing ?? []);
  const exclude = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  const snapshot: WatchSnapshot = { ...next };
  for (const f of unreadable) {
    delete snapshot[f];
    if (prev[f]) snapshot[f] = prev[f];
  }
  const gone = Object.keys(prev).filter((f) => !(f in snapshot));
  const arrived = Object.keys(snapshot).filter((f) => !(f in prev));
  const renamedFrom = new Map<string, string>(); // new path → old path
  for (const f of arrived) {
    const old = gone.find((g) => ![...renamedFrom.values()].includes(g) && sameDoc(prev[g], snapshot[f]));
    if (old) renamedFrom.set(f, old);
  }
  const paired = new Set(renamedFrom.values());
  const missing: string[] = [];
  for (const g of gone) {
    if (paired.has(g) || missedBefore.has(g)) continue;
    snapshot[g] = prev[g]; // first time missing: hold it one more pass
    missing.push(g);
  }
  const events: WatchEvent[] = [];
  const files = [...new Set([...Object.keys(prev), ...Object.keys(snapshot)])].sort();
  for (const f of files) {
    if (paired.has(f)) continue; // reported under its new name
    const from = renamedFrom.get(f);
    if (from) events.push({ ev: "file_renamed", file: f, from });
    const before = (from ? prev[from] : prev[f])?.threads ?? [];
    const after = snapshot[f]?.threads ?? [];
    events.push(...diffDoc(f, before, after, opts.now));
  }
  return { events: events.filter((e) => !excluded(e, exclude)), snapshot, missing };
}

/** `--replay`: every thread open right now, as if it had just arrived — one
 *  `thread_open` each (its newest message, so the author is who spoke last and an
 *  excluded author's threads are the ones already answered), plus `anchor_lost` for
 *  those whose passage is already gone. */
export function replayEvents(snapshot: WatchSnapshot, opts: { exclude?: string[] } = {}): WatchEvent[] {
  const exclude = new Set((opts.exclude ?? []).map((a) => a.toLowerCase()));
  const out: WatchEvent[] = [];
  for (const f of Object.keys(snapshot).sort()) {
    for (const t of snapshot[f].threads) {
      if (t.resolved) continue;
      const last = t.messages.at(-1);
      const e: WatchEvent = { ev: "thread_open", file: f, thread: t.id, author: last?.author ?? "", msg: last?.body ?? "" };
      if (excluded(e, exclude)) continue;
      out.push(e);
      if (t.lost) out.push({ ev: "anchor_lost", file: f, thread: t.id, author: "", msg: last?.body ?? "" });
    }
  }
  return out;
}

/** Counts for the start-up line and heartbeats. */
export function snapshotCounts(snapshot: WatchSnapshot): { files: number; threads: number; open: number; lost: number } {
  let threads = 0;
  let open = 0;
  let lost = 0;
  for (const d of Object.values(snapshot)) {
    threads += d.threads.length;
    for (const t of d.threads) {
      if (t.resolved) continue;
      open++;
      if (t.lost) lost++;
    }
  }
  return { files: Object.keys(snapshot).length, threads, open, lost };
}

/** How long a `msg="…"` gets on a text line before it's cut with "…". */
export const WATCH_MSG_MAX = 200;

/** A value for a `key=value` line: bare when it has no spaces, quotes or `=`,
 *  else double-quoted with `\` and `"` escaped. Newlines are always collapsed. */
export function logValue(v: unknown, max = Infinity): string {
  let s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s !== "" && !/[\s"=\\]/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * One greppable line: `<utc> pid=<n> ev=<event> key=value … msg="…"`. `fields` go
 * out in the order given, with `msg` always last and cut to `WATCH_MSG_MAX`, so
 * `grep ev=message_new` and a `key=value` split both work on every line.
 */
export function formatLogLine(ts: string, pid: number, ev: string, fields: Record<string, unknown> = {}): string {
  const parts = [ts, `pid=${pid}`, `ev=${ev}`];
  for (const [k, v] of Object.entries(fields)) {
    if (k === "msg" || v === undefined) continue;
    parts.push(`${k}=${logValue(v)}`);
  }
  if ("msg" in fields && fields.msg !== undefined) parts.push(`msg=${logValue(fields.msg, WATCH_MSG_MAX)}`);
  return parts.join(" ");
}

/** A watch event as a text line (see formatLogLine). */
export function formatEvent(e: WatchEvent, ts: string, pid: number): string {
  const { ev, ...rest } = e;
  return formatLogLine(ts, pid, ev, rest);
}

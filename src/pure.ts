/**
 * Obsidian-free pure helpers — the content-hashing, revision-labelling and
 * text-window logic that has no dependency on the Obsidian API. Split out of
 * `main.ts` / `views/comments-view.ts` so it can be unit-tested under plain Node
 * (`node --test`, which strips the `.ts` natively); importing `obsidian` throws
 * outside the renderer, so anything under test must live here. main.ts and the
 * comments view re-import from this module — this is the single source of truth.
 */

/**
 * Sentinel `rev.git.commit` for a comment left on the *uncommitted working copy*
 * of a file (its body differs from the committed blob at authoring time). A
 * post-commit hook re-anchors such threads to the real commit sha once the file
 * is committed. See docs/issues/version-stamping.md.
 */
export const WORKING_REV = "working";

/** The subset of a thread's `rev` that revision identity depends on. Kept minimal
 *  so the pure layer needn't import the full `ReviewRev` interface from main. */
export interface RevLike {
  bodyHash?: string;
  git?: { commit?: string };
}

/** Strip a leading YAML frontmatter block so we hash only the reviewed body.
 *  The middle is optional so an empty block (`---\n---`) is stripped too, not
 *  hashed as body. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const m = text.match(/^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

/**
 * Strip Obsidian block-id markers (`^id`) so they don't count toward the content
 * hash: they're anchoring scaffolding review-md writes, not reviewed prose, so
 * adding/removing an anchor must not change `bodyHash`. Matches a trailing ` ^id`
 * at a line's end and a standalone `^id` line. Deliberately broad (any block id,
 * not only ours) — a block id is structural metadata by nature.
 */
export function stripBlockIds(text: string): string {
  return text
    .replace(/[ \t]+\^[A-Za-z0-9_-]+[ \t]*$/gm, "")
    .replace(/^\^[A-Za-z0-9_-]+[ \t]*$/gm, "");
}

/**
 * Remove one specific block id from source text: a trailing ` ^id` on a block's
 * line, or a standalone `^id` line (with its blank line). Used to clean up when a
 * thread that owned the id is deleted and no other thread references it.
 */
export function removeBlockIdFromText(text: string, blockId: string): string {
  const esc = blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`[ \\t]+\\^${esc}(?=[ \\t]*$)`, "gm"), "")
    .replace(new RegExp(`^\\^${esc}[ \\t]*\\r?\\n?`, "gm"), "");
}

/**
 * The text of the block bearing `^blockId`, with the id marker stripped, or null
 * if the id isn't present in `text`. A "block" is the run of consecutive non-blank
 * lines around the id line (stopping at a blank line or a code fence) — the same
 * unit a text anchor points at. Used by the per-anchor staleness check to read
 * just the anchored block's current content from the latest file.
 */
export function blockTextFor(text: string, blockId: string): string | null {
  const esc = blockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = new RegExp(`(^|\\s)\\^${esc}[ \\t]*$`);
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => idRe.test(l));
  if (idx < 0) return null;
  const fence = (l: string) => /^[ \t]*`{3,}/.test(l);
  let start = idx;
  let end = idx;
  while (start > 0 && lines[start - 1].trim() !== "" && !fence(lines[start - 1])) start--;
  while (end + 1 < lines.length && lines[end + 1].trim() !== "" && !fence(lines[end + 1])) end++;
  return removeBlockIdFromText(lines.slice(start, end + 1).join("\n"), blockId).trim();
}

/**
 * The author name new sidebar-authored messages (comments + replies) are stamped
 * with: the trimmed reviewer name, or `"reviewer"` when it's blank. Deliberately
 * never defaults to a specific person's name — a shipped default must be generic.
 */
export function effectiveReviewer(name: string): string {
  return name.trim() || "reviewer";
}

/** Short hex sha256 of a string. Uses Web Crypto (`crypto.subtle`), available both
 *  in the Obsidian renderer and in Node ≥20 as a global. */
export async function sha256Short(text: string, len = 12): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

/** The content hash of a file body: frontmatter and block-id markers stripped,
 *  then sha256[:12]. The one definition of "reviewed content" identity — adding a
 *  comment's anchor (`^id`) or editing the sidecar frontmatter must never flip it.
 *  scripts/review-threads.mjs mirrors this with node:crypto and MUST stay in sync. */
export function bodyHash(text: string): Promise<string> {
  return sha256Short(stripBlockIds(stripFrontmatter(text)));
}

/**
 * Number every commit sha in a `git log --follow --format=%h` output, oldest = 1.
 *
 * `--follow` can't be combined with `--reverse` (git then drops the rename trace
 * and returns only the tip commit — it silently broke v-numbering the moment
 * design.md moved into docs/designs/), so the log is fetched newest→oldest and
 * reversed here: the ordinal is the 1-based position counting from the oldest
 * commit, so the newest commit gets the highest `v`. See
 * docs/issues/docs-vault-and-follow-reverse.md.
 */
export function ordinalsFromLog(log: string): Map<string, number> {
  const out = new Map<string, number>();
  const shas = log
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
  shas.forEach((sha, i) => out.set(sha, i + 1));
  return out;
}

/**
 * Every ```mermaid fence body in a markdown text, in document order. The one
 * definition of "the mermaid sources in this doc" — used both against the current
 * file and against a reviewed (previous) version pulled from git, so a node/edge's
 * preview can be rebuilt from whichever version we're showing. Matches a fence of
 * three-or-more backticks tagged `mermaid`, capturing the inner source only.
 */
export function mermaidBlocksFrom(text: string): string[] {
  const re = /^[ \t]*`{3,}\s*mermaid\s*\r?\n([\s\S]*?)\r?\n[ \t]*`{3,}\s*$/gm;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
}

/** Identity of the revision a thread was authored against — the SAME value the
 *  card's version stamp shows: a git commit (incl. WORKING_REV) when the file was
 *  tracked, else the body-hash. `null` for an unstamped thread. */
export function revKeyOf(rev: RevLike | undefined): string | null {
  if (!rev) return null;
  if (rev.git?.commit) return rev.git.commit;
  if (rev.bodyHash) return rev.bodyHash;
  return null;
}

/** Human label for a revision key: "Working copy", a git version number
 *  (`v7 (b24cd88)`), or the bare body-hash slug when there's no git ordinal. */
export function revLabelFor(key: string, ordinals: Map<string, number>): string {
  if (key === WORKING_REV) return "Working copy";
  const v = ordinals.get(key);
  return v ? `v${v} (${key.slice(0, 7)})` : key.slice(0, 7);
}

/**
 * A readable window of the reviewed body: centred on the anchor quote when it's
 * still present, else the opening lines. Keeps the panel from dumping a whole file.
 */
export function snippetAround(body: string, quote: string, radius = 240): string {
  const q = quote.trim().slice(0, 60);
  const at = q ? body.indexOf(q) : -1;
  if (at === -1) {
    const head = body.trim().slice(0, radius * 2);
    return body.length > head.length ? `${head}…` : head;
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + q.length + radius);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

/** Elide the middle of a long string: "start … end", keeping both ends visible. */
export function middleEllipsis(s: string, max = 180): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 3) * 0.6);
  const tail = Math.floor((max - 3) * 0.4);
  return `${s.slice(0, head).trimEnd()} … ${s.slice(s.length - tail).trimStart()}`;
}

// ---- Comments panel: the surgical-update diff ----

/** The slice of a thread the comments panel paints from. Structurally matches
 *  `ReviewThread` in main.ts (kept separate so this layer stays Obsidian-free). */
export interface ThreadLike {
  id: string;
  resolved: boolean;
  anchor: Record<string, unknown>;
  messages: { author: string; ts: string; body: string }[];
  rev?: unknown;
}

/** The parts of a thread that map to separate regions of its card, so a change
 *  can be repainted where it landed and nowhere else. */
export type ThreadField = "resolved" | "messages" | "anchor" | "rev";

export interface ThreadDiff {
  /** Ids in `next` but not `prev` — need a new card. */
  added: string[];
  /** Ids in `prev` but not `next` — card to remove. */
  removed: string[];
  /** Ids in both whose content differs, with the fields that moved. */
  changed: { id: string; fields: ThreadField[] }[];
}

/** One-line identity of a thread's message list: author + ts + body per message. */
function messagesKey(t: ThreadLike): string {
  return t.messages.map((m) => `${m.author}\u0000${m.ts}\u0000${m.body}`).join("\u0001");
}

/** Short content-type label for a card's type badge (and the search haystack). */
export function anchorTypeLabel(anchor: Record<string, unknown>): string {
  switch (String(anchor?.type ?? "unknown")) {
    case "mermaidNode":
      return "node";
    case "mermaidEdge":
      return "edge";
    default:
      return String(anchor?.type ?? "unknown"); // text / image / header / link pass through
  }
}

/**
 * Compare what the panel currently shows against a freshly-read thread list and
 * name exactly what moved. This is the whole basis of the panel's surgical
 * updates (docs/issues/panel-surgical-updates.md): after a write only the cards
 * named here are touched, so an in-progress reply on another card, its scroll
 * position, focus and open previews survive. Field changes are attributed
 * per region — `messages` (a reply/edit/delete), `resolved` (toggle), `anchor`
 * (re-anchor hook) and `rev` (re-stamp) — so the caller can repaint the messages
 * list without rebuilding the card. Order within the lists follows `prev`/`next`.
 */
export function diffThreads(prev: ThreadLike[], next: ThreadLike[]): ThreadDiff {
  const before = new Map(prev.map((t) => [t.id, t]));
  const after = new Map(next.map((t) => [t.id, t]));
  const out: ThreadDiff = { added: [], removed: [], changed: [] };
  for (const t of prev) if (!after.has(t.id)) out.removed.push(t.id);
  for (const t of next) {
    const old = before.get(t.id);
    if (!old) {
      out.added.push(t.id);
      continue;
    }
    const fields: ThreadField[] = [];
    if (old.resolved !== t.resolved) fields.push("resolved");
    if (messagesKey(old) !== messagesKey(t)) fields.push("messages");
    if (JSON.stringify(old.anchor) !== JSON.stringify(t.anchor)) fields.push("anchor");
    if (JSON.stringify(old.rev ?? null) !== JSON.stringify(t.rev ?? null)) fields.push("rev");
    if (fields.length) out.changed.push({ id: t.id, fields });
  }
  return out;
}

// ---- Comments panel: search / sort / doc position / fold ----

/** Everything the header search box matches against, lower-cased: the thread
 *  id, the anchor's type label and every string it carries (quote, href, src,
 *  node, edge endpoints…), and each message's author and body. */
export function threadSearchText(t: ThreadLike): string {
  const parts: string[] = [t.id, anchorTypeLabel(t.anchor)];
  for (const v of Object.values(t.anchor ?? {})) if (typeof v === "string") parts.push(v);
  for (const m of t.messages) parts.push(m.author, m.body);
  return parts.join("\n").toLowerCase();
}

/** Case-insensitive substring match of the search box against a thread; an
 *  empty (or whitespace) query matches everything. */
export function threadMatches(t: ThreadLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || threadSearchText(t).includes(q);
}

export type ThreadSort = "recency" | "position" | "author";
/** The sort menu's items, in menu order. */
export const THREAD_SORTS: { key: ThreadSort; label: string }[] = [
  { key: "recency", label: "Recency" },
  { key: "position", label: "Doc position" },
  { key: "author", label: "Author" },
];

/** When the thread last moved: its newest message's timestamp (ms), falling back
 *  to the authoring stamp `rev.ts`, else 0. */
export function latestTs(t: ThreadLike): number {
  let max = 0;
  for (const m of t.messages) {
    const n = Date.parse(m.ts);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  if (max === 0) {
    const ts = (t.rev as { ts?: unknown } | undefined)?.ts;
    const n = typeof ts === "string" ? Date.parse(ts) : NaN;
    if (!Number.isNaN(n)) max = n;
  }
  return max;
}

/**
 * The panel's display order. Open threads always lead and resolved ones trail
 * (today's behaviour, kept in every mode); within each group the chosen sort
 * applies — newest activity first, document position (via `positions`, see
 * anchorLineIn; unknown positions sort last), or first author A→Z — and ties
 * fall back to recency, then to the sidecar's own (creation) order, which a
 * stable sort keeps.
 */
export function compareThreads(
  a: ThreadLike,
  b: ThreadLike,
  sort: ThreadSort,
  positions?: Map<string, number>,
): number {
  const grp = Number(a.resolved) - Number(b.resolved);
  if (grp) return grp;
  if (sort === "position") {
    const pa = positions?.get(a.id) ?? Infinity;
    const pb = positions?.get(b.id) ?? Infinity;
    if (pa !== pb) return pa - pb;
  } else if (sort === "author") {
    const c = (a.messages[0]?.author ?? "").localeCompare(b.messages[0]?.author ?? "", undefined, {
      sensitivity: "base",
    });
    if (c) return c;
  }
  return latestTs(b) - latestTs(a);
}

export function sortThreads<T extends ThreadLike>(threads: T[], sort: ThreadSort, positions?: Map<string, number>): T[] {
  return [...threads].sort((a, b) => compareThreads(a, b, sort, positions));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where a thread's anchor sits in `body`, as a 0-based line — the "doc position"
 * sort key, read fresh from the current text so it tracks edits. Per anchor type
 * the best signal available:
 *   - text / header: the line carrying the anchor's `^blockId` (durable across
 *     edits) — else the first line containing the quote — else `anchor.line` as
 *     recorded at click time.
 *   - mermaidNode: the first line inside a ```mermaid fence that names the node
 *     id, so nodes sort in declaration order within a diagram and diagrams in
 *     document order.
 *   - mermaidEdge: the line of the `from … --> … to` link; else the first line
 *     naming `from` in a fence that also names `to`.
 *   - image: the first line mentioning the src (or its file name — the DOM src is
 *     an app:// URL, the source holds the vault path).
 *   - link: the first line mentioning the href, else the link text.
 * `null` when nothing matches (the thread sorts last).
 */
export function anchorLineIn(body: string, anchor: Record<string, unknown>): number | null {
  const a = anchor as {
    type?: string;
    blockId?: string;
    quote?: string;
    line?: number;
    node?: string;
    from?: string;
    to?: string;
    src?: string;
    href?: string;
  };
  const lines = body.split(/\r?\n/);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const first = (pred: (l: string) => boolean, from = 0, to = lines.length): number | null => {
    for (let i = from; i < to; i++) if (pred(lines[i])) return i;
    return null;
  };
  const names = (id: string) => {
    const re = new RegExp(`(^|[^\\w])${escapeRe(id)}([^\\w]|$)`);
    return (l: string) => re.test(l);
  };
  // Inner line ranges [start, end) of every ```mermaid fence, in document order.
  const fences: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*`{3,}\s*mermaid\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !/^[ \t]*`{3,}\s*$/.test(lines[j])) j++;
    fences.push([i + 1, j]);
    i = j;
  }
  const byQuote = (): number | null => {
    const q = a.quote ? norm(a.quote).slice(0, 60) : "";
    return q ? first((l) => norm(l).includes(q)) : null;
  };

  switch (a.type) {
    case "mermaidNode": {
      if (!a.node) return null;
      const has = names(a.node);
      for (const [s, e] of fences) {
        const at = first(has, s, e);
        if (at !== null) return at;
      }
      return null;
    }
    case "mermaidEdge": {
      if (!a.from || !a.to) return null;
      const link = new RegExp(
        `(^|[^\\w])${escapeRe(a.from)}\\b.*?(?:--+>?|==+>?|-\\.-*>?|~~+).*?\\b${escapeRe(a.to)}([^\\w]|$)`,
      );
      for (const [s, e] of fences) {
        const at = first((l) => link.test(l), s, e);
        if (at !== null) return at;
      }
      const hasFrom = names(a.from);
      const hasTo = names(a.to);
      for (const [s, e] of fences) {
        if (first(hasTo, s, e) === null) continue;
        const at = first(hasFrom, s, e);
        if (at !== null) return at;
      }
      return null;
    }
    case "text":
    case "header": {
      if (a.blockId) {
        const idRe = new RegExp(`(^|\\s)\\^${escapeRe(a.blockId)}[ \\t]*$`);
        const at = first((l) => idRe.test(l));
        if (at !== null) return at;
      }
      const at = byQuote();
      if (at !== null) return at;
      return typeof a.line === "number" && Number.isFinite(a.line) ? a.line : null;
    }
    case "image": {
      const src = a.src?.trim() ?? "";
      if (!src) return null;
      const at = first((l) => l.includes(src));
      if (at !== null) return at;
      const base = src.split("/").pop()?.split("?")[0] ?? "";
      return base ? first((l) => l.includes(base)) : null;
    }
    case "link": {
      const href = a.href?.trim() ?? "";
      const at = href ? first((l) => l.includes(href)) : null;
      return at ?? byQuote();
    }
    default:
      return byQuote();
  }
}

/** Which source lines carry open comments, for the mark beside a commented
 *  passage. Line (0-based, in `text` as given) → thread ids, in thread order.
 *  Diagram threads are left out: diagrams mark their own nodes and arrows. */
export function commentedLines(text: string, threads: ThreadLike[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const t of threads) {
    if (t.resolved) continue;
    const type = String(t.anchor?.type ?? "");
    if (type === "mermaidNode" || type === "mermaidEdge") continue;
    const line = anchorLineIn(text, t.anchor);
    if (line === null) continue;
    out.set(line, [...(out.get(line) ?? []), t.id]);
  }
  return out;
}

/** Threads with more than this many messages start folded to their last one. */
export const FOLD_OVER = 3;

/** Whether a card starts folded when first built: resolved threads (settled,
 *  read rarely) and long ones. The user's own fold/unfold is remembered per
 *  thread id afterwards, so this only ever seeds the state. */
export function startsFolded(t: ThreadLike): boolean {
  return t.resolved || t.messages.length > FOLD_OVER;
}

// ---- Export: a Markdown digest of threads for AI tools ----
//
// One format for every way threads leave the vault: the "Copy threads for AI"
// command, the `review-md-export` URL, and scripts/review-threads.mjs (which
// imports this file). An agent reading any of them sees the same shape.

/** One line saying where a thread is anchored, for every anchor type. */
export function anchorWhere(anchor: Record<string, unknown> = {}): string {
  const s = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").slice(0, max);
  switch (anchor.type) {
    case "mermaidNode":
      return `diagram node ${s(anchor.node, 80)}`;
    case "mermaidEdge":
      return `diagram edge ${s(anchor.from, 80)} → ${s(anchor.to, 80)}`;
    case "image":
      return `image ${s(anchor.src, 120)}`;
    case "link":
      return `link ${anchor.quote ? `“${s(anchor.quote, 60)}” ` : ""}→ ${s(anchor.href, 120)}`;
    default:
      return anchor.quote ? `“${s(anchor.quote, 100)}”` : String(anchor.type ?? "text");
  }
}

export interface ExportFilter {
  /** Keep resolved threads too (default: open only). */
  includeResolved?: boolean;
  /** Keep only threads matching this text — same match as the panel's search box. */
  text?: string;
}

/** The threads an export keeps: open ones (unless `includeResolved`) matching `text`. */
export function filterThreads<T extends ThreadLike>(threads: T[], filter: ExportFilter = {}): T[] {
  return threads.filter((t) => (filter.includeResolved || !t.resolved) && threadMatches(t, filter.text ?? ""));
}

export interface DigestFile {
  /** Path of the reviewed doc (vault-relative in the plugin, as given in the script). */
  path: string;
  /** `current`: for an outdated thread, what the commented passage says today —
   *  `null` when it's gone from the doc. A chat AI can't open the doc, so without
   *  it all it has is the old quote. */
  threads: (ThreadLike & { outdated?: boolean; current?: string | null })[];
}

/**
 * Render threads as a Markdown digest an AI tool can act on: per file, each
 * thread's anchor, state, the version it was written against and every message.
 * With `vault`, each thread also carries its open link and a reply-link template,
 * so an agent can answer through the x-callback API. Files with no threads left
 * after filtering are dropped.
 */
export function threadsDigest(
  files: DigestFile[],
  opts: { scope: string; filter?: ExportFilter; vault?: string } = { scope: "vault" },
): string {
  const kept = files.filter((f) => f.threads.length);
  const count = kept.reduce((n, f) => n + f.threads.length, 0);
  const what = [
    opts.filter?.includeResolved ? "open and resolved" : "open",
    opts.filter?.text?.trim() ? `matching “${opts.filter.text.trim()}”` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `# review-md comments — ${opts.scope}`,
    "",
    `${count} thread${count === 1 ? "" : "s"} (${what}) in ${kept.length} file${kept.length === 1 ? "" : "s"}.`,
  ];
  if (count)
    lines.push(
      "",
      "These are review comments people left on the docs below. For each thread, change the doc " +
        "or answer the question, and say what you did. OUTDATED means the passage changed since the " +
        "comment was written; check it still applies.",
    );
  for (const f of kept) {
    lines.push("", `## ${f.path}`);
    for (const t of f.threads) {
      const tags = [t.resolved ? "resolved" : "open", t.outdated ? "OUTDATED" : null].filter(Boolean);
      lines.push("", `### [${t.id}] ${anchorWhere(t.anchor)} (${tags.join(", ")})`);
      const rev = t.rev as { ts?: string; bodyHash?: string; git?: { commit?: string } } | undefined;
      if (rev) lines.push(`reviewed against: ${rev.git?.commit ?? rev.bodyHash ?? "?"} · ${rev.ts ?? "?"}`);
      if (t.outdated && t.current !== undefined)
        lines.push(t.current === null ? "now: (no longer in the doc)" : `now reads: “${t.current.replace(/\s+/g, " ").slice(0, 400)}”`);
      if (opts.vault) {
        const q = (p: Record<string, string>) => new URLSearchParams(p).toString().replace(/\+/g, "%20");
        lines.push(`open: obsidian://review-md-open?${q({ vault: opts.vault, file: f.path, thread: t.id })}`);
        lines.push(
          `reply: obsidian://review-md-reply?${q({ vault: opts.vault, file: f.path, thread: t.id })}&author=<name>&body=<url-encoded reply>`,
        );
      }
      if (!t.messages.length) lines.push("", "_(no messages)_");
      for (const m of t.messages) lines.push("", `**${m.author}** · ${m.ts}`, "", m.body);
    }
  }
  if (!count) lines.push("", "_No threads match._");
  return lines.join("\n") + "\n";
}

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

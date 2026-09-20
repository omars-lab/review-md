import {
  Plugin,
  Notice,
  TFile,
  MarkdownView,
  normalizePath,
  MarkdownPostProcessorContext,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import xcallbackSchema from "./protocol/xcallback.schema.json";
import { CommentsView, VIEW_TYPE_COMMENTS } from "./views/comments-view";

interface XcallbackParam {
  name: string;
  required: boolean;
  type: string;
  enum?: string[];
  default?: string;
  description: string;
  example?: string;
  // Required in the URL for Obsidian's own routing (e.g. `vault`), but Obsidian
  // consumes it and never delivers it to the handler — so the plugin must NOT
  // validate its presence. See docs/issues/xcallback-reserved-params.md.
  reserved?: boolean;
}
interface XcallbackOperation {
  id: string;
  action: string;
  summary: string;
  description: string;
  params: XcallbackParam[];
}

/**
 * review-md — scaffold entry point.
 *
 * Minimal on purpose: it stands up the plugin, registers the
 * `obsidian://review-md` protocol handler (POC-1), and ships a self-reporting
 * POC-4 command that exercises processFrontMatter at scale. Both POCs write a
 * report note into the vault so results are verifiable from the file system
 * (no dev console needed). See docs/pocs/.
 */

const POC4_THREADS = 50;

export interface ReviewMessage { author: string; ts: string; body: string; }
/**
 * The version a comment was authored against (req: track comments per committed
 * version of the file). `bodyHash` is a sha256 of the document BODY with the
 * YAML frontmatter stripped — frontmatter is where the comments live, so hashing
 * the whole file would change every time a comment is added and false-flag every
 * thread. `git`, present only when the file is in a git work tree, records the
 * short HEAD commit and the committed blob (`HEAD:<path>`) so a reviewer/agent
 * can `git show <commit>:<path>` the exact reviewed text. See
 * docs/issues/version-stamping.md.
 */
export interface ReviewRev {
  bodyHash: string;
  ts: string;
  git?: { commit: string; blob: string };
}
export interface ReviewThread {
  id: string;
  anchor: Record<string, unknown>;
  resolved: boolean;
  messages: ReviewMessage[];
  rev?: ReviewRev;
}
/** The `review:` block: a file's threads + a rename-stable file id. Stored in the
 *  sibling sidecar (`.<basename>.comments.md`), NOT the reviewed file itself. */
export interface ReviewData {
  uid: string;
  threads: ReviewThread[];
}

const mkId = () => Math.random().toString(36).substring(2, 8);

/** Node's `require`, or undefined on mobile / restricted renderers. */
function nodeRequire(mod: string): any {
  try {
    return (window as unknown as { require?: (m: string) => unknown }).require?.(mod);
  } catch {
    return undefined;
  }
}

/** Strip a leading YAML frontmatter block so we hash only the reviewed body. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

/** Short hex sha256 of a string (Web Crypto — available in the renderer). */
async function sha256Short(text: string, len = 12): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

const POC4_BODIES = [
  "why radial here? seems arbitrary",
  'key: value looking text with "quotes" and a trailing colon:',
  "multi-line\nreply with a second line\n- and a bullet",
  "# looks like a heading and `code` and [a link](https://x.test)",
  "unicode ✓ diacritics ū ḥ ʿ emoji 🎯 keep intact",
];

function makePoc4Thread(i: number): ReviewThread {
  const id = mkId();
  const anchor =
    i % 5 === 0
      ? { type: "image", src: `img/plate-${i}.png` }
      : { type: "text", line: i * 3, blockId: id, quote: `anchored phrase number ${i}` };
  const messages: ReviewMessage[] = Array.from({ length: (i % 4) + 1 }, (_, m) => ({
    author: m % 2 === 0 ? "omar" : "claude",
    ts: new Date(Date.UTC(2026, 8, 19, 10, i % 60, m % 60)).toISOString(),
    body: POC4_BODIES[(i + m) % POC4_BODIES.length],
  }));
  return { id, anchor, resolved: i % 7 === 0, messages };
}

export default class ReviewMdPlugin extends Plugin {
  /** True while "comment mode" is armed: the reader is click-to-comment. */
  private commentMode = false;
  private commentRibbon: HTMLElement | null = null;

  async onload(): Promise<void> {
    console.log("[review-md] loaded");

    // One Obsidian action per operation: obsidian://review-md-open?..., review-md-reply?...
    // We can't use a single handler with an `action`/`op` query selector because
    // Obsidian *reserves* those: it overwrites `action` with the handler's own name
    // and consumes `vault` for routing before the handler runs. So the operation is
    // the action name itself. Actions + params live in src/protocol/xcallback.schema.json
    // (the single source of truth docs/api/* is generated from).
    // See docs/issues/xcallback-reserved-params.md.
    for (const op of xcallbackSchema.operations as XcallbackOperation[]) {
      this.registerObsidianProtocolHandler(op.action, async (params) => {
        try {
          this.validateParams(op, params);
          if (op.id === "reply") await this.handleReply(params);
          else await this.handleUri(op, params);
          if (params["x-success"]) window.open(String(params["x-success"]));
        } catch (err) {
          console.error("[review-md] protocol error", err);
          if (params["x-error"]) window.open(String(params["x-error"]));
          else new Notice(`review-md: ${String(err)}`);
        }
      });
    }

    // Comments sidebar — the reviewer UI for viewing/replying to threads
    // (reqs 3/4/5). It reads/writes through this plugin's shared helpers, so
    // the sidebar and the x-callback `reply` action stay on one code path.
    this.registerView(VIEW_TYPE_COMMENTS, (leaf) => new CommentsView(leaf, this));
    this.addRibbonIcon("message-square", "review-md: comments", () => void this.activateCommentsView());
    this.addCommand({
      id: "open-comments-view",
      name: "Open comments sidebar",
      callback: () => void this.activateCommentsView(),
    });

    // Comment mode (req 2) — Figma-style: toggle the reader into a click-to-
    // comment surface (custom cursor), and each click drops a thread anchored to
    // the highlighted selection, or to the clicked image / mermaid node.
    this.commentRibbon = this.addRibbonIcon("messages-square", "review-md: comment mode", () =>
      this.setCommentMode(!this.commentMode),
    );
    this.addCommand({
      id: "toggle-comment-mode",
      name: "Toggle comment mode (click to drop comments)",
      // No default hotkey: a bare unmodified `c` as an Obsidian command hotkey
      // fires even while a textarea is focused, so it ate the letter mid-reply.
      // The quick `c` toggle lives in the guarded keydown below instead; users
      // can still bind their own hotkey to this command in Settings.
      callback: () => this.setCommentMode(!this.commentMode),
    });
    // Convenience: bare `c` toggles comment mode, but ONLY when the user isn't
    // typing — skip when focus is in an input/textarea/contenteditable or the
    // CodeMirror editor, and when any modifier is held (so Cmd-C etc. pass).
    this.registerDomEvent(document, "keydown", (evt) => {
      if (evt.key !== "c" || evt.metaKey || evt.ctrlKey || evt.altKey) return;
      if (this.isTypingTarget(evt.target)) return;
      evt.preventDefault();
      this.setCommentMode(!this.commentMode);
    });
    // Capture-phase so we intercept the click before Obsidian follows links etc.
    this.registerDomEvent(document, "click", (evt) => this.handleCommentClick(evt), { capture: true });

    this.addCommand({
      id: "poc4-seed-verify-frontmatter",
      name: "POC-4 seed & verify frontmatter threads",
      callback: () => void this.runPoc4(),
    });

    // POC-6: augmented mermaid render. Obsidian renders mermaid through its own
    // markdown renderer (not the public code-block registry), so we can't
    // override it with registerMarkdownCodeBlockProcessor. Instead we
    // post-process: wait for the built-in SVG, then replace it with a render of
    // `source + injected comment nodes`. Running inside the post-processor means
    // it re-applies on every re-render (scroll/edit) — unlike a one-shot DOM
    // poke, which Obsidian's next render reverts. Diagram source is untouched.
    this.registerMarkdownPostProcessor((el, ctx) => {
      const src = this.mermaidSourceFor(el, ctx);
      if (src === null) return;
      void this.augmentRenderedMermaid(el, src, ctx.sourcePath);
    });

    // Req 9 (bake): fold the injected comment nodes into the stored ```mermaid
    // source on demand — the destructive opt-in. After baking, the live
    // augmenter skips those threads (they're detected as already in-source), so
    // there's no double injection. Idempotent: re-running skips baked threads.
    this.addCommand({
      id: "bake-mermaid-comments",
      name: "Bake comments into diagram(s)",
      callback: () => void this.bakeMermaidComments(),
    });
  }

  onunload(): void {
    console.log("[review-md] unloaded");
    document.body.removeClass("review-md-comment-mode");
  }

  /** Reveal the comments sidebar (reusing an open one), then focus it. */
  private async activateCommentsView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_COMMENTS, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // ---- Comment mode: click-to-comment authoring (req 2) ----

  /** Arm/disarm comment mode: toggles the body class (cursor + affordances). */
  private setCommentMode(on: boolean): void {
    this.commentMode = on;
    document.body.toggleClass("review-md-comment-mode", on);
    this.commentRibbon?.toggleClass("is-active", on);
    new Notice(`review-md: comment mode ${on ? "on — click to comment" : "off"}`);
  }

  /** True if the event target is an editable field, so a bare `c` should type. */
  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable ||
      !!el.closest(".cm-editor")
    );
  }

  /** The `.markdown-reading-view` for a rendered element, or null (e.g. editing). */
  private readingContainerFor(el: HTMLElement): HTMLElement | null {
    return el.closest(".markdown-reading-view, .markdown-preview-view");
  }

  /** In comment mode, turn a click in the reader into a new thread. */
  private async handleCommentClick(evt: MouseEvent): Promise<void> {
    if (!this.commentMode) return;
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    // Ignore clicks outside a rendered reading view (sidebar, editor, chrome).
    if (!this.readingContainerFor(target)) return;
    // The frontmatter/Properties block isn't reviewable content — a click there
    // would anchor a "text" thread to the serialised metadata. Skip it.
    if (target.closest(".metadata-container, .frontmatter, .metadata-property")) return;

    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") return;

    // We own this click: don't let Obsidian follow a link or move the cursor.
    evt.preventDefault();
    evt.stopPropagation();

    // An injected comment node (`rvw_<id>`) opens its existing thread — you don't
    // comment on a comment.
    const cmtNode = target.closest('g.node[id^="flowchart-rvw_"]');
    if (cmtNode) {
      const tid = (cmtNode.id || "").match(/^flowchart-rvw_(.+?)-\d+$/)?.[1];
      if (tid) {
        await this.activateCommentsView();
        this.focusThreadInSidebar(tid);
      }
      return;
    }

    // An injected edge badge opens its existing thread (same rule: don't comment
    // on a comment).
    const edgeBadge = target.closest<HTMLElement>(".review-md-edge-badge");
    if (edgeBadge) {
      const tid = edgeBadge.dataset.thread;
      if (tid) {
        await this.activateCommentsView();
        this.focusThreadInSidebar(tid);
      }
      return;
    }

    const anchor = this.resolveClickAnchor(target);
    // Clear the selection so the highlight flash reads cleanly afterwards.
    window.getSelection()?.removeAllRanges();

    // A previous click that never got a first comment left an empty thread —
    // clicking again abandons it, so sweep empties before minting the new one.
    await this.pruneEmptyThreads(file);

    try {
      const id = await this.createThread(file, anchor);
      await this.activateCommentsView();
      // Let the sidebar re-render from the new frontmatter, then focus the card.
      window.setTimeout(() => this.focusThreadInSidebar(id), 120);
      new Notice(`review-md: new thread ${id} (${describeAnchorShort(anchor)})`);
    } catch (err) {
      new Notice(`review-md: ${String(err)}`);
    }
  }

  /** Decide what a click anchors to: mermaid node, edge, image, or text/selection. */
  private resolveClickAnchor(target: HTMLElement): Record<string, unknown> {
    // 1) A mermaid node (inside our augmented SVG or the native one).
    const node = target.closest("g.node");
    if (node) {
      const raw = node.id || "";
      const m = raw.match(/^flowchart-(.+?)-\d+$/);
      const nodeId = m ? m[1] : raw;
      return {
        type: "mermaidNode",
        node: nodeId,
        blockId: "",
        quote: (node.textContent ?? "").trim().slice(0, 80),
      };
    }
    // 1b) A mermaid edge/arrow (the link path, or its label).
    const edgePath = target.closest("path.flowchart-link") as SVGPathElement | null;
    if (edgePath) {
      const ends = edgeEndpoints(edgePath);
      if (ends) {
        return {
          type: "mermaidEdge",
          blockId: "",
          from: ends.from,
          to: ends.to,
          index: ends.index,
          quote: `${ends.from} → ${ends.to}`,
        };
      }
    }
    // 2) An image.
    const img = target.closest("img");
    if (img) {
      const src = img.getAttribute("src") ?? "";
      return { type: "image", src };
    }
    // 3) Text: prefer the live selection, else the clicked block's text.
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    const block = target.closest("p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6") as HTMLElement | null;
    const quote = selected || (block?.textContent ?? target.textContent ?? "").trim();
    return { type: "text", quote: quote.slice(0, 200) };
  }

  // ---- Comment store: a git-tracked sibling sidecar file ----
  //
  // Threads live in `<dir>/.<basename>.comments.md`, NOT the reviewed file's
  // frontmatter, so commenting never creates a revision on the reviewed file —
  // its git blob and body stay stable when only comments change (Omar,
  // 2026-09-19). The sidecar is a dotfile, which Obsidian's vault index and
  // metadataCache ignore, so we read/write it through the raw adapter and
  // (de)serialise the `review:` block ourselves. See docs/issues/comment-sidecar.md.

  /** Sibling sidecar path for a reviewed file: `<dir>/.<basename>.comments.md`. */
  sidecarPathFor(file: TFile): string {
    const parent = file.parent?.path;
    const name = `.${file.basename}.comments.md`;
    return parent && parent !== "/" && parent !== "" ? `${parent}/${name}` : name;
  }

  /** Parse the `review:` block out of a sidecar's frontmatter, or null. */
  private parseSidecar(raw: string): ReviewData | null {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    try {
      const fm = parseYaml(m[1]) as { review?: ReviewData } | null;
      const review = fm?.review;
      if (!review) return null;
      review.threads = review.threads ?? [];
      return review;
    } catch {
      return null;
    }
  }

  /**
   * Read a file's review data from its sidecar. If the sidecar doesn't exist yet
   * but the reviewed file still carries a legacy in-frontmatter `review:` block,
   * fall back to that (migrated out on the next write).
   */
  async readReview(file: TFile): Promise<ReviewData> {
    const path = this.sidecarPathFor(file);
    try {
      if (await this.app.vault.adapter.exists(path)) {
        const parsed = this.parseSidecar(await this.app.vault.adapter.read(path));
        if (parsed) return parsed;
      }
    } catch (err) {
      console.error("[review-md] sidecar read failed", err);
    }
    const legacy = this.app.metadataCache.getFileCache(file)?.frontmatter?.review as
      | ReviewData
      | undefined;
    if (legacy?.threads?.length) return { uid: legacy.uid ?? mkId() + mkId(), threads: legacy.threads };
    return { uid: mkId() + mkId(), threads: [] };
  }

  /** Threads for a file, from its sidecar ([] on any error). */
  async readThreads(file: TFile): Promise<ReviewThread[]> {
    return (await this.readReview(file)).threads;
  }

  /** Read → mutate → write the sidecar, migrate away any legacy block, refresh views. */
  private async mutateReview(file: TFile, mutate: (data: ReviewData) => void): Promise<void> {
    const data = await this.readReview(file);
    mutate(data);
    await this.writeSidecar(file, data);
    await this.stripLegacyFrontmatter(file);
    this.notifyReviewChanged(file);
  }

  /** Serialise + write the sidecar: `review:` frontmatter (source of truth) plus a
   *  readable, git-diffable body rendering of the threads. */
  private async writeSidecar(file: TFile, data: ReviewData): Promise<void> {
    const path = this.sidecarPathFor(file);
    const fm = stringifyYaml({ review: data }).trimEnd();
    const content = `---\n${fm}\n---\n\n${this.renderSidecarBody(file, data)}`;
    await this.app.vault.adapter.write(path, content);
  }

  /** Human-readable rendering of the threads for the sidecar body (generated; the
   *  frontmatter above is the source of truth — this is for git diffs / reading). */
  private renderSidecarBody(file: TFile, data: ReviewData): string {
    const lines: string[] = [
      `# Comments — ${file.name}`,
      "",
      "<!-- Managed by review-md. The `review:` frontmatter above is the source of truth. -->",
      "",
    ];
    const ordered = [...data.threads].sort((a, b) => Number(a.resolved) - Number(b.resolved));
    if (!ordered.length) lines.push("_No comment threads yet._");
    for (const t of ordered) {
      const a = t.anchor as { type?: string; node?: string; quote?: string; src?: string };
      const where =
        a.type === "mermaidNode"
          ? `diagram node \`${a.node}\``
          : a.type === "image"
            ? `image \`${a.src}\``
            : a.quote
              ? `“${a.quote.replace(/\s+/g, " ").slice(0, 80)}”`
              : a.type ?? "text";
      lines.push(`## [${t.id}] ${where}${t.resolved ? " · resolved" : ""}`);
      if (!t.messages.length) lines.push("", "_(no messages yet)_");
      for (const m of t.messages) lines.push("", `**${m.author}** · ${m.ts}`, "", m.body);
      lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  /** Remove a legacy in-file `review:` frontmatter block once threads live in the
   *  sidecar (one-time migration; no-op when the block is already gone). */
  private async stripLegacyFrontmatter(file: TFile): Promise<void> {
    if (!this.app.metadataCache.getFileCache(file)?.frontmatter?.review) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      delete fm.review;
    });
  }

  /** After a sidecar write: refresh the sidebar and re-run the mermaid augmenter.
   *  The sidecar isn't the reviewed file, so no metadata event fires for it — we
   *  re-render the reading view ourselves so the augmenter re-injects nodes. */
  private notifyReviewChanged(file: TFile): void {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)[0]?.view;
    if (view instanceof CommentsView) void view.refresh();
    this.app.workspace
      .getLeavesOfType("markdown")
      .map((l) => l.view)
      .filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path)
      .forEach((v) => v.previewMode?.rerender(true));
  }

  /** Push a new, message-less thread onto the file's sidecar; return its id. */
  async createThread(file: TFile, anchor: Record<string, unknown>): Promise<string> {
    const id = mkId();
    // Stamp the reviewed version before writing (bodyHash is of the reviewed
    // file's body, which the sidecar write never touches).
    const rev = await this.buildRev(file);
    await this.mutateReview(file, (data) => {
      data.threads.push({ id, anchor, resolved: false, messages: [], rev });
    });
    return id;
  }

  /** Hash of the file's body (frontmatter stripped) — the reviewed content. */
  async bodyHashFor(file: TFile): Promise<string> {
    const text = await this.app.vault.read(file);
    return sha256Short(stripFrontmatter(text));
  }

  /** Version stamp for a new thread: body hash + git commit/blob when available. */
  private async buildRev(file: TFile): Promise<ReviewRev> {
    const rev: ReviewRev = { bodyHash: await this.bodyHashFor(file), ts: new Date().toISOString() };
    const git = await this.gitRevFor(file);
    if (git) rev.git = git;
    return rev;
  }

  /**
   * The file's on-disk directory and its path relative to the git work-tree root,
   * or null when there's no git / no Node access (mobile). Shared by the version
   * stamp and the "show reviewed version" retrieval so they resolve paths the
   * same way. `trim: false` on the runner preserves file content newlines.
   */
  private async gitContext(
    file: TFile,
  ): Promise<{ run: (args: string[], trim?: boolean) => Promise<string | null>; rel: string } | null> {
    const adapter = this.app.vault.adapter as unknown as { basePath?: string };
    const basePath = adapter?.basePath;
    const nodePath = nodeRequire("path");
    const cp = nodeRequire("child_process");
    if (!basePath || !nodePath || !cp) return null;
    const abs = nodePath.join(basePath, file.path);
    const dir = nodePath.dirname(abs);
    // maxBuffer bumped so `git show` of a large file isn't truncated.
    const run = (args: string[], trim = true): Promise<string | null> =>
      new Promise((res) => {
        try {
          cp.execFile(
            "git",
            ["-C", dir, ...args],
            { timeout: 4000, maxBuffer: 16 * 1024 * 1024 },
            (err: unknown, out: string) => res(err ? null : trim ? String(out).trim() : String(out)),
          );
        } catch {
          res(null);
        }
      });
    const root = await run(["rev-parse", "--show-toplevel"]);
    if (!root) return null;
    return { run, rel: nodePath.relative(root, abs) };
  }

  /**
   * The short HEAD commit and committed blob (`HEAD:<relpath>`) for a file, or
   * null when there's no git work tree / the file isn't committed / no Node
   * access (mobile). Uses the committed blob (not the working tree) so the stamp
   * is stable as more comments are added to the frontmatter. Each git call has a
   * short timeout so a slow/hung repo can't freeze thread creation.
   */
  async gitRevFor(file: TFile): Promise<{ commit: string; blob: string } | null> {
    const ctx = await this.gitContext(file);
    if (!ctx) return null;
    const commit = await ctx.run(["rev-parse", "--short", "HEAD"]);
    const blob = await ctx.run(["rev-parse", `HEAD:${ctx.rel}`]);
    if (!commit || !blob) return null; // untracked / no commits → git-agnostic path
    return { commit, blob };
  }

  /**
   * Is a thread stale — has the reviewed body changed since it was authored?
   * Decided by `bodyHash` alone (frontmatter excluded, so comment churn doesn't
   * count). Threads with no `rev` (e.g. seeded fixtures) are never "outdated".
   */
  async isThreadOutdated(file: TFile, thread: ReviewThread): Promise<boolean> {
    if (!thread.rev?.bodyHash) return false;
    return (await this.bodyHashFor(file)) !== thread.rev.bodyHash;
  }

  /**
   * The reviewed version's body (frontmatter stripped) via
   * `git show <commit>:<relpath>`, or null when there's no git stamp / retrieval
   * fails. The sidebar falls back to the stored anchor quote in that case.
   */
  async reviewedBodyFor(file: TFile, thread: ReviewThread): Promise<string | null> {
    const commit = thread.rev?.git?.commit;
    if (!commit) return null;
    const ctx = await this.gitContext(file);
    if (!ctx) return null;
    const out = await ctx.run(["show", `${commit}:${ctx.rel}`], false);
    return out === null ? null : stripFrontmatter(out);
  }

  /** Ask the sidebar to scroll to and focus a thread's card + reply box. */
  private focusThreadInSidebar(threadId: string): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)[0];
    const view = leaf?.view;
    if (view instanceof CommentsView) view.focusThread(threadId);
  }

  /**
   * Bidirectional link: scroll the reader to a thread's anchored region and
   * flash a highlight over it. Best-effort per anchor type; a no-op if the
   * region isn't currently rendered.
   *
   * We locate the markdown view by `file` (not the active view) because clicking
   * a card in the sidebar makes the sidebar the active leaf — so an active-view
   * lookup would always miss and wrongly report "switch to reading view".
   */
  highlightAnchor(file: TFile, thread: ReviewThread): void {
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map((l) => l.view)
      .find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path);
    const container =
      (view?.contentEl.querySelector(".markdown-reading-view") as HTMLElement | null) ??
      (view?.contentEl.querySelector(".markdown-preview-view") as HTMLElement | null);
    if (!container) {
      new Notice(
        view
          ? "review-md: switch to reading view to locate the comment"
          : "review-md: open the file to locate the comment",
      );
      return;
    }
    const a = thread.anchor as {
      type?: string;
      quote?: string;
      src?: string;
      node?: string;
      from?: string;
      to?: string;
      index?: number;
    };
    let el: HTMLElement | null = null;

    if (a.type === "image" && a.src) {
      el = container.querySelector(`img[src="${a.src}"], img[src$="${a.src}"]`) as HTMLElement | null;
    } else if (a.type === "mermaidNode" && a.node) {
      el = container.querySelector(`g.node[id*="-${a.node}-"], g.node[id$="-${a.node}"]`) as HTMLElement | null;
    } else if (a.type === "mermaidEdge" && a.from && a.to) {
      const svg = container.querySelector("svg");
      const path = svg ? findEdgePath(svg, a.from, a.to, a.index ?? 0) : null;
      if (path) {
        path.scrollIntoView({ behavior: "smooth", block: "center" });
        path.classList.add("review-md-edge-flash");
        window.setTimeout(() => path.classList.remove("review-md-edge-flash"), 1600);
        return;
      }
    } else if (a.type === "text" && a.quote) {
      el = findBlockContaining(container, a.quote);
    }

    if (!el) {
      new Notice("review-md: anchored region isn't visible in the current render");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.addClass("review-md-flash");
    window.setTimeout(() => el?.removeClass("review-md-flash"), 1600);
  }

  /** Validate params against the schema: required present, enums respected. */
  private validateParams(op: XcallbackOperation, params: Record<string, string>): void {
    // `reserved` params (e.g. `vault`) are consumed by Obsidian and never reach
    // the handler, so we can't require their presence here.
    const missing = op.params
      .filter((p) => p.required && !p.reserved && !params[p.name])
      .map((p) => p.name);
    if (missing.length) {
      throw new Error(`action \`${op.id}\` is missing required param(s): ${missing.join(", ")}`);
    }
    for (const p of op.params) {
      const v = params[p.name];
      if (v !== undefined && p.enum && !p.enum.includes(v)) {
        throw new Error(`param \`${p.name}\` must be one of: ${p.enum.join(", ")} (got \`${v}\`)`);
      }
    }
  }

  /** Resolve a `file` param to a TFile or throw. */
  private resolveFile(filePath: string | undefined): TFile {
    if (!filePath) throw new Error("missing `file` param");
    const af = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(af instanceof TFile)) throw new Error(`file not found: ${filePath}`);
    return af;
  }

  /** `reply` action: append a message to a thread in frontmatter, then open at it. */
  private async handleReply(params: Record<string, string>): Promise<void> {
    const file = this.resolveFile(params.file);
    const threadId = params.thread;
    await this.appendReply(file, threadId, {
      author: params.author || "external",
      body: params.body,
    });

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    this.app.workspace.openLinkText(`${file.path}#^${threadId}`, file.path, false);
    new Notice(`review-md: replied to ${threadId} in ${file.path}`);
  }

  /**
   * Append a message to a thread's `messages` in the file's frontmatter.
   * Shared by the `reply` x-callback action and the comments sidebar view.
   * Throws if the thread id isn't found.
   */
  async appendReply(
    file: TFile,
    threadId: string,
    msg: { author: string; body: string },
  ): Promise<void> {
    let found = false;
    await this.mutateReview(file, (data) => {
      const t = data.threads.find((x) => x.id === threadId);
      if (t) {
        t.messages.push({ author: msg.author, ts: new Date().toISOString(), body: msg.body });
        found = true;
      }
    });
    if (!found) throw new Error(`thread not found: ${threadId}`);
  }

  /** Edit an existing message's body (by thread id + message index) in the sidecar. */
  async editMessage(file: TFile, threadId: string, index: number, body: string): Promise<void> {
    let ok = false;
    await this.mutateReview(file, (data) => {
      const m = data.threads.find((x) => x.id === threadId)?.messages[index];
      if (m) {
        m.body = body;
        ok = true;
      }
    });
    if (!ok) throw new Error(`message ${threadId}#${index} not found`);
  }

  /** Remove a thread from the file's sidecar entirely. Returns true if one went. */
  async deleteThread(file: TFile, threadId: string): Promise<boolean> {
    let removed = false;
    await this.mutateReview(file, (data) => {
      const next = data.threads.filter((t) => t.id !== threadId);
      removed = next.length !== data.threads.length;
      data.threads = next;
    });
    return removed;
  }

  /**
   * Drop abandoned message-less threads — a click creates a thread immediately,
   * so a click the user never followed up with a first comment leaves an empty
   * thread in the sidecar. `keepId` is the thread currently being composed (never
   * pruned). No-op (no sidecar write) when there's nothing to prune.
   */
  async pruneEmptyThreads(file: TFile, keepId?: string): Promise<number> {
    const threads = await this.readThreads(file);
    const doomed = threads.filter((t) => t.messages.length === 0 && t.id !== keepId).length;
    if (!doomed) return 0;
    await this.mutateReview(file, (data) => {
      data.threads = data.threads.filter((t) => t.messages.length > 0 || t.id === keepId);
    });
    return doomed;
  }

  /** Toggle a thread's `resolved` flag in the sidecar. */
  async setThreadResolved(file: TFile, threadId: string, resolved: boolean): Promise<void> {
    await this.mutateReview(file, (data) => {
      const t = data.threads.find((x) => x.id === threadId);
      if (t) t.resolved = resolved;
    });
  }

  /** The `obsidian://review-md-open?...` share link for a thread in a file. */
  buildShareUrl(file: TFile, threadId: string): string {
    const q = (s: string) => encodeURIComponent(s);
    return (
      `obsidian://review-md-open?vault=${q(this.app.vault.getName())}` +
      `&file=${q(file.path)}&thread=${q(threadId)}`
    );
  }

  /** POC-1: resolve + open the target file, jump to a thread's ^blockId, and self-report. */
  private async handleUri(op: XcallbackOperation, params: Record<string, string>): Promise<void> {
    const af = this.resolveFile(params.file);

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af);

    if (params.thread) {
      this.app.workspace.openLinkText(`${af.path}#^${params.thread}`, af.path, false);
    }

    const report =
      `# POC-1 report\n\n- **RESULT: PASS** — protocol handler fired and opened the file.\n` +
      `- opened: \`${af.path}\`\n- thread param: \`${params.thread ?? "(none)"}\`\n` +
      `- action: \`${op.action}\`\n- x-success: \`${params["x-success"] ?? "(none)"}\`\n` +
      `- at: ${new Date().toISOString()}\n`;
    await this.writeVaultFile("POC-1-report.md", report);
    new Notice("review-md POC-1: opened " + af.path + " — see POC-1-report.md");
  }

  /** POC-4: write POC4_THREADS threads to the active file's frontmatter, read back, verify. */
  private async runPoc4(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("POC-4: open a markdown file first"); return; }

    const threads = Array.from({ length: POC4_THREADS }, (_, i) => makePoc4Thread(i));
    const totalMessages = threads.reduce((n, t) => n + t.messages.length, 0);

    const t0 = performance.now();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.review = { ...(fm.review ?? {}), uid: (fm.review?.uid as string) ?? mkId() + mkId(), threads };
    });
    const writeMs = performance.now() - t0;

    // Read back through a no-op processFrontMatter (authoritative, not the cache).
    let readBack: ReviewThread[] = [];
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      readBack = (fm.review?.threads as ReviewThread[]) ?? [];
    });

    const countOk = readBack.length === POC4_THREADS;
    const sampleIn = threads.find((t) => t.messages.some((m) => m.body.includes("ū")));
    const sampleOut = readBack.find((t) => t.id === sampleIn?.id);
    const bodyOk =
      !!sampleIn && !!sampleOut &&
      sampleIn.messages.map((m) => m.body).join("|") === sampleOut.messages.map((m) => m.body).join("|");

    const size = (await this.app.vault.read(file)).length;
    const pass = countOk && bodyOk;

    const report =
      `# POC-4 report\n\n- **RESULT: ${pass ? "PASS" : "FAIL"}**\n` +
      `- target file: \`${file.path}\`\n` +
      `- threads written / read back: ${POC4_THREADS} / ${readBack.length} ${countOk ? "✓" : "✗"}\n` +
      `- total messages: ${totalMessages}\n` +
      `- unicode+newline body round-trip: ${bodyOk ? "OK ✓" : "DIVERGED ✗"}\n` +
      `- processFrontMatter write time: ${writeMs.toFixed(1)} ms\n` +
      `- resulting file size: ${size} bytes\n` +
      `- at: ${new Date().toISOString()}\n\n` +
      `> Also check by eye: does the Properties panel stay usable with ${POC4_THREADS} threads?\n` +
      `> Record that observation in docs/pocs/poc-4-frontmatter.md.\n`;
    await this.writeVaultFile("POC-4-report.md", report);
    new Notice(`review-md POC-4: ${pass ? "PASS" : "FAIL"} — see POC-4-report.md`);
  }

  /**
   * If `el` is a rendered mermaid code block, return its diagram source (from
   * the file's raw text via getSectionInfo, so it's the stored source verbatim);
   * otherwise null. The post-processor runs for every section, so this is the
   * cheap filter that skips paragraphs, tables, etc.
   */
  private mermaidSourceFor(el: HTMLElement, ctx: MarkdownPostProcessorContext): string | null {
    if (!el.querySelector(".mermaid, code.language-mermaid, pre.language-mermaid")) return null;
    const info = ctx.getSectionInfo(el);
    if (!info) return null;
    const lines = info.text.split("\n").slice(info.lineStart, info.lineEnd + 1);
    if (!/^\s*```+\s*mermaid\s*$/.test(lines[0] ?? "")) return null;
    return lines.slice(1, -1).join("\n"); // strip the ``` fences
  }

  /**
   * Does thread `t` apply to a diagram with this source? True when it's a
   * mermaidNode thread whose anchored node id appears in the source AND its
   * comment node isn't already baked in (so a baked diagram doesn't get the
   * node injected a second time by the live augmenter).
   */
  private mermaidThreadApplies(t: ReviewThread, source: string): boolean {
    const a = t.anchor as { type?: string; node?: string };
    return (
      a?.type === "mermaidNode" &&
      typeof a.node === "string" &&
      new RegExp(`(^|[^\\w])${a.node}([^\\w]|$)`, "m").test(source) &&
      !new RegExp(`\\brvw_${t.id}\\b`).test(source)
    );
  }

  /** mermaidNode threads whose anchored node id appears in *this* diagram. */
  private async mermaidCommentsFor(source: string, sourcePath: string): Promise<ReviewThread[]> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return [];
    return (await this.readThreads(file)).filter((t) => this.mermaidThreadApplies(t, source));
  }

  /**
   * Does thread `t` apply to a diagram with this source as an *edge* comment?
   * True when it's a mermaidEdge thread and both endpoint node ids appear in the
   * source (so we only overlay a badge on a diagram that actually has that edge).
   */
  private mermaidEdgeThreadApplies(t: ReviewThread, source: string): boolean {
    const a = t.anchor as { type?: string; from?: string; to?: string };
    if (a?.type !== "mermaidEdge" || !a.from || !a.to) return false;
    const has = (n: string) => new RegExp(`(^|[^\\w])${escapeRegExp(n)}([^\\w]|$)`, "m").test(source);
    return has(a.from) && has(a.to);
  }

  /** mermaidEdge threads whose endpoints appear in *this* diagram. */
  private async mermaidEdgeCommentsFor(source: string, sourcePath: string): Promise<ReviewThread[]> {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return [];
    return (await this.readThreads(file)).filter((t) => this.mermaidEdgeThreadApplies(t, source));
  }

  /** Build `original source + one dashed comment node per thread` (source untouched). */
  private buildAugmentedSource(source: string, comments: ReviewThread[]): string {
    const escape = (s: string) => s.replace(/"/g, "'").replace(/\n/g, " ").slice(0, 60);
    const cmtId = (t: ReviewThread) => `rvw_${t.id}`;
    const lines = comments.map((t) => {
      const a = t.anchor as { node: string };
      const first = t.messages[0]?.body ?? "(comment)";
      const n = t.messages.length;
      const label = `${escape(first)}<br/>💬 ${n} ${n === 1 ? "msg" : "msgs"}${t.resolved ? " ✓" : ""}`;
      return `  ${a.node} -. "💬" .-> ${cmtId(t)}(["${label}"])`;
    });
    const needClassDef = !/classDef\s+reviewCmt\b/.test(source); // don't redefine on re-bake
    return (
      source.trimEnd() +
      "\n" +
      lines.join("\n") +
      (needClassDef
        ? `\n  classDef reviewCmt fill:#fff3bf,stroke:#f0c000,color:#5c3d00,rx:6,ry:6`
        : "") +
      `\n  class ${comments.map(cmtId).join(",")} reviewCmt`
    );
  }

  /**
   * Req 9 (bake command): write the injected comment nodes into every ```mermaid
   * fence of the active file whose nodes carry threads. This is the destructive
   * opt-in — it edits the stored source. Idempotent: threads already baked
   * (their `rvw_<id>` node present) are skipped, so re-running is safe.
   */
  private async bakeMermaidComments(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Bake: open a markdown file first");
      return;
    }
    const threads = (await this.readThreads(file)).filter(
      (t) => (t.anchor as { type?: string }).type === "mermaidNode",
    );
    if (!threads.length) {
      new Notice("Bake: no mermaidNode threads in this file");
      return;
    }

    const lines = (await this.app.vault.read(file)).split("\n");
    const out: string[] = [];
    const fenceOpen = /^(\s*)(`{3,})\s*mermaid\s*$/;
    let i = 0;
    let bakedComments = 0;
    let bakedDiagrams = 0;

    while (i < lines.length) {
      const open = lines[i].match(fenceOpen);
      if (!open) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const [, indent, ticks] = open;
      const closeRe = new RegExp(`^${indent}${ticks}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      const body = lines.slice(i + 1, j);
      // De-indent the body to source, apply the same indent back afterwards.
      const source = body.map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
      const applicable = threads.filter((t) => this.mermaidThreadApplies(t, source));

      if (applicable.length) {
        const augmented = this.buildAugmentedSource(source, applicable);
        out.push(lines[i]); // open fence
        for (const l of augmented.split("\n")) out.push(indent ? indent + l : l);
        if (j < lines.length) out.push(lines[j]); // close fence
        bakedComments += applicable.length;
        bakedDiagrams++;
      } else {
        for (let k = i; k <= Math.min(j, lines.length - 1); k++) out.push(lines[k]);
      }
      i = j + 1;
    }

    if (!bakedDiagrams) {
      new Notice("Bake: nothing to bake (already baked, or no matching nodes)");
      return;
    }
    await this.app.vault.modify(file, out.join("\n"));
    new Notice(`Baked ${bakedComments} comment(s) into ${bakedDiagrams} diagram(s)`);
  }

  /**
   * POC-6: replace the built-in mermaid SVG with an augmented render carrying a
   * comment node per thread. Waits (via observer) for the built-in SVG to land,
   * then swaps once; if there are no threads for this diagram it leaves the
   * native render untouched.
   */
  private async augmentRenderedMermaid(el: HTMLElement, source: string, sourcePath: string): Promise<void> {
    const comments = await this.mermaidCommentsFor(source, sourcePath);
    const edgeComments = await this.mermaidEdgeCommentsFor(source, sourcePath);
    if (!comments.length && !edgeComments.length) return; // no threads → stay 100% native
    const mermaid = (window as unknown as { mermaid?: any }).mermaid;
    if (comments.length && !mermaid?.render) return;

    let applied = false;
    const obs = new MutationObserver(() => {
      if (el.querySelector("svg")) void doApply();
    });
    const doApply = async (): Promise<void> => {
      if (applied) return;
      applied = true;
      obs.disconnect();
      try {
        let host: HTMLElement;
        if (comments.length) {
          // Node comments need a re-render (they inject nodes into the diagram).
          const augmented = this.buildAugmentedSource(source, comments);
          const { svg, bindFunctions } = await mermaid.render("reviewmd-" + mkId(), augmented);
          el.empty();
          host = el.createDiv({ cls: "review-md-mermaid" });
          host.innerHTML = svg;
          bindFunctions?.(host);
          for (const t of comments) {
            const g = host.querySelector(`g.node[id^="flowchart-rvw_${t.id}-"]`);
            if (g) {
              (g as SVGElement).style.cursor = "pointer";
              g.addEventListener("click", (e) => {
                e.stopPropagation();
                new Notice(`thread ${t.id}: ${t.messages.length} message(s)`);
              });
            }
          }
        } else {
          // Edge-only: no re-render, overlay onto the native SVG in place.
          host = (el.querySelector("svg")?.parentElement as HTMLElement | null) ?? el;
        }
        this.overlayEdgeBadges(host, edgeComments);
      } catch (err) {
        applied = false; // let a later mutation retry
        console.error("[review-md] mermaid augment failed", err);
      }
    };
    obs.observe(el, { childList: true, subtree: true });
    if (el.querySelector("svg")) void doApply();
  }

  /**
   * Overlay a clickable 💬 badge at each commented edge's midpoint. Non-destructive:
   * the badge `<g>` is appended into the edge path's own parent group so it shares
   * the diagram's coordinate space; the ```mermaid source is never touched.
   */
  private overlayEdgeBadges(host: HTMLElement, edgeComments: ReviewThread[]): void {
    if (!edgeComments.length) return;
    const svg = host.querySelector("svg");
    if (!svg) return;
    const ns = "http://www.w3.org/2000/svg";
    for (const t of edgeComments) {
      const a = t.anchor as { from?: string; to?: string; index?: number };
      if (!a.from || !a.to) continue;
      const path = findEdgePath(svg, a.from, a.to, a.index ?? 0);
      if (!path || !path.parentNode) continue;
      // Skip if this badge is already present (re-render/retry safety).
      if (svg.querySelector(`.review-md-edge-badge[data-thread="${t.id}"]`)) continue;
      let mid: DOMPoint;
      try {
        mid = path.getPointAtLength(path.getTotalLength() / 2);
      } catch {
        continue; // path not measurable yet
      }
      const g = document.createElementNS(ns, "g");
      g.setAttribute("class", "review-md-edge-badge" + (t.resolved ? " is-resolved" : ""));
      g.setAttribute("transform", `translate(${mid.x}, ${mid.y})`);
      (g as unknown as HTMLElement).dataset.thread = t.id;
      g.style.cursor = "pointer";
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("r", "11");
      const text = document.createElementNS(ns, "text");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      const n = t.messages.length;
      text.textContent = t.resolved ? "✓" : n > 1 ? String(n) : "💬";
      const title = document.createElementNS(ns, "title");
      title.textContent = `${a.from} → ${a.to}: ${n} message${n === 1 ? "" : "s"}${t.resolved ? " (resolved)" : ""}`;
      g.append(title, circle, text);
      path.parentNode.appendChild(g);
    }
  }

  private async writeVaultFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }

  /** Every ```mermaid fence's source in a file (fences stripped). */
  private async mermaidBlocksIn(file: TFile): Promise<string[]> {
    const text = await this.app.vault.read(file);
    const re = /^[ \t]*`{3,}\s*mermaid\s*\r?\n([\s\S]*?)\r?\n[ \t]*`{3,}\s*$/gm;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) blocks.push(m[1]);
    return blocks;
  }

  /**
   * A minimal single-node mermaid source for a mermaidNode thread (just the node,
   * per the design decision — no neighbours). Prefers the node's real definition
   * (shape + label) pulled from whichever diagram contains it, so the preview
   * matches the diagram; falls back to a labelled box built from the stored quote.
   * Returns null for non-mermaidNode anchors.
   */
  async mermaidNodePreviewSource(file: TFile, thread: ReviewThread): Promise<string | null> {
    const a = thread.anchor as { type?: string; node?: string; quote?: string };
    if (a?.type !== "mermaidNode" || !a.node) return null;
    const node = a.node;
    const nodeRe = new RegExp(`(^|[^\\w])${escapeRegExp(node)}([^\\w]|$)`, "m");
    const src = (await this.mermaidBlocksIn(file)).find((b) => nodeRe.test(b));
    let def: string | null = null;
    if (src) {
      // Capture the node's declared shape+label (the occurrence that carries one).
      const shapes = "\\[\\[.*?\\]\\]|\\(\\(.*?\\)\\)|\\(\\[.*?\\]\\)|\\[\\(.*?\\)\\]|\\{\\{.*?\\}\\}|\\[.*?\\]|\\(.*?\\)|\\{.*?\\}|>.*?\\]";
      const dm = src.match(new RegExp(`\\b${escapeRegExp(node)}\\s*(${shapes})`));
      if (dm) def = `${node}${dm[1]}`;
    }
    if (!def) {
      const label = (a.quote || node).replace(/"/g, "'").replace(/\s+/g, " ").slice(0, 60);
      // An injected comment node (`rvw_<id>`) never lives in the source, so match
      // the augmenter's own shape+style (stadium, reviewCmt yellow) rather than
      // falling back to a plain box — the preview should mirror the rendered node.
      if (node.startsWith("rvw_")) {
        return (
          `flowchart TB\n  ${node}(["${label}"])\n` +
          `  classDef reviewCmt fill:#fff3bf,stroke:#f0c000,color:#5c3d00,rx:6,ry:6\n` +
          `  class ${node} reviewCmt`
        );
      }
      def = `${node}["${label}"]`;
    }
    return `flowchart TB\n  ${def}`;
  }

  /**
   * A minimal `from --> to` mermaid source for a mermaidEdge thread, so the card
   * previews the actual arrow that was commented on. Prefers each endpoint's real
   * shape+label pulled from the diagram; falls back to a plain box on the node id.
   * Returns null for non-mermaidEdge anchors.
   */
  async mermaidEdgePreviewSource(file: TFile, thread: ReviewThread): Promise<string | null> {
    const a = thread.anchor as { type?: string; from?: string; to?: string };
    if (a?.type !== "mermaidEdge" || !a.from || !a.to) return null;
    const blocks = await this.mermaidBlocksIn(file);
    const shapes =
      "\\[\\[.*?\\]\\]|\\(\\(.*?\\)\\)|\\(\\[.*?\\]\\)|\\[\\(.*?\\)\\]|\\{\\{.*?\\}\\}|\\[.*?\\]|\\(.*?\\)|\\{.*?\\}|>.*?\\]";
    const defOf = (node: string): string => {
      for (const b of blocks) {
        const dm = b.match(new RegExp(`\\b${escapeRegExp(node)}\\s*(${shapes})`));
        if (dm) return `${node}${dm[1]}`;
      }
      return `${node}["${node}"]`;
    };
    return `flowchart LR\n  ${defOf(a.from)} -->|💬| ${defOf(a.to)}`;
  }

  /** Render mermaid source to an SVG string, or null if mermaid/render fails. */
  async renderMermaidSvg(source: string): Promise<string | null> {
    const mermaid = (window as unknown as { mermaid?: { render?: (id: string, src: string) => Promise<{ svg: string }> } }).mermaid;
    if (!mermaid?.render) return null;
    try {
      const { svg } = await mermaid.render("reviewmd-preview-" + mkId(), source);
      return svg;
    } catch (err) {
      console.error("[review-md] node preview render failed", err);
      return null;
    }
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read an edge's source/target node ids + parallel-edge index off a mermaid link
 * path. Mermaid ids each `<path class="flowchart-link">` as `L_<from>_<to>_<n>`
 * (older builds use `-` separators). Node ids are usually simple, so lazy groups
 * split the ids correctly; an id with underscores in a node name degrades to a
 * best-effort split, which still round-trips because findEdgePath matches the
 * same shape.
 */
function edgeEndpoints(path: Element): { from: string; to: string; index: number } | null {
  const m = (path.id || "").match(/^L[-_](.+?)[-_](.+?)[-_](\d+)$/);
  return m ? { from: m[1], to: m[2], index: Number(m[3]) } : null;
}

/** Locate the rendered edge path for a `mermaidEdge` anchor within an SVG. */
function findEdgePath(
  svg: Element,
  from: string,
  to: string,
  index: number,
): SVGPathElement | null {
  const paths = Array.from(svg.querySelectorAll<SVGPathElement>("path.flowchart-link"));
  const exact = new RegExp(`^L[-_]${escapeRegExp(from)}[-_]${escapeRegExp(to)}[-_]${index}$`);
  const byId = paths.find((p) => exact.test(p.id));
  if (byId) return byId;
  // Fall back: same endpoints, any index (diagram may have been edited).
  const anyIdx = new RegExp(`^L[-_]${escapeRegExp(from)}[-_]${escapeRegExp(to)}[-_]\\d+$`);
  return paths.find((p) => anyIdx.test(p.id)) ?? null;
}

/** A one-word label for an anchor, for notices. */
function describeAnchorShort(anchor: Record<string, unknown>): string {
  const type = String(anchor.type ?? "text");
  if (type === "mermaidNode") return `node ${anchor.node}`;
  if (type === "mermaidEdge") return `edge ${anchor.from}→${anchor.to}`;
  if (type === "image") return "image";
  return "text";
}

/**
 * Find the smallest block element under `root` whose text contains `quote`.
 * Used to locate a text anchor in the current render for the flash highlight.
 */
function findBlockContaining(root: HTMLElement, quote: string): HTMLElement | null {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>("p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6"),
  );
  let best: HTMLElement | null = null;
  for (const b of blocks) {
    const text = (b.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.includes(needle)) {
      // Prefer the tightest match (shortest containing block).
      if (!best || text.length < (best.textContent ?? "").length) best = b;
    }
  }
  return best;
}

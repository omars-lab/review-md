import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  MarkdownView,
  Editor,
  debounce,
  normalizePath,
  parseYaml,
  stringifyYaml,
} from "obsidian";
import xcallbackSchema from "./protocol/xcallback.schema.json";
import { CommentsView, VIEW_TYPE_COMMENTS } from "./views/comments-view";
import {
  WORKING_REV,
  stripFrontmatter,
  stripBlockIds,
  removeBlockIdFromText,
  blockTextFor,
  sha256Short,
  bodyHash,
  ordinalsFromLog,
  mermaidBlocksFrom,
  effectiveReviewer,
} from "./pure";

// Re-export the pure helpers other modules and tests still import from here, so
// their identity stays single-sourced in ./pure.
export {
  WORKING_REV,
  stripFrontmatter,
  stripBlockIds,
  removeBlockIdFromText,
  blockTextFor,
} from "./pure";

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

/** Persisted plugin settings. Comments live in the sidecar, so `loadData` is
 *  free for genuine UI preferences like this one. */
interface ReviewMdSettings {
  /** Show the augmented mermaid comment nodes / edge badges in the live render.
   *  Off → diagrams render 100% native (comments still exist in the sidecar). */
  showMermaidComments: boolean;
  /** The name new comments/replies authored from the sidebar are stamped with.
   *  Blank → the effective author is the generic `"reviewer"` (never a specific
   *  person's name — that's not a sensible shipped default). See effectiveAuthor. */
  reviewerName: string;
}
const DEFAULT_SETTINGS: ReviewMdSettings = {
  showMermaidComments: true,
  reviewerName: "",
};

/**
 * review-md — plugin entry point.
 *
 * Stands up the plugin: the click-to-comment UI, the comments sidebar, the
 * mermaid overlay augmenter, and the `obsidian://review-md` x-callback protocol
 * handlers (share / reply / open links). Design and the earlier proof-of-concept
 * notes live in docs/pocs/ and docs/designs/.
 */

export interface ReviewMessage { author: string; ts: string; body: string; }
/**
 * The version a comment was authored against (req: track comments per committed
 * version of the file).
 *
 * `anchorHash` is the primary staleness signal: a sha256 of just the content THIS
 * thread anchors to (the mermaid node's declaration, the anchored block/heading
 * text, the image src) at authoring time. A thread is "outdated" only when its own
 * anchored content changes or is removed — edits elsewhere in the file don't count
 * (Omar, 2026-09-21: "unless on our latest, we removed content"). It's absent only
 * for anchors we can't precisely extract, or on legacy threads.
 *
 * `bodyHash` is a sha256 of the whole document BODY (YAML frontmatter stripped, so
 * comment churn in the sidecar never counts) — kept as the coarse fallback used
 * when `anchorHash` can't be computed. `git`, present only in a git work tree,
 * records the short commit and committed blob (`HEAD:<path>`) so a reviewer/agent
 * can `git show <commit>:<path>` the exact reviewed text. See
 * docs/issues/version-stamping.md.
 */
export interface ReviewRev {
  bodyHash: string;
  anchorHash?: string;
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

/** The slice of CodeMirror 6's EditorView we use to map clicks ↔ source in Live
 *  Preview. `editor.cm` is undocumented in Obsidian's public API, so we type only
 *  what we touch. `posAtCoords` → source offset for a click; `contentDOM` holds
 *  the rendered widgets (mermaid SVG, images) we query and flash. */
interface CmEditorView {
  posAtCoords(coords: { x: number; y: number }): number | null;
  posAtDOM(node: Node): number;
  contentDOM: HTMLElement;
}
function cmOf(editor: Editor): CmEditorView | null {
  return (editor as unknown as { cm?: CmEditorView }).cm ?? null;
}

/** Node's `require`, or undefined on mobile / restricted renderers. */
function nodeRequire(mod: string): any {
  try {
    return (window as unknown as { require?: (m: string) => unknown }).require?.(mod);
  } catch {
    return undefined;
  }
}

/** Alternation of every mermaid node shape wrapper (`[..]`, `(..)`, `([..])`, …),
 *  longest-first so `[[..]]` wins over `[..]`. Used to pull a node's declared
 *  shape+label out of diagram source. Kept in one place — the preview builders and
 *  the per-anchor staleness check must read node declarations identically. */
const MERMAID_SHAPES =
  "\\[\\[.*?\\]\\]|\\(\\(.*?\\)\\)|\\(\\[.*?\\]\\)|\\[\\(.*?\\)\\]|\\{\\{.*?\\}\\}|\\[.*?\\]|\\(.*?\\)|\\{.*?\\}|>.*?\\]";

export default class ReviewMdPlugin extends Plugin {
  /** True while "comment mode" is armed: the reader is click-to-comment. */
  private commentMode = false;
  private commentRibbon: HTMLElement | null = null;
  settings: ReviewMdSettings = { ...DEFAULT_SETTINGS };
  /** Live Preview mermaid augmenter state. Markdown post-processors never fire in
   *  the CM6 editor (only in reading view / fully-rendered embeds), so the overlay
   *  in Live Preview is driven by a MutationObserver on each editor's `.cm-content`
   *  instead — see docs/issues/live-preview-mermaid-overlay.md. One observer per
   *  view (dedup via the map); `lpAugmenting` guards a widget mid-render so a
   *  mutation the augment itself causes doesn't re-enter. */
  private lpObservers = new WeakMap<MarkdownView, MutationObserver>();
  private lpAugmenting = new WeakSet<HTMLElement>();
  /** Reading-view mermaid augmenter state. The markdown post-processor fires only
   *  at a section's *first* render and does NOT re-run when Obsidian restores a
   *  cached section on scroll-in / re-layout (verified — see
   *  docs/issues/mermaid-augment-lifecycle.md), so a `ctx.addChild` observer is
   *  never re-created and the overlay is lost. Reading view is therefore driven the
   *  same way as Live Preview: one MutationObserver per view on the reading
   *  container, re-applying whenever a mermaid `<svg>` (re)appears. `rvAugmenting`
   *  guards a host mid-apply so our own badge writes don't re-enter. */
  private rvObservers = new WeakMap<MarkdownView, MutationObserver>();
  private rvAugmenting = new WeakSet<HTMLElement>();

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Settings tab: reviewer identity (#6) + the mermaid-overlay toggle, so both
    // preferences are reachable from Settings, not only a command.
    this.addSettingTab(new ReviewMdSettingTab(this.app, this));

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

    // Copy-link commands (req 4) — command-palette equivalents of the sidebar
    // card's Copy menu, acting on the sidebar's currently-focused thread.
    this.addCommand({
      id: "copy-share-link",
      name: "Copy share link for the selected thread",
      callback: () => void this.copyFocusedThreadLink("share"),
    });
    this.addCommand({
      id: "copy-native-link",
      name: "Copy native link for the selected thread",
      callback: () => void this.copyFocusedThreadLink("native"),
    });
    this.addCommand({
      id: "copy-reply-link",
      name: "Copy reply-link template for the selected thread",
      callback: () => void this.copyFocusedThreadLink("reply"),
    });

    // POC-6: augmented mermaid render. Obsidian renders mermaid through its own
    // markdown renderer (not the public code-block registry), so we can't override
    // it with registerMarkdownCodeBlockProcessor. A markdown post-processor is also
    // the wrong hook: it runs only at a section's *first* render and does NOT
    // re-fire when Obsidian restores a cached mermaid section on scroll-in / theme
    // change / re-layout (verified empirically — docs/issues/mermaid-augment-lifecycle.md),
    // so any overlay it applies is silently lost and never re-applied. Instead we
    // drive BOTH reading view and Live Preview from a MutationObserver on each
    // view's render container: whenever a mermaid `<svg>` (re)appears we decorate
    // it, and a restore/rebuild that strips the overlay simply fires the observer
    // again. Re-attach on leaf/file changes since a new file may open into either
    // mode. Diagram source is untouched.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.ensureMermaidAugmenter()),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.ensureMermaidAugmenter()),
    );
    this.app.workspace.onLayoutReady(() => this.ensureMermaidAugmenter());

    // Durable text anchoring (req: block-refs survive edits): stamp each rendered
    // section with its source line range so a click can locate the exact source
    // block to attach a native `^blockId` to. getSectionInfo is only available
    // here (in a post-processor), not on an arbitrary click — so we cache it onto
    // the DOM. Line numbers shift on edit, so this is read fresh at click time,
    // never trusted stale. See docs/issues/durable-anchoring.md.
    this.registerMarkdownPostProcessor((el, ctx) => {
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      el.dataset.reviewMdLineStart = String(info.lineStart);
      el.dataset.reviewMdLineEnd = String(info.lineEnd);
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

    // Overlay toggle (P4): show/hide the injected comment nodes + edge badges in
    // the live render without touching the diagram source or the sidecar. Off
    // renders diagrams 100% native; re-rendering the open reading views makes the
    // augmenter (which now stands down) hand the DOM back to Obsidian's native SVG.
    this.addCommand({
      id: "toggle-mermaid-comments",
      name: "Toggle mermaid comment overlay",
      callback: () => void this.toggleMermaidComments(),
    });
  }

  /** Persist the current settings object (the one `saveData`/`loadData` path). */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** The author name new sidebar-authored messages are stamped with: the trimmed
   *  reviewer name, or the generic `"reviewer"` when unset. Single source for both
   *  the draft composer's first comment and sidebar replies. */
  effectiveAuthor(): string {
    return effectiveReviewer(this.settings.reviewerName);
  }

  /** Flip the mermaid-overlay preference (command-palette entry point). */
  private async toggleMermaidComments(): Promise<void> {
    await this.setShowMermaidComments(!this.settings.showMermaidComments);
  }

  /** Set the mermaid-overlay preference, persist it, and re-render open reading
   *  views so the change takes effect immediately (both directions). Shared by the
   *  toggle command and the settings tab. */
  async setShowMermaidComments(on: boolean): Promise<void> {
    this.settings.showMermaidComments = on;
    await this.saveSettings();
    const views = this.app.workspace
      .getLeavesOfType("markdown")
      .map((l) => l.view)
      .filter((v): v is MarkdownView => v instanceof MarkdownView);
    for (const v of views) {
      if (v.getMode?.() === "source") {
        // Live Preview: the post-processor rerender below doesn't touch the editor
        // surface, so apply/strip the CM6 overlay directly.
        if (this.settings.showMermaidComments) void this.scanLivePreviewMermaid(v);
        else void this.stripLivePreviewMermaid(v);
      } else {
        v.previewMode?.rerender(true);
      }
    }
    new Notice(
      this.settings.showMermaidComments
        ? "review-md: mermaid comment overlay shown"
        : "review-md: mermaid comment overlay hidden",
    );
  }

  /** Attach the right mermaid augmenter to the active markdown view for its
   *  current mode: a `.cm-content` observer in Live Preview (source mode) or a
   *  reading-container observer in reading mode. Each is idempotent per view, so
   *  this is safe to call on every leaf/file change. */
  private ensureMermaidAugmenter(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    if (view.getMode?.() === "source") this.ensureLivePreviewAugmenter(view);
    else this.ensureReadingViewAugmenter(view);
  }

  /** Attach a debounced MutationObserver to the source-mode editor's `.cm-content`
   *  (once per view) so mermaid widgets get the comment overlay in Live Preview,
   *  and re-scan an already-observed view. No-op when the overlay is toggled off. */
  private ensureLivePreviewAugmenter(view: MarkdownView): void {
    if (view.getMode?.() !== "source") return;
    if (this.lpObservers.has(view)) {
      void this.scanLivePreviewMermaid(view);
      return;
    }
    const cm = cmOf(view.editor);
    if (!cm) return;
    const scan = debounce(() => void this.scanLivePreviewMermaid(view), 120, false);
    const obs = new MutationObserver(scan);
    obs.observe(cm.contentDOM, { childList: true, subtree: true });
    this.lpObservers.set(view, obs);
    // Tie teardown to the VIEW, not the plugin: a plugin-lifetime `this.register`
    // would retain `obs` — and via its `scan` closure the whole (closed) view —
    // until the plugin unloads, defeating the WeakMap. `view.register` fires when
    // the tab/leaf is detached, disconnecting and dropping the entry then.
    view.register(() => {
      obs.disconnect();
      this.lpObservers.delete(view);
    });
    void this.scanLivePreviewMermaid(view);
  }

  /** Attach a debounced MutationObserver to the reading view's render container
   *  (once per view) so mermaid diagrams get the comment overlay whenever their
   *  `<svg>` (re)appears — on first render, on scroll-in from cache, and on any
   *  re-layout that strips the overlay. This replaces the markdown post-processor,
   *  which does not re-fire on cache restore (docs/issues/mermaid-augment-lifecycle.md).
   *  Idempotent per view; re-scans an already-observed view. */
  private ensureReadingViewAugmenter(view: MarkdownView): void {
    if (view.getMode?.() === "source") return;
    if (this.rvObservers.has(view)) {
      void this.scanReadingViewMermaid(view);
      return;
    }
    // `previewMode.containerEl` is the stable per-view reading-view element; its
    // subtree is what Obsidian populates/restores as sections render and scroll.
    const container =
      (view.previewMode as unknown as { containerEl?: HTMLElement } | undefined)?.containerEl ??
      (view.containerEl.querySelector(".markdown-reading-view") as HTMLElement | null);
    if (!container) return;
    const scan = debounce(() => void this.scanReadingViewMermaid(view), 120, false);
    const obs = new MutationObserver(scan);
    obs.observe(container, { childList: true, subtree: true });
    this.rvObservers.set(view, obs);
    // Teardown tied to the view (see ensureLivePreviewAugmenter): fires on tab
    // close so a closed reading view isn't pinned in memory by its observer.
    view.register(() => {
      obs.disconnect();
      this.rvObservers.delete(view);
    });
    void this.scanReadingViewMermaid(view);
  }

  /** Find each rendered mermaid diagram in a reading view and augment any that
   *  carry threads and aren't already fully overlaid. Source-free: threads are
   *  matched to a diagram by whether the anchored node/edge actually exists in
   *  that diagram's rendered SVG, so no `getSectionInfo` is needed. Self-heals:
   *  when Obsidian restores a cached section (stripping our overlay) the observer
   *  re-fires and this runs again. `rvAugmenting` prevents re-entry from our own
   *  badge writes. */
  private async scanReadingViewMermaid(view: MarkdownView): Promise<void> {
    if (!this.settings.showMermaidComments) return;
    if (view.getMode?.() === "source") return;
    const file = view.file;
    if (!file) return;
    const container =
      (view.previewMode as unknown as { containerEl?: HTMLElement } | undefined)?.containerEl ??
      (view.containerEl.querySelector(".markdown-reading-view") as HTMLElement | null);
    if (!container) return;
    const hosts = Array.from(container.querySelectorAll<HTMLElement>(".mermaid"));
    if (!hosts.length) return;
    const threads = await this.readThreads(file);
    const nodeThreads = threads.filter((t) => (t.anchor as { type?: string }).type === "mermaidNode");
    const edgeThreads = threads.filter((t) => (t.anchor as { type?: string }).type === "mermaidEdge");
    if (!nodeThreads.length && !edgeThreads.length) return;
    for (const host of hosts) {
      if (this.rvAugmenting.has(host)) continue;
      const svg = host.querySelector("svg");
      if (!svg) continue; // not rendered yet — a later mutation retries
      // Which threads belong to THIS diagram? Those whose anchored node/edge is
      // present in this SVG. A baked thread (its `rvw_<id>` node is in the diagram)
      // is skipped so it isn't overlaid on top of its baked-in node.
      const nodeComments = nodeThreads.filter((t) => {
        const node = (t.anchor as { node?: string }).node;
        if (!node) return false;
        if (svg.querySelector(`g.node[id*="rvw_${t.id}"]`)) return false; // baked in
        return !!svg.querySelector(`g.node[id*="-${node}-"], g.node[id$="-${node}"]`);
      });
      const edgeComments = edgeThreads.filter((t) => {
        const a = t.anchor as { from?: string; to?: string; index?: number };
        return a.from && a.to && !!findEdgePath(svg, a.from, a.to, a.index ?? 0);
      });
      if (!nodeComments.length && !edgeComments.length) continue;
      // Already fully overlaid? One badge per node (keyed data-node) and per edge
      // (keyed data-edge) means done — skip so our own mutations don't loop.
      const nodeDone = nodeComments.every(
        (t) => !!host.querySelector(`.review-md-node-badge[data-node="${(t.anchor as { node?: string }).node}"]`),
      );
      const edgeDone = edgeComments.every((t) => {
        const a = t.anchor as { from?: string; to?: string; index?: number };
        return !!host.querySelector(`.review-md-edge-badge[data-edge="${a.from}-${a.to}-${a.index ?? 0}"]`);
      });
      if (nodeDone && edgeDone) continue;
      this.rvAugmenting.add(host);
      try {
        this.styleCommentedNodes(host, nodeComments);
        this.overlayEdgeBadges(host, edgeComments);
      } catch (err) {
        console.error("[review-md] reading-view mermaid augment failed", err);
      } finally {
        this.rvAugmenting.delete(host);
      }
    }
  }

  /** The ```mermaid source of a Live Preview widget: map the widget back to its
   *  source offset (`posAtDOM`), then read the fence body straight from the live
   *  editor buffer (not the vault file — the buffer reflects unsaved edits). */
  private livePreviewMermaidSource(cm: CmEditorView, editor: Editor, widget: HTMLElement): string | null {
    let pos: number;
    try {
      pos = cm.posAtDOM(widget);
    } catch {
      return null;
    }
    if (pos == null) return null;
    const total = editor.lineCount();
    const startLine = editor.offsetToPos(pos).line;
    const fenceOpen = /^\s*`{3,}\s*mermaid\s*$/;
    const fenceClose = /^\s*`{3,}\s*$/;
    // posAtDOM lands on (or just before) the fence line; scan a small window so a
    // stray offset can't skip forward into the *next* diagram.
    let open = startLine;
    const limit = Math.min(total, startLine + 4);
    while (open < limit && !fenceOpen.test(editor.getLine(open))) open++;
    if (open >= limit || !fenceOpen.test(editor.getLine(open))) return null;
    let close = open + 1;
    while (close < total && !fenceClose.test(editor.getLine(close))) close++;
    const body: string[] = [];
    for (let l = open + 1; l < close; l++) body.push(editor.getLine(l));
    return body.join("\n");
  }

  /** Find each rendered mermaid widget in a Live Preview editor and augment any
   *  that carry threads and aren't already fully overlaid. Self-heals: when CM6
   *  rebuilds a widget (stripping our overlay) the observer re-fires and this runs
   *  again. `lpAugmenting` prevents the async augment from re-entering itself. */
  private async scanLivePreviewMermaid(view: MarkdownView): Promise<void> {
    if (!this.settings.showMermaidComments) return;
    if (view.getMode?.() !== "source") return;
    const cm = cmOf(view.editor);
    const file = view.file;
    if (!cm || !file) return;
    const widgets = Array.from(
      cm.contentDOM.querySelectorAll<HTMLElement>(".cm-embed-block.cm-lang-mermaid"),
    );
    for (const widget of widgets) {
      if (this.lpAugmenting.has(widget)) continue;
      const host = widget.querySelector<HTMLElement>(".mermaid") ?? widget;
      if (!host.querySelector("svg")) continue; // not rendered yet — a later mutation retries
      const source = this.livePreviewMermaidSource(cm, view.editor, widget);
      if (source == null) continue;
      const nodeComments = await this.mermaidCommentsFor(source, file.path);
      const edgeComments = await this.mermaidEdgeCommentsFor(source, file.path);
      if (!nodeComments.length && !edgeComments.length) continue;
      // Already fully overlaid? Nodes get one badge per node (keyed data-node),
      // edges one per thread. A badge for each means done — skip so we don't loop on
      // our own mutations. (When CM6 rebuilds the widget the badges are gone → re-apply.)
      const nodeIds = new Set(
        nodeComments.map((t) => (t.anchor as { node?: string }).node).filter(Boolean),
      );
      const nodeDone = [...nodeIds].every(
        (n) => !!host.querySelector(`.review-md-node-badge[data-node="${n}"]`),
      );
      const edgeKeys = new Set(
        edgeComments.map((t) => {
          const a = t.anchor as { from?: string; to?: string; index?: number };
          return a.from && a.to ? `${a.from}-${a.to}-${a.index ?? 0}` : null;
        }).filter(Boolean),
      );
      const edgeDone = [...edgeKeys].every(
        (k) => !!host.querySelector(`.review-md-edge-badge[data-edge="${k}"]`),
      );
      if (nodeDone && edgeDone) continue;
      this.lpAugmenting.add(widget);
      try {
        await this.augmentRenderedMermaid(host, source, file.path);
      } finally {
        this.lpAugmenting.delete(widget);
      }
    }
  }

  /** Revert Live Preview mermaid widgets to native (overlay toggled off). The
   *  overlay is now non-destructive, so reverting is just dropping the badges and
   *  the recolour class — no re-render needed. */
  private stripLivePreviewMermaid(view: MarkdownView): void {
    const cm = cmOf(view.editor);
    if (!cm) return;
    cm.contentDOM
      .querySelectorAll(".review-md-node-badge, .review-md-edge-badge")
      .forEach((b) => b.remove());
    cm.contentDOM
      .querySelectorAll("g.node.review-md-commented")
      .forEach((g) => g.classList.remove("review-md-commented"));
  }

  onunload(): void {
    document.body.removeClass("review-md-comment-mode");
    // Views closed during the session were cleaned by their own `view.register`.
    // Any still-open markdown view's observer must be disconnected here — walk the
    // live leaves rather than a retained list, so we never hold a closed view.
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView) {
        this.lpObservers.get(view)?.disconnect();
        this.lpObservers.delete(view);
        this.rvObservers.get(view)?.disconnect();
        this.rvObservers.delete(view);
      }
    }
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

  /** If the click landed in a Live Preview / source CM6 editor, return that view's
   *  editor so a text click can be mapped coord→source. Null outside an editor. */
  private editorSurfaceFor(el: HTMLElement): Editor | null {
    if (!el.closest(".cm-editor")) return null;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.editor ?? null;
  }

  /** In comment mode, turn a click in the reader into a new thread. */
  private async handleCommentClick(evt: MouseEvent): Promise<void> {
    if (!this.commentMode) return;
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    // A reviewable surface is either a rendered reading view OR a Live Preview /
    // source CM6 editor (#24). Anything else (sidebar, chrome) is ignored.
    const reading = this.readingContainerFor(target);
    const editor = reading ? null : this.editorSurfaceFor(target);
    if (!reading && !editor) return;
    // The frontmatter/Properties block isn't reviewable content — a click there
    // would anchor a "text" thread to the serialised metadata. Skip it (both the
    // reading-view Properties widget and the LP `.cm-line` frontmatter/its widget).
    if (target.closest(".metadata-container, .frontmatter, .metadata-property, .cm-hmd-frontmatter")) return;

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

    const anchor = this.resolveClickAnchor(
      target,
      editor ? { editor, x: evt.clientX, y: evt.clientY } : undefined,
    );
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

  /** Decide what a click anchors to: mermaid node, edge, image, or text/selection.
   *  In the Live Preview / source CM6 surface, `ctx` carries the editor + click
   *  coords so the text branch can map the click to a source line (#24). The
   *  mermaid/image branches are DOM-based and identical across both surfaces. */
  private resolveClickAnchor(
    target: HTMLElement,
    ctx?: { editor: Editor; x: number; y: number },
  ): Record<string, unknown> {
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
    // 2b) A link — internal `[[wikilink]]` (Obsidian stashes the target on
    // `data-href`) or an external URL (`href`). After the image branch so an
    // image wrapped in a link still anchors to the image, before the text
    // fallback so link text doesn't collapse into its containing block.
    const link = target.closest("a") as HTMLAnchorElement | null;
    if (link) {
      const href = (link.getAttribute("data-href") ?? link.getAttribute("href") ?? "").trim();
      const quote = (link.textContent ?? "").trim();
      if (href || quote) return { type: "link", href, quote: quote.slice(0, 200) };
    }
    // 3) Text in the CM6 editor surface: map the click to a source position via
    // posAtCoords (exact, no reliance on the reading-view line post-processor).
    if (ctx) {
      const cm = cmOf(ctx.editor);
      const selected = ctx.editor.getSelection().trim();
      const pos = cm?.posAtCoords({ x: ctx.x, y: ctx.y });
      const line = pos != null ? ctx.editor.offsetToPos(pos).line : undefined;
      const quote = (selected || (line != null ? ctx.editor.getLine(line) : "")).trim();
      return {
        type: "text",
        quote: quote.slice(0, 200),
        ...(line !== undefined ? { line } : {}),
      };
    }
    // 3b) Text in the reading view: prefer the live selection, else the block text.
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    const block = target.closest("p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6") as HTMLElement | null;
    const quote = selected || (block?.textContent ?? target.textContent ?? "").trim();
    // Source line of the clicked section (stamped by the line post-processor), so
    // createThread can place a durable `^blockId` on that source block.
    const secEl = target.closest<HTMLElement>("[data-review-md-line-start]");
    const rawLine = secEl?.dataset.reviewMdLineStart;
    const line = rawLine != null && rawLine !== "" ? Number(rawLine) : undefined;
    return {
      type: "text",
      quote: quote.slice(0, 200),
      ...(line !== undefined && Number.isFinite(line) ? { line } : {}),
    };
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
      const a = t.anchor as { type?: string; node?: string; quote?: string; src?: string; href?: string };
      const where =
        a.type === "mermaidNode"
          ? `diagram node \`${a.node}\``
          : a.type === "image"
            ? `image \`${a.src}\``
            : a.type === "link"
              ? `link ${a.quote ? `“${a.quote.replace(/\s+/g, " ").slice(0, 60)}” ` : ""}→ \`${a.href ?? ""}\``
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
    // Stamp the reviewed version before writing. bodyHash strips block-id markers
    // (see bodyHashFor), so the `^blockId` we may add below never counts as a
    // content change — it can't false-flag this or any other thread as outdated.
    const rev = await this.buildRev(file);
    // Text anchors get a durable native block ref so the thread survives edits to
    // the quoted text and share/reply `#^id` deep-links resolve. blockId may be an
    // id we mint here, or an existing one already on that block (blocks allow only
    // one id, so multiple threads on the same block share it). Best-effort: if the
    // block can't be located the anchor stays quote-only.
    if ((anchor as { type?: string }).type === "text") {
      const blockId = await this.ensureTextBlockId(file, id, (anchor as { line?: number }).line);
      if (blockId) (anchor as Record<string, unknown>).blockId = blockId;
    }
    // Per-anchor staleness stamp: hash of just what this thread anchors to, taken
    // AFTER the `^blockId` is placed (so a text anchor hashes the block it resolves
    // to). git/bodyHash above were computed BEFORE that write, so our own `^id`
    // never flips this thread's git stamp to WORKING_REV.
    const anchorHash = await this.anchorHashFor(file, anchor);
    if (anchorHash) rev.anchorHash = anchorHash;
    await this.mutateReview(file, (data) => {
      data.threads.push({ id, anchor, resolved: false, messages: [], rev });
    });
    return id;
  }

  /**
   * Ensure the source block for a text anchor carries a native `^blockId`, and
   * return the id to store on the anchor. If the block already has an id we reuse
   * it (Obsidian allows one id per block; threads on the same block share it);
   * otherwise we append ` ^<mintId>` to the block's last line. `line` is the
   * section's 0-based start line (from getSectionInfo, read fresh at click time).
   * Returns the block id, or null when the block can't be located / placed.
   */
  private async ensureTextBlockId(file: TFile, mintId: string, line?: number): Promise<string | null> {
    if (typeof line !== "number" || !Number.isFinite(line)) return null;
    const text = await this.app.vault.read(file);
    const lines = text.split("\n");
    if (line < 0 || line >= lines.length) return null;
    // Extend from the section start to the block's last non-blank line (a block is
    // a run of consecutive non-blank lines), and don't reach into a fenced block.
    let idx = line;
    while (idx + 1 < lines.length && lines[idx + 1].trim() !== "" && !/^\s*`{3,}/.test(lines[idx + 1])) {
      idx++;
    }
    while (idx > line && lines[idx].trim() === "") idx--;
    const target = lines[idx];
    const existing = target.match(/\s\^([A-Za-z0-9_-]+)\s*$/) ?? target.match(/^\^([A-Za-z0-9_-]+)\s*$/);
    if (existing) return existing[1];
    lines[idx] = `${target.replace(/\s+$/, "")} ^${mintId}`;
    await this.app.vault.modify(file, lines.join("\n"));
    return mintId;
  }

  /**
   * Strip a block id from a file's source when no thread references it any more.
   * Removes a trailing ` ^id` from a block's line (or a standalone `^id` line).
   * No-op if the id is still in use by another thread or isn't present.
   */
  private async cleanupBlockId(
    file: TFile,
    blockId: string | undefined,
    survivors: ReviewThread[],
  ): Promise<void> {
    if (!blockId) return;
    if (survivors.some((t) => (t.anchor as { blockId?: string }).blockId === blockId)) return;
    const text = await this.app.vault.read(file);
    const stripped = removeBlockIdFromText(text, blockId);
    if (stripped !== text) await this.app.vault.modify(file, stripped);
  }

  /** Hash of the file's body (frontmatter + block-id markers stripped) — the
   *  reviewed *content*. Block-ref markers (`^id`) are anchoring scaffolding we
   *  write, not prose, so they're excluded: adding a comment's anchor must never
   *  flip this or any other thread to "outdated". See docs/issues/durable-anchoring.md. */
  async bodyHashFor(file: TFile): Promise<string> {
    const text = await this.app.vault.read(file);
    return bodyHash(text);
  }

  /**
   * The current text of *just what a thread anchors to*, read from the latest file
   * — the per-anchor staleness signal (a thread is outdated only when ITS content
   * changed, not when the file changed anywhere; Omar, 2026-09-21):
   *   - `string`    → the anchored content as it stands now (node declaration, edge
   *                   link line, block/heading text, image src), normalised.
   *   - `null`      → the target is gone (node/edge/block/heading/image removed) →
   *                   the thread is outdated.
   *   - `undefined` → this anchor can't be precisely extracted → caller falls back
   *                   to the coarse `bodyHash`.
   * Normalisation collapses whitespace so reflowing/re-indenting the anchored text
   * without changing its words doesn't count as a change.
   */
  async anchorContentFor(
    file: TFile,
    anchor: Record<string, unknown>,
  ): Promise<string | null | undefined> {
    const a = anchor as {
      type?: string;
      node?: string;
      from?: string;
      to?: string;
      quote?: string;
      blockId?: string;
      src?: string;
      href?: string;
    };
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    switch (a.type) {
      case "mermaidNode": {
        if (!a.node) return undefined;
        const blocks = await this.mermaidBlocksIn(file);
        for (const b of blocks) {
          const dm = b.match(new RegExp(`\\b${escapeRegExp(a.node)}\\s*(${MERMAID_SHAPES})`));
          if (dm) return norm(`${a.node}${dm[1]}`); // declared node: id + shape/label
        }
        // Present but label-less (only ever named as an edge endpoint): its identity
        // is the id itself, so it's "unchanged" as long as the id still appears.
        const idRe = new RegExp(`(^|[^\\w])${escapeRegExp(a.node)}([^\\w]|$)`, "m");
        if (blocks.some((b) => idRe.test(b))) return a.node;
        return null; // node removed
      }
      case "mermaidEdge": {
        if (!a.from || !a.to) return undefined;
        const blocks = await this.mermaidBlocksIn(file);
        const link = new RegExp(
          `\\b${escapeRegExp(a.from)}\\b[^\\n]*?(?:--+>?|==+>?|-\\.-*>?|~~+)[^\\n]*?\\b${escapeRegExp(a.to)}\\b`,
        );
        for (const b of blocks) {
          const m = b.match(link);
          if (m) return norm(m[0]);
        }
        return null; // edge removed
      }
      case "text": {
        const body = stripFrontmatter(await this.app.vault.read(file));
        if (a.blockId) {
          const block = blockTextFor(body, a.blockId);
          return block == null ? null : norm(block);
        }
        if (a.quote) return norm(body).includes(norm(a.quote)) ? norm(a.quote) : null;
        return undefined; // no durable anchor to check
      }
      case "header": {
        if (!a.quote) return undefined;
        const body = stripFrontmatter(await this.app.vault.read(file));
        const q = norm(a.quote);
        const present = body.split(/\r?\n/).some((l) => {
          const m = l.match(/^#{1,6}\s+(.*)$/);
          return m != null && norm(m[1].replace(/\s+\^[A-Za-z0-9_-]+\s*$/, "")) === q;
        });
        return present ? q : null;
      }
      case "image": {
        if (!a.src) return undefined;
        const text = await this.app.vault.read(file);
        return text.includes(a.src) ? a.src : null;
      }
      case "link": {
        const href = a.href ?? "";
        const q = a.quote ?? "";
        if (!href && !q) return undefined;
        // The link is "still there" as long as its target (href) — or, for a
        // bare-text link, its display text — appears in the source. href+text
        // together are the anchored identity, so a change to either is outdated.
        const text = await this.app.vault.read(file);
        const present = href ? text.includes(href) : norm(text).includes(norm(q));
        return present ? norm(`${href} ${q}`) : null;
      }
      default:
        return undefined;
    }
  }

  /** Hash of a thread's anchored content (see anchorContentFor), or undefined when
   *  the anchor can't be precisely extracted (caller falls back to bodyHash). */
  async anchorHashFor(file: TFile, anchor: Record<string, unknown>): Promise<string | undefined> {
    const content = await this.anchorContentFor(file, anchor);
    return typeof content === "string" ? await sha256Short(content) : undefined;
  }

  /** Version stamp for a new thread: body hash + git commit/blob when available.
   *  The per-anchor `anchorHash` is added by createThread AFTER any `^blockId` is
   *  placed, so a text anchor hashes the block it will actually resolve to. */
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
    const exec = (cwd: string, args: string[], trim = true): Promise<string | null> =>
      new Promise((res) => {
        try {
          cp.execFile(
            "git",
            ["-C", cwd, ...args],
            { timeout: 4000, maxBuffer: 16 * 1024 * 1024 },
            (err: unknown, out: string) => res(err ? null : trim ? String(out).trim() : String(out)),
          );
        } catch {
          res(null);
        }
      });
    // Probe for the repo root from the file's own directory, then run every real
    // command FROM that root. `rel` is repo-root-relative, and git resolves a
    // pathspec relative to cwd — so running from a subfolder (e.g. docs/designs)
    // made `-- docs/designs/design.md` match nothing and silently emptied the
    // revision history for any file not at the vault root. Tree-ish forms
    // (`HEAD:<rel>`, `<commit>:<rel>`) always resolve from the root, which masked
    // the bug until a nested doc's `--follow` log came back empty. See
    // docs/issues/git-pathspec-cwd.md.
    const root = await exec(dir, ["rev-parse", "--show-toplevel"]);
    if (!root) return null;
    const run = (args: string[], trim = true): Promise<string | null> => exec(root, args, trim);
    return { run, rel: nodePath.relative(root, abs) };
  }

  /**
   * The commit + blob a comment is stamped against, or null when there's no git
   * work tree / the file isn't committed / no Node access (mobile). Each git call
   * has a short timeout so a slow/hung repo can't freeze thread creation.
   *
   * Two cases:
   * - **Working copy dirty** (uncommitted edits to this file): the reviewed body
   *   isn't in any commit yet, so stamp `commit = WORKING_REV` and record the
   *   working-tree blob (`git hash-object`). A post-commit hook later re-anchors
   *   the thread to the real commit whose `HEAD:<path>` blob equals this one.
   * - **Clean**: the version is the last commit that actually TOUCHED this file,
   *   not HEAD — unrelated commits don't produce a new version of the reviewed doc
   *   (Omar, 2026-09-21). The blob at that commit equals HEAD's blob (nothing
   *   changed the file since), so `git show <commit>:<path>` retrieval is consistent.
   */
  async gitRevFor(file: TFile): Promise<{ commit: string; blob: string } | null> {
    const ctx = await this.gitContext(file);
    if (!ctx) return null;
    // Uncommitted edits to this file? `status --porcelain -- <path>` is non-empty
    // for modified/staged/untracked. Then the reviewed body lives only in the
    // working tree — stamp WORKING_REV + the working blob for the re-anchor hook.
    const status = await ctx.run(["status", "--porcelain", "--", ctx.rel]);
    if (status) {
      const workBlob = await ctx.run(["hash-object", "--", ctx.rel]);
      if (workBlob) return { commit: WORKING_REV, blob: workBlob };
      return null; // couldn't hash (e.g. deleted) → fall back to git-agnostic path
    }
    const commit = await ctx.run(["rev-list", "-1", "--abbrev-commit", "HEAD", "--", ctx.rel]);
    const blob = await ctx.run(["rev-parse", `HEAD:${ctx.rel}`]);
    if (!commit || !blob) return null; // untracked / no commits → git-agnostic path
    return { commit, blob };
  }

  /**
   * Version number for each commit that ever touched `file`, keyed by the same
   * abbreviated sha the thread stamps use (`--abbrev-commit`). The file's whole
   * history is numbered newest-first: the latest commit that touched it is the
   * highest `v` (so `v7` reads as "the 7th and newest version"), the first commit
   * is `v1`. The comments sidebar turns these into the "Revisions" filter labels
   * (`v7 (b24cd88)`); a commit with no comments simply never appears there. Empty
   * map when there's no git work tree / Node access (mobile).
   */
  async fileRevisionOrdinals(file: TFile): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ctx = await this.gitContext(file);
    if (!ctx) return out;
    // `git log --follow` so renames don't truncate the history; abbreviated shas
    // match the thread stamps (both use core.abbrev). NOTE: `--follow` must NOT be
    // combined with `--reverse` — git then drops the rename trace and returns only
    // the tip commit (a known git limitation; silently broke v-numbering the moment
    // design.md was moved into docs/designs/). So fetch newest→oldest and reverse in
    // JS; the ordinal is then the 1-based position from the oldest commit.
    const log = await ctx.run(["log", "--follow", "--format=%h", "--", ctx.rel], false);
    if (!log) return out;
    return ordinalsFromLog(log);
  }

  /**
   * Is a thread stale? Per-anchor: a thread is "outdated" only when the content IT
   * anchors to changed or was removed since it was authored — an edit to an
   * unrelated part of the file leaves it current (Omar, 2026-09-21: "unless on our
   * latest, we removed content"). When the thread carries an `anchorHash` we compare
   * against just its anchored content now; if that content can't be extracted we
   * fall back to the coarse whole-body `bodyHash`. Threads with no `rev` (e.g.
   * seeded fixtures) are never outdated.
   */
  async isThreadOutdated(file: TFile, thread: ReviewThread): Promise<boolean> {
    const rev = thread.rev;
    if (!rev) return false;
    if (rev.anchorHash) {
      const content = await this.anchorContentFor(file, thread.anchor);
      if (content === null) return true; // the anchored target is gone
      if (typeof content === "string") return (await sha256Short(content)) !== rev.anchorHash;
      // content === undefined: can't extract precisely → fall through to bodyHash
    }
    if (!rev.bodyHash) return false;
    return (await this.bodyHashFor(file)) !== rev.bodyHash;
  }

  /**
   * The file's body (frontmatter stripped) as of an arbitrary revision — a git
   * commit sha, or WORKING_REV for the current working tree — following renames
   * so an old path still resolves. null when there's no git access or the file
   * didn't exist at that commit. Powers the card's version stepper, which browses
   * the anchored content across the file's history; it takes a bare revision key
   * and applies no thread-specific outdated check.
   */
  async bodyAtRevision(file: TFile, commit: string): Promise<string | null> {
    if (commit === WORKING_REV) return stripFrontmatter(await this.app.vault.read(file));
    const ctx = await this.gitContext(file);
    if (!ctx) return null;
    const direct = await ctx.run(["show", `${commit}:${ctx.rel}`], false);
    if (direct !== null) return stripFrontmatter(direct);
    // The file may have been renamed since `commit` (the flagship doc moved into
    // docs/designs/), so `commit:<current-path>` doesn't exist. Resolve the file's
    // historical path(s) via --follow and retry, so the reviewed body — and the
    // diagram preview built from it — survives renames. Without this every stamp
    // predating a rename silently falls back to the stored quote.
    // See docs/issues/reviewed-body-across-renames.md.
    for (const path of await this.historicalPaths(ctx)) {
      if (path === ctx.rel) continue;
      const out = await ctx.run(["show", `${commit}:${path}`], false);
      if (out !== null) return stripFrontmatter(out);
    }
    return null;
  }

  /** Every path this file has had across its rename history (newest first),
   *  deduplicated. Used to recover an old blob whose path differs from today's. */
  private async historicalPaths(ctx: {
    run: (args: string[], trim?: boolean) => Promise<string | null>;
    rel: string;
  }): Promise<string[]> {
    const log = await ctx.run(["log", "--follow", "--name-only", "--format=", "--", ctx.rel], false);
    if (!log) return [];
    const paths: string[] = [];
    for (const line of log.split("\n").map((s) => s.trim())) {
      if (line && !paths.includes(line)) paths.push(line);
    }
    return paths;
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
    // Pick the surface by the view's CURRENT mode, not by which element exists:
    // a Live Preview view can still hold a stale, hidden `.markdown-preview-view`,
    // so preferring it would search the wrong (empty) container. getMode() is
    // "preview" for reading view, "source" for Live Preview / source (#24).
    const inEditor = view?.getMode?.() === "source";
    const container = inEditor
      ? (view?.contentEl.querySelector(".cm-editor .cm-content") as HTMLElement | null)
      : ((view?.contentEl.querySelector(".markdown-reading-view") as HTMLElement | null) ??
        (view?.contentEl.querySelector(".markdown-preview-view") as HTMLElement | null));
    if (!container) {
      new Notice("review-md: open the file to locate the comment");
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
      blockId?: string;
      href?: string;
    };
    let el: HTMLElement | null = null;

    if (a.type === "link" && (a.href || a.quote)) {
      // Match on the target first (internal links stash it on `data-href`,
      // external on `href`), then fall back to the display text. Iterating the
      // <a> set avoids attribute-selector escaping on arbitrary hrefs.
      const links = Array.from(container.querySelectorAll("a")) as HTMLAnchorElement[];
      el =
        (a.href
          ? links.find((l) => (l.getAttribute("data-href") ?? l.getAttribute("href")) === a.href)
          : undefined) ??
        (a.quote ? links.find((l) => (l.textContent ?? "").trim() === a.quote) : undefined) ??
        null;
    } else if (a.type === "image" && a.src) {
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
    } else if (a.type === "text") {
      // In Live Preview text renders as `.cm-line` (not <p>), so findBlockContaining
      // can't locate it — use the durable block ref, which Obsidian scrolls to and
      // flashes natively in the editor. Reading view keeps the quote-match + flash.
      if (inEditor) {
        if (a.blockId) {
          this.app.workspace.openLinkText(`${file.path}#^${a.blockId}`, file.path, false);
        } else {
          new Notice("review-md: this text thread has no durable anchor to locate");
        }
        return;
      }
      el = a.quote ? findBlockContaining(container, a.quote) : null;
      // Quote edited away / not found → fall back to the durable block ref, which
      // Obsidian re-tracks across edits. Native scroll, no flash (no element yet).
      if (!el && a.blockId) {
        this.app.workspace.openLinkText(`${file.path}#^${a.blockId}`, file.path, false);
        return;
      }
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

  /** Remove a single message (by thread id + message index) from the sidecar,
   *  leaving the thread and its other messages intact. Throws if it isn't found.
   *  Deleting the sole message is the caller's concern — see the view, which routes
   *  a last-message delete to deleteThread so no message-less thread is left behind. */
  async deleteMessage(file: TFile, threadId: string, index: number): Promise<void> {
    let ok = false;
    await this.mutateReview(file, (data) => {
      const t = data.threads.find((x) => x.id === threadId);
      if (t && t.messages[index]) {
        t.messages.splice(index, 1);
        ok = true;
      }
    });
    if (!ok) throw new Error(`message ${threadId}#${index} not found`);
  }

  /** Remove a thread from the file's sidecar entirely. Returns true if one went.
   *  Also strips the thread's source block id when no surviving thread uses it. */
  async deleteThread(file: TFile, threadId: string): Promise<boolean> {
    let removed = false;
    let orphanBlockId: string | undefined;
    let survivors: ReviewThread[] = [];
    await this.mutateReview(file, (data) => {
      const gone = data.threads.find((t) => t.id === threadId);
      orphanBlockId = (gone?.anchor as { blockId?: string })?.blockId;
      const next = data.threads.filter((t) => t.id !== threadId);
      removed = next.length !== data.threads.length;
      data.threads = next;
      survivors = next;
    });
    if (removed) await this.cleanupBlockId(file, orphanBlockId, survivors);
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
    const doomedThreads = threads.filter((t) => t.messages.length === 0 && t.id !== keepId);
    if (!doomedThreads.length) return 0;
    let survivors: ReviewThread[] = [];
    await this.mutateReview(file, (data) => {
      data.threads = data.threads.filter((t) => t.messages.length > 0 || t.id === keepId);
      survivors = data.threads;
    });
    // Strip source block ids left behind by pruned text threads (each only if no
    // survivor still anchors to it — blocks with several threads share one id).
    const orphanIds = new Set(
      doomedThreads
        .map((t) => (t.anchor as { blockId?: string }).blockId)
        .filter((b): b is string => !!b),
    );
    for (const blockId of orphanIds) await this.cleanupBlockId(file, blockId, survivors);
    return doomedThreads.length;
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

  /**
   * A `review-md-reply?...` URL **template** for a thread — `body` is required by
   * the reply action, so it's left as a clearly-fillable `{{reply}}` placeholder
   * for an app/agent (or a person editing the URL) to replace. Includes `author`.
   */
  buildReplyUrl(file: TFile, threadId: string, author = "external"): string {
    const q = (s: string) => encodeURIComponent(s);
    return (
      `obsidian://review-md-reply?vault=${q(this.app.vault.getName())}` +
      `&file=${q(file.path)}&thread=${q(threadId)}` +
      `&author=${q(author)}&body=${q("{{reply}}")}`
    );
  }

  /**
   * A **native** Obsidian link to a thread's anchor that resolves without this
   * plugin installed — a wikilink to the file, targeting the block ref when the
   * thread has one (text threads always do, since durable anchoring). Falls back
   * to a bare file wikilink for anchors with no block id (image/mermaid).
   */
  buildNativeLink(file: TFile, thread: ReviewThread): string {
    const blockId = (thread.anchor as { blockId?: string }).blockId;
    return blockId ? `[[${file.basename}#^${blockId}]]` : `[[${file.basename}]]`;
  }

  /** Copy a link for the comments sidebar's currently-focused thread, via a
   *  command. No-op with a Notice when the sidebar is closed or nothing is focused. */
  private async copyFocusedThreadLink(kind: "share" | "native" | "reply"): Promise<void> {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENTS)[0]?.view;
    if (view instanceof CommentsView) await view.copyFocusedLink(kind);
    else new Notice("review-md: open the comments sidebar and select a thread first");
  }

  /** Resolve + open the target file and, when a thread param is present, jump to
   *  its `^blockId`. Backs the `open` x-callback action. */
  private async handleUri(_op: XcallbackOperation, params: Record<string, string>): Promise<void> {
    const af = this.resolveFile(params.file);

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af);

    if (params.thread) {
      this.app.workspace.openLinkText(`${af.path}#^${params.thread}`, af.path, false);
    }
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
   * Decorate the *native* mermaid SVG in place with comment affordances —
   * **non-destructive**: no re-render, no source rewrite, no dependency on
   * `window.mermaid`. A commented node is recoloured (open) or left native
   * (resolved) and carries a 💬/✓ count badge; a commented edge gets a midpoint
   * badge. Waits (via observer) for the built-in SVG to land, then applies once;
   * diagrams with no threads stay 100% native.
   *
   * We overlay onto the built-in node/edge (see docs/issues/mermaid-node-restyle.md,
   * user request 2026-09-20) rather than injecting `rvw_` comment nodes into a
   * re-render — that disrupted the layout and needed a full re-draw. The `rvw_`
   * injection now lives only in the explicit **Bake** command.
   */
  private async augmentRenderedMermaid(el: HTMLElement, source: string, sourcePath: string): Promise<void> {
    if (!this.settings.showMermaidComments) return; // overlay hidden → stay 100% native
    const comments = await this.mermaidCommentsFor(source, sourcePath);
    const edgeComments = await this.mermaidEdgeCommentsFor(source, sourcePath);
    if (!comments.length && !edgeComments.length) return; // no threads → stay 100% native

    let applied = false;
    const obs = new MutationObserver(() => void doApply());
    const doApply = (): void => {
      if (applied) return;
      const host = (el.querySelector("svg")?.parentElement as HTMLElement | null) ?? el;
      if (!host.querySelector("svg")) return; // not rendered yet — a later mutation retries
      applied = true;
      obs.disconnect();
      try {
        this.styleCommentedNodes(host, comments);
        this.overlayEdgeBadges(host, edgeComments);
      } catch (err) {
        applied = false; // let a later mutation retry
        console.error("[review-md] mermaid augment failed", err);
      }
    };
    obs.observe(el, { childList: true, subtree: true });
    doApply();
  }

  /**
   * Recolour each commented node and drop a 💬/✓ count badge on it. Non-destructive:
   * a CSS class (`review-md-commented`) recolours the built-in shape while the
   * thread is open and is dropped when resolved (colour reverts to native), and the
   * badge `<g>` is appended into the node's own `<g class="node">` so it shares the
   * node's coordinate space. The ```mermaid source is never touched.
   */
  private styleCommentedNodes(host: HTMLElement, comments: ReviewThread[]): void {
    if (!comments.length) return;
    const svg = host.querySelector("svg");
    if (!svg) return;
    const ns = "http://www.w3.org/2000/svg";
    // One badge per NODE, counting unique threads (not replies) — a node can carry
    // several distinct discussions, so group by the node the anchor points at.
    const byNode = new Map<string, ReviewThread[]>();
    for (const t of comments) {
      const node = (t.anchor as { node?: string }).node;
      if (!node) continue;
      const list = byNode.get(node);
      if (list) list.push(t);
      else byNode.set(node, [t]);
    }
    for (const [node, threads] of byNode) {
      const g = svg.querySelector(
        `g.node[id*="-${node}-"], g.node[id$="-${node}"]`,
      ) as SVGGElement | null;
      if (!g) continue;
      const open = threads.filter((t) => !t.resolved);
      // Any open thread → recolour the built-in shape; all resolved → native colour.
      g.classList.toggle("review-md-commented", open.length > 0);
      // Rebuild the badge each apply so its count stays in sync with the thread set
      // (augment runs once per render, so this doesn't churn).
      g.querySelector(":scope > .review-md-node-badge")?.remove();
      const allResolved = open.length === 0;
      const badge = document.createElementNS(ns, "g");
      badge.setAttribute("class", "review-md-node-badge" + (allResolved ? " is-resolved" : ""));
      // Top-right corner, read from the shape's static attributes so it lands
      // correctly even when the reading-view section is display:none (getBBox
      // reads 0 then and would pin the badge to the node's centre).
      const pos = nodeShapeTopRight(g);
      badge.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);
      (badge as unknown as HTMLElement).dataset.node = node;
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("r", "11");
      const text = document.createElementNS(ns, "text");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      // The number is the count of open threads; 💬 for a single one, ✓ when the
      // node's threads are all resolved.
      const n = open.length;
      text.textContent = allResolved ? "✓" : n > 1 ? String(n) : "💬";
      const title = document.createElementNS(ns, "title");
      const total = threads.length;
      title.textContent = `${node}: ${total} thread${total === 1 ? "" : "s"}${allResolved ? " (resolved)" : ""}`;
      badge.append(title, circle, text);
      g.appendChild(badge);
    }
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
    // One badge per EDGE, counting unique threads (not replies) — group by the
    // edge the anchor points at (from → to, disambiguated by index).
    const byEdge = new Map<string, { from: string; to: string; index: number; threads: ReviewThread[] }>();
    for (const t of edgeComments) {
      const a = t.anchor as { from?: string; to?: string; index?: number };
      if (!a.from || !a.to) continue;
      const index = a.index ?? 0;
      const key = `${a.from}\u0000${a.to}\u0000${index}`;
      const grp = byEdge.get(key);
      if (grp) grp.threads.push(t);
      else byEdge.set(key, { from: a.from, to: a.to, index, threads: [t] });
    }
    for (const { from, to, index, threads } of byEdge.values()) {
      const path = findEdgePath(svg, from, to, index);
      if (!path || !path.parentNode) continue;
      let mid: DOMPoint;
      try {
        mid = path.getPointAtLength(path.getTotalLength() / 2);
      } catch {
        continue; // path not measurable yet
      }
      const edgeKey = `${from}-${to}-${index}`;
      // Rebuild the badge each apply so its count stays in sync with the thread set.
      svg.querySelector(`.review-md-edge-badge[data-edge="${edgeKey}"]`)?.remove();
      const open = threads.filter((t) => !t.resolved);
      const allResolved = open.length === 0;
      const g = document.createElementNS(ns, "g");
      g.setAttribute("class", "review-md-edge-badge" + (allResolved ? " is-resolved" : ""));
      g.setAttribute("transform", `translate(${mid.x}, ${mid.y})`);
      (g as unknown as HTMLElement).dataset.edge = edgeKey;
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("r", "11");
      const text = document.createElementNS(ns, "text");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "central");
      const n = open.length;
      text.textContent = allResolved ? "✓" : n > 1 ? String(n) : "💬";
      const title = document.createElementNS(ns, "title");
      const total = threads.length;
      title.textContent = `${from} → ${to}: ${total} thread${total === 1 ? "" : "s"}${allResolved ? " (resolved)" : ""}`;
      g.append(title, circle, text);
      path.parentNode.appendChild(g);
    }
  }

  /** Every ```mermaid fence's source in a file (fences stripped). */
  private async mermaidBlocksIn(file: TFile): Promise<string[]> {
    return mermaidBlocksFrom(await this.app.vault.read(file));
  }

  /**
   * A minimal single-node mermaid source for a mermaidNode thread (just the node,
   * per the design decision — no neighbours). Prefers the node's real definition
   * (shape + label) pulled from whichever diagram contains it, so the preview
   * matches the diagram; falls back to a labelled box built from the stored quote.
   * Returns null for non-mermaidNode anchors.
   */
  async mermaidNodePreviewSource(file: TFile, thread: ReviewThread): Promise<string | null> {
    return this.nodePreviewFromBlocks(await this.mermaidBlocksIn(file), thread);
  }

  /** As `mermaidNodePreviewSource`, but from a supplied set of mermaid fence
   *  bodies (e.g. a previous version pulled from git) rather than the live file. */
  private nodePreviewFromBlocks(blocks: string[], thread: ReviewThread): string | null {
    const a = thread.anchor as { type?: string; node?: string; quote?: string };
    if (a?.type !== "mermaidNode" || !a.node) return null;
    const node = a.node;
    const nodeRe = new RegExp(`(^|[^\\w])${escapeRegExp(node)}([^\\w]|$)`, "m");
    const src = blocks.find((b) => nodeRe.test(b));
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
    // Match the live overlay: an open thread recolours its node to the comment
    // amber; a resolved thread reverts to the native colour (so the card mirrors
    // exactly what the diagram shows).
    const styled = thread.resolved
      ? ""
      : `\n  classDef reviewCmt fill:#fff3bf,stroke:#f0c000,color:#5c3d00,stroke-width:2px\n  class ${node} reviewCmt`;
    return `flowchart TB\n  ${def}${styled}`;
  }

  /**
   * A minimal `from --> to` mermaid source for a mermaidEdge thread, so the card
   * previews the actual arrow that was commented on. Prefers each endpoint's real
   * shape+label pulled from the diagram; falls back to a plain box on the node id.
   * Returns null for non-mermaidEdge anchors.
   */
  async mermaidEdgePreviewSource(file: TFile, thread: ReviewThread): Promise<string | null> {
    return this.edgePreviewFromBlocks(await this.mermaidBlocksIn(file), thread);
  }

  /** As `mermaidEdgePreviewSource`, but from a supplied set of mermaid fence
   *  bodies (e.g. a previous version pulled from git) rather than the live file. */
  private edgePreviewFromBlocks(blocks: string[], thread: ReviewThread): string | null {
    const a = thread.anchor as { type?: string; from?: string; to?: string };
    if (a?.type !== "mermaidEdge" || !a.from || !a.to) return null;
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

  /**
   * Build a node/edge preview source from an already-fetched body — the version
   * stepper's per-revision path, where the body comes from `bodyAtRevision`
   * rather than the thread's own stamp. null for non-mermaid anchors or when the
   * element isn't in that version's diagram.
   */
  mermaidPreviewSourceFromBody(body: string, thread: ReviewThread): string | null {
    const type = (thread.anchor as { type?: string })?.type;
    if (type !== "mermaidNode" && type !== "mermaidEdge") return null;
    const blocks = mermaidBlocksFrom(body);
    return type === "mermaidEdge"
      ? this.edgePreviewFromBlocks(blocks, thread)
      : this.nodePreviewFromBlocks(blocks, thread);
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

/**
 * The top-right corner of a mermaid node, in the node group's local coordinates.
 * Read from the shape's static `x`/`y`/`width` attributes rather than `getBBox()`:
 * a reading-view section can be `display:none` when the badge is injected (no
 * retry after that), and `getBBox` reads 0 there — which would pin the badge to
 * the node's centre. Falls back to a (tolerated-zero) measure for non-rect shapes.
 */
function nodeShapeTopRight(g: SVGGElement): { x: number; y: number } {
  const rect = g.querySelector("rect");
  if (rect) {
    const x = parseFloat(rect.getAttribute("x") ?? "");
    const y = parseFloat(rect.getAttribute("y") ?? "");
    const w = parseFloat(rect.getAttribute("width") ?? "");
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w)) return { x: x + w, y };
  }
  try {
    const b = (g as unknown as SVGGraphicsElement).getBBox();
    if (b.width > 0) return { x: b.x + b.width, y: b.y };
  } catch {
    /* not measurable yet */
  }
  return { x: 0, y: 0 };
}

/** A one-word label for an anchor, for notices. */
function describeAnchorShort(anchor: Record<string, unknown>): string {
  const type = String(anchor.type ?? "text");
  if (type === "mermaidNode") return `node ${anchor.node}`;
  if (type === "mermaidEdge") return `edge ${anchor.from}→${anchor.to}`;
  if (type === "image") return "image";
  if (type === "link") return "link";
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

/**
 * The plugin's Settings tab (#6): reviewer identity + the mermaid-overlay toggle.
 * Both preferences persist through the plugin's `saveData`/`saveSettings` path.
 */
class ReviewMdSettingTab extends PluginSettingTab {
  private plugin: ReviewMdPlugin;

  constructor(app: App, plugin: ReviewMdPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Reviewer name")
      .setDesc('The name new comments and replies are posted under. Leave blank to post as "reviewer".')
      .addText((text) =>
        text
          .setPlaceholder("Your name")
          .setValue(this.plugin.settings.reviewerName)
          .onChange(async (value) => {
            this.plugin.settings.reviewerName = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show mermaid comment badges")
      .setDesc(
        "Overlay comment nodes and edge badges on rendered mermaid diagrams. " +
          "Off renders diagrams fully native (comments stay in the sidecar).",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showMermaidComments)
          .onChange((value) => void this.plugin.setShowMermaidComments(value)),
      );
  }
}

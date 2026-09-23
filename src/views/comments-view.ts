import { ItemView, WorkspaceLeaf, TFile, Notice, setIcon, Menu, MarkdownRenderer } from "obsidian";
import type ReviewMdPlugin from "../main";
import type { ReviewThread } from "../main";
import {
  WORKING_REV,
  revKeyOf,
  revLabelFor,
  snippetAround,
  middleEllipsis,
} from "../pure";

export const VIEW_TYPE_COMMENTS = "review-md-comments";

/** A thread's display status. `hidden` = its anchored version text has drifted
 *  (outdated), so it may no longer resolve in the doc. Partitioned by priority
 *  resolved > hidden > open, so the header counts sum to the total. */
type ThreadCategory = "open" | "hidden" | "resolved";
const CATEGORY_ORDER: ThreadCategory[] = ["open", "hidden", "resolved"];
const CATEGORY_ICON: Record<ThreadCategory, string> = {
  open: "message-circle",
  hidden: "eye-off",
  resolved: "check",
};

/**
 * The comments sidebar: lists the active file's threads (loaded from its sibling
 * `.<name>.comments.md` sidecar via the plugin), each as a card of messages with
 * a reply box and a share link. Read/write goes through the plugin (readThreads /
 * appendReply / setThreadResolved / buildShareUrl) so the sidebar and the
 * x-callback `reply` action share one code path. See docs/designs/design.md and docs/api/.
 */
export class CommentsView extends ItemView {
  private plugin: ReviewMdPlugin;
  /** The file whose threads are currently shown (tracks the active markdown file). */
  private file: TFile | null = null;
  /** Draft `author` used for replies sent from the sidebar. */
  private author = "omar";
  /** Threads for `file`, loaded from its sidecar; render() paints from this cache. */
  private threads: ReviewThread[] = [];
  /** Current body hash of `file`, recomputed each render to flag stale threads. */
  private bodyHash: string | null = null;
  /** The thread the user last selected (clicked/focused) — target of the
   *  command-palette copy-link commands. */
  private focusedThreadId: string | null = null;
  /** Which status categories are visible; toggled by the header filter chips. */
  private activeFilters = new Set<ThreadCategory>(["open", "hidden", "resolved"]);
  /** Thread ids whose reviewed body has drifted (outdated) — filled once the
   *  current body hash is known, so a thread can be categorised "hidden". */
  private outdatedIds = new Set<string>();
  /** The revision the "Revisions" header filter is pinned to: `null` = All,
   *  else a commit sha (or WORKING_REV) — only threads authored against it show. */
  private revisionFilter: string | null = null;
  /** Distinct authoring revisions present in the current file's threads, newest
   *  first, as `{ key, label }` — the "Revisions" dropdown's items. Filled async
   *  by refreshRevisions() once git version numbers resolve. */
  private revisions: { key: string; label: string }[] = [];
  /** Live refs to the header dropdown so refreshRevisions()/setRevisionFilter()
   *  can repaint its label + active state without a full re-render. */
  private revFilterBtn: HTMLButtonElement | null = null;
  private revFilterLabelEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ReviewMdPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_COMMENTS;
  }
  getDisplayText(): string {
    return "review-md comments";
  }
  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    // Re-render when the user switches files or the reviewed file changes on disk
    // (a body edit shifts the staleness signal).
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncActiveFile()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncActiveFile()));
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => {
        if (this.file && f.path === this.file.path) void this.refresh();
      }),
    );
    this.syncActiveFile();
  }

  /** Reload threads from the file's sidecar, then repaint. Comment writes go to a
   *  dotfile Obsidian doesn't index, so the plugin calls this after every write. */
  async refresh(): Promise<void> {
    this.threads = this.file ? await this.plugin.readThreads(this.file) : [];
    this.render();
  }

  async onClose(): Promise<void> {
    // registerEvent handles listener teardown.
  }

  /** Point the view at the active markdown file and re-render if it changed. */
  private syncActiveFile(): void {
    const active = this.app.workspace.getActiveFile();
    const next = active && active.extension === "md" ? active : this.file;
    // Same file already shown: the panel is current, so do NOT re-render. This
    // fires on every active-leaf-change (e.g. clicking into the editor), and a
    // full rebuild here would blow away transient card DOM — an expanded
    // "Content Revisions" accordion, an in-progress reply/edit, an armed delete.
    // On-disk body edits to this file are caught by the metadataCache "changed"
    // listener instead, so drift is still repainted when it actually happens.
    if (this.file && next === this.file) return;
    // Leaving a file abandons any thread there we never gave a first comment.
    const prev = this.file;
    this.file = next;
    // A revision is meaningful only within its file — reset the filter on switch.
    this.revisionFilter = null;
    if (prev && prev !== next) void this.plugin.pruneEmptyThreads(prev);
    void this.refresh();
  }

  /** Scroll a thread's card into view and focus its reply box (after creation). */
  async focusThread(threadId: string): Promise<void> {
    // The new thread may not be in the cache/DOM yet — reload from the sidecar first.
    await this.refresh();
    const card = this.contentEl.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
    if (!card) return;
    this.setFocused(threadId);
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.addClass("review-md-flash");
    window.setTimeout(() => card.removeClass("review-md-flash"), 1600);
    card.querySelector<HTMLTextAreaElement>(".review-md-reply-input")?.focus();
  }

  /** Mark a thread as the selected one (target of the copy-link commands). */
  private setFocused(threadId: string): void {
    this.focusedThreadId = threadId;
    this.contentEl
      .querySelectorAll(".review-md-thread.is-focused")
      .forEach((c) => c.removeClass("is-focused"));
    this.contentEl.querySelector(`[data-thread-id="${threadId}"]`)?.addClass("is-focused");
  }

  /** The currently-focused thread + its file, or null. Used by the copy-link
   *  commands in the plugin. */
  private focused(): { file: TFile; thread: ReviewThread } | null {
    if (!this.file || !this.focusedThreadId) return null;
    const thread = this.threads.find((t) => t.id === this.focusedThreadId);
    return thread ? { file: this.file, thread } : null;
  }

  /** Copy a link for the focused thread (command entry point). */
  async copyFocusedLink(kind: "share" | "native" | "reply"): Promise<void> {
    const f = this.focused();
    if (!f) {
      new Notice("review-md: click a thread in the sidebar to select it first");
      return;
    }
    await this.copyLink(f.thread, kind);
  }

  /** Rebuild the whole panel from the current file's threads. */
  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("review-md-comments");

    if (!this.file) {
      root.createEl("p", { cls: "review-md-empty", text: "Open a markdown file to see its comments." });
      return;
    }

    // Resolve staleness so drifted threads can be flagged, then repaint the
    // affected cards. Async: the initial paint shows cards, staleness lands a
    // tick later (no layout jump — the badge slots into a reserved row).
    void this.computeStaleness(this.file);

    const header = root.createDiv({ cls: "review-md-header" });
    header.createEl("h3", { text: this.file.basename });
    const threads = this.threads;

    // Status counts as clickable filter chips (open / hidden / resolved). Each
    // toggles whether its category of cards is shown; all on by default. Counts
    // + the "hidden" (drifted) split are finalised in fillVersionRows() once the
    // body hash is known — chips are (re)built by refreshChips() from there.
    // "Revisions" filter — a dropdown that pins the list to comments authored
    // against one revision (All by default). Leads the controls row, ahead of the
    // status chips; its items (v7 (sha), v6 …) are filled async by refreshRevisions().
    const revBtn = header.createEl("button", {
      cls: "review-md-rev-filter",
      attr: { "aria-label": "Filter comments by revision" },
    });
    setIcon(revBtn.createSpan({ cls: "review-md-rev-filter-icon" }), "history");
    this.revFilterLabelEl = revBtn.createSpan({ cls: "review-md-rev-filter-label", text: "Revisions" });
    setIcon(revBtn.createSpan({ cls: "review-md-rev-filter-caret" }), "chevron-down");
    revBtn.onclick = (e) => this.showRevisionMenu(e);
    this.revFilterBtn = revBtn;
    void this.refreshRevisions();

    const chips = header.createDiv({ cls: "review-md-chips" });
    for (const cat of CATEGORY_ORDER) {
      const chip = chips.createEl("button", {
        cls: "review-md-chip",
        attr: { "data-cat": cat, "aria-label": `Show ${cat} threads`, "aria-pressed": "true" },
      });
      setIcon(chip.createSpan({ cls: "review-md-chip-icon" }), CATEGORY_ICON[cat]);
      chip.createSpan({ cls: "review-md-chip-label" });
      chip.onclick = () => {
        if (this.activeFilters.has(cat)) this.activeFilters.delete(cat);
        else this.activeFilters.add(cat);
        this.applyFilter();
      };
    }

    if (threads.length === 0) {
      root.createEl("p", {
        cls: "review-md-empty",
        text: "No comment threads yet — turn on comment mode and click the document.",
      });
      return;
    }

    // Open threads first, then resolved ones.
    const ordered = [...threads].sort((a, b) => Number(a.resolved) - Number(b.resolved));
    for (const thread of ordered) this.renderThread(root, thread);
    // Paint chips + card visibility now (outdated set may still be empty; the
    // async body-hash pass re-runs this with the drift known).
    this.applyFilter();
  }

  /** The display category for a thread: resolved > hidden(drifted) > open. */
  private categoryOf(thread: ReviewThread): ThreadCategory {
    if (thread.resolved) return "resolved";
    if (this.outdatedIds.has(thread.id)) return "hidden";
    return "open";
  }

  /** Recompute chip counts + active styling and show/hide cards per the filter. */
  private applyFilter(): void {
    const counts: Record<ThreadCategory, number> = { open: 0, hidden: 0, resolved: 0 };
    for (const t of this.threads) counts[this.categoryOf(t)]++;

    this.contentEl.querySelectorAll<HTMLElement>(".review-md-chip").forEach((chip) => {
      const cat = chip.dataset.cat as ThreadCategory | undefined;
      if (!cat) return;
      const label = chip.querySelector<HTMLElement>(".review-md-chip-label");
      if (label) label.setText(`${counts[cat]} ${cat}`);
      const active = this.activeFilters.has(cat);
      chip.toggleClass("is-active", active);
      chip.setAttribute("aria-pressed", String(active));
      // A zero-count category can't be toggled to anything useful.
      chip.toggleClass("is-empty", counts[cat] === 0);
    });

    this.contentEl.querySelectorAll<HTMLElement>(".review-md-thread").forEach((card) => {
      const t = card.dataset.threadId ? this.threads.find((x) => x.id === card.dataset.threadId) : undefined;
      if (!t) return;
      const visible = this.activeFilters.has(this.categoryOf(t)) && this.matchesRevision(t);
      card.toggleClass("is-filtered-out", !visible);
    });
  }

  /** Identity of the revision a thread was authored against — the SAME value the
   *  card's version stamp shows (fillVersionRows): a git commit (incl. WORKING_REV)
   *  when the file was tracked, else the body-hash. `null` for an unstamped thread. */
  private revKeyOf(thread: ReviewThread): string | null {
    return revKeyOf(thread.rev);
  }

  /** True when a thread passes the active revision filter (All ⇒ always). */
  private matchesRevision(thread: ReviewThread): boolean {
    if (this.revisionFilter === null) return true;
    return this.revKeyOf(thread) === this.revisionFilter;
  }

  /** Open the Revisions dropdown: All + one entry per authoring revision, the
   *  current selection checked. */
  private showRevisionMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("All").setChecked(this.revisionFilter === null).onClick(() => this.setRevisionFilter(null)),
    );
    for (const r of this.revisions) {
      menu.addItem((i) =>
        i.setTitle(r.label).setChecked(this.revisionFilter === r.key).onClick(() => this.setRevisionFilter(r.key)),
      );
    }
    menu.showAtMouseEvent(e);
  }

  /** Pin (or clear) the revision filter and repaint. */
  private setRevisionFilter(key: string | null): void {
    this.revisionFilter = key;
    this.updateRevFilterLabel();
    this.applyFilter();
  }

  /** Reflect the current selection on the header button: "Revisions" when All,
   *  "Revisions · <label>" plus an accent when pinned to one revision. */
  private updateRevFilterLabel(): void {
    if (!this.revFilterLabelEl || !this.revFilterBtn) return;
    const active = this.revisions.find((r) => r.key === this.revisionFilter);
    this.revFilterLabelEl.setText(active ? `Revisions · ${active.label}` : "Revisions");
    this.revFilterBtn.toggleClass("is-active", this.revisionFilter !== null);
  }

  /** Gather the distinct revisions the current file's comments were authored
   *  against, newest first, and label them with git version numbers (`v7 (sha)`,
   *  or "Working copy" for uncommitted). Async: needs `git log` for the numbers. */
  private async refreshRevisions(): Promise<void> {
    if (!this.file) {
      this.revisions = [];
      this.updateRevFilterLabel();
      return;
    }
    // Distinct authoring revisions present across the file's threads.
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const t of this.threads) {
      const k = this.revKeyOf(t);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
    const ordinals = await this.plugin.fileRevisionOrdinals(this.file);
    // Newest first: the uncommitted working copy on top, then git commits by
    // version number descending, then any body-hash-only stamps (no ordinal) last.
    const rank = (k: string) => (k === WORKING_REV ? Infinity : (ordinals.get(k) ?? 0));
    keys.sort((a, b) => rank(b) - rank(a));
    this.revisions = keys.map((k) => ({ key: k, label: revLabelFor(k, ordinals) }));
    // A pinned revision that no longer exists (file switch race) falls back to All.
    if (this.revisionFilter !== null && !this.revisions.some((r) => r.key === this.revisionFilter)) {
      this.revisionFilter = null;
    }
    this.updateRevFilterLabel();
    this.applyFilter();
  }

  /** One thread card: anchor line, messages, controls, reply box. */
  private renderThread(root: HTMLElement, thread: ReviewThread): void {
    const card = root.createDiv({ cls: "review-md-thread" });
    card.dataset.threadId = thread.id;
    if (thread.resolved) card.addClass("is-resolved");
    // The card doubles as a "locate in the document" button, so make it keyboard-
    // operable: focusable, announced as a button, and driven by Enter/Space.
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Locate thread ${thread.id} in the document`);
    // Bidirectional link: activating the card (except over a control) scrolls the
    // reader to the anchored region and flashes a highlight over it.
    const locate = () => {
      this.setFocused(thread.id);
      if (this.file) this.plugin.highlightAnchor(this.file, thread);
    };
    card.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, textarea, a")) return;
      locate();
    };
    card.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Only the card itself, not a focused control inside it (textarea, button,
      // link), should trigger locate — those handle Enter/Space themselves.
      if ((e.target as HTMLElement).closest("button, textarea, a, input")) return;
      e.preventDefault();
      locate();
    };
    if (thread.id === this.focusedThreadId) card.addClass("is-focused");

    const top = card.createDiv({ cls: "review-md-thread-top" });
    top.createEl("code", { cls: "review-md-tid", text: thread.id });
    // A compact content-type badge (node / edge / text / image / header) rather
    // than a verbose anchor line — the preview right below already shows *which*
    // node/passage this is, so the header only needs to say *what kind*. The full
    // description stays as the tooltip.
    top.createEl("span", {
      cls: "review-md-type-badge",
      text: anchorTypeLabel(thread.anchor),
      attr: { "data-type": anchorTypeLabel(thread.anchor), title: describeAnchor(thread.anchor) },
    });
    if (thread.resolved) top.createEl("span", { cls: "review-md-resolved-tag", text: "resolved" });

    // Share — a top-right icon (moved out of the action row); opens the link-kind
    // menu (share / native / reply). margin-left:auto floats it to the right edge.
    const share = top.createEl("button", {
      cls: "review-md-share clickable-icon",
      attr: { "aria-label": "Share this thread" },
    });
    setIcon(share, "share-2");
    share.onclick = (e) => {
      this.setFocused(thread.id);
      this.showCopyMenu(e, thread);
    };

    // Version row — filled by fillVersionRows() once the current body hash is
    // known: always the commit/version this comment was authored on, plus an
    // "outdated" warning when the reviewed body has since changed.
    card.createDiv({ cls: "review-md-rev" });

    // Show what the comment is anchored to, inline in the card: a mini render of
    // the diagram node, or a blockquote of the highlighted passage.
    const anchorType = (thread.anchor as { type?: string })?.type;
    if (anchorType === "mermaidNode" || anchorType === "mermaidEdge") {
      this.renderMermaidPreview(card, thread);
    } else if (anchorType === "text") {
      this.renderTextPreview(card, thread);
    } else if (anchorType === "link") {
      this.renderLinkPreview(card, thread);
    }

    const msgs = card.createDiv({ cls: "review-md-messages" });
    if (thread.messages.length === 0) {
      msgs.createDiv({ cls: "review-md-empty-thread", text: "New thread — add the first comment below." });
    }
    thread.messages.forEach((m, index) => {
      const row = msgs.createDiv({ cls: "review-md-message" });
      const meta = row.createDiv({ cls: "review-md-meta" });
      meta.createEl("span", { cls: "review-md-author", text: m.author });
      meta.createEl("span", { cls: "review-md-ts", text: formatTs(m.ts) });
      const edit = meta.createEl("button", {
        cls: "review-md-edit clickable-icon",
        attr: { "aria-label": "Edit comment" },
      });
      setIcon(edit, "pencil");
      // Per-message delete (trash), revealed on hover/focus like the edit pencil.
      // On the sole message this is really "delete the thread", so route it there
      // (and say so) rather than leave a message-less thread behind.
      const sole = thread.messages.length === 1;
      const del = meta.createEl("button", {
        cls: "review-md-msg-del clickable-icon",
        attr: { "aria-label": sole ? "Delete comment (removes the thread)" : "Delete comment" },
      });
      setIcon(del, "trash-2");
      this.armDeleteButton(del, () =>
        sole ? void this.deleteThread(thread) : void this.deleteMessage(thread, index),
      );
      const body = row.createDiv({ cls: "review-md-body" });
      // Render the message body as Markdown via Obsidian's sanctioned renderer
      // (no innerHTML) so code/links/lists/bold display, not raw source.
      void MarkdownRenderer.render(this.app, m.body, body, this.file?.path ?? "", this);
      const startEdit = () => this.beginEditMessage(thread, index, row, m.body);
      edit.onclick = startEdit;
      body.ondblclick = startEdit; // double-click the text to edit it
    });

    // Reply box.
    const replyBox = card.createDiv({ cls: "review-md-reply" });
    const ta = replyBox.createEl("textarea", {
      cls: "review-md-reply-input",
      attr: { rows: "2", placeholder: "Reply… (⌘/Ctrl+Enter to post)" },
    });
    // Keyboard submit: ⌘Enter (mac) / Ctrl+Enter posts; plain Enter still inserts
    // a newline. Escape abandons an in-progress reply by blurring the box.
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.sendReply(thread, ta);
      } else if (e.key === "Escape") {
        ta.blur();
      }
    });
    const actions = replyBox.createDiv({ cls: "review-md-actions" });

    const send = labeledButton(actions, "send", "Post", "mod-cta");
    send.onclick = () => void this.sendReply(thread, ta);

    const toggle = thread.resolved
      ? labeledButton(actions, "rotate-ccw", "Reopen")
      : labeledButton(actions, "circle-check", "Resolve");
    toggle.onclick = () => void this.toggleResolved(thread);

    // Delete — two-step so a stray click can't lose a thread. First click arms
    // ("Delete?"), second within 3s removes it from the file's frontmatter.
    const del = labeledButton(actions, "trash-2", "", "review-md-delete");
    del.setAttribute("aria-label", "Delete thread");
    this.armDeleteButton(del, () => void this.deleteThread(thread), "Delete?");
  }

  /**
   * Wire a two-step "arm then confirm" onto a trash button, the shared delete
   * gesture: the first click arms it (danger tint; `confirmLabel`, if given, shown
   * as a label beside the icon) for 3s, and a second click within that window runs
   * `onConfirm`. An unconfirmed arm disarms itself after the timeout.
   */
  private armDeleteButton(btn: HTMLButtonElement, onConfirm: () => void, confirmLabel?: string): void {
    let armed = false;
    let armTimer = 0;
    const reset = () => {
      armed = false;
      btn.removeClass("is-armed");
      btn.empty();
      setIcon(btn, "trash-2");
    };
    btn.onclick = () => {
      if (!armed) {
        armed = true;
        btn.addClass("is-armed");
        btn.empty();
        setIcon(btn, "trash-2");
        if (confirmLabel) btn.createSpan({ cls: "review-md-btn-label", text: confirmLabel });
        armTimer = window.setTimeout(reset, 3000);
        return;
      }
      window.clearTimeout(armTimer);
      onConfirm();
    };
  }

  /** Render the highlighted passage as a small blockquote that fits the card. */
  private renderTextPreview(card: HTMLElement, thread: ReviewThread): void {
    const raw = (thread.anchor as { quote?: unknown }).quote;
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (!text) return;
    card.createEl("blockquote", { cls: "review-md-text-preview", text: middleEllipsis(text) });
  }

  /** Inline preview for a link anchor: the display text plus its target href. */
  private renderLinkPreview(card: HTMLElement, thread: ReviewThread): void {
    const a = thread.anchor as { href?: unknown; quote?: unknown };
    const href = typeof a.href === "string" ? a.href.trim() : "";
    const quote = typeof a.quote === "string" ? a.quote.replace(/\s+/g, " ").trim() : "";
    if (!href && !quote) return;
    const box = card.createDiv({ cls: "review-md-link-preview" });
    if (quote) box.createSpan({ cls: "review-md-link-text", text: middleEllipsis(quote) });
    if (href) box.createEl("code", { cls: "review-md-link-href", text: middleEllipsis(href) });
  }

  /** Render a mini SVG of the commented diagram node or edge into the card. */
  private renderMermaidPreview(card: HTMLElement, thread: ReviewThread): void {
    if (!this.file) return;
    const host = card.createDiv({ cls: "review-md-node-preview" });
    const file = this.file;
    const isEdge = (thread.anchor as { type?: string })?.type === "mermaidEdge";
    const source = isEdge
      ? this.plugin.mermaidEdgePreviewSource(file, thread)
      : this.plugin.mermaidNodePreviewSource(file, thread);
    void source.then(async (src) => {
      if (!src || !host.isConnected) return;
      const svg = await this.plugin.renderMermaidSvg(src);
      if (!svg || !host.isConnected) return; // silent: card still shows the text anchor
      if (!setSvg(host, svg)) return;
      host.addClass("is-loaded");
    });
  }

  /**
   * Resolve which threads have drifted, per-anchor: a thread is "outdated" only
   * when the content IT anchors to changed or was removed, not when the file
   * changed anywhere (plugin.isThreadOutdated). Also caches the body hash for the
   * version-stamp fallback. Runs each render; repaints the version rows once known.
   */
  private async computeStaleness(file: TFile): Promise<void> {
    // Capture the array the flags are computed against: a refresh() during the
    // await can reassign this.threads, and filtering the NEW array by flags
    // indexed to the OLD one would mark the wrong threads outdated.
    const threads = this.threads;
    const [bodyHash, flags] = await Promise.all([
      this.plugin.bodyHashFor(file),
      Promise.all(threads.map((t) => this.plugin.isThreadOutdated(file, t))),
    ]);
    if (this.file !== file) return; // the user switched files while we awaited
    this.bodyHash = bodyHash;
    this.outdatedIds = new Set(threads.filter((_, i) => flags[i]).map((t) => t.id));
    void this.fillVersionRows();
  }

  /**
   * Fill each card's `.review-md-rev` slot with the version the comment was
   * authored on — always, so a reader can see which commit/version of the
   * artifact a comment belongs to — plus an "outdated" warning when the anchored
   * content has changed since. Runs after computeStaleness resolves drift.
   */
  private async fillVersionRows(): Promise<void> {
    const file = this.file;
    if (!file) return;
    // One git call for the whole batch: the file's version ladder (sha → v-number).
    const ordinals = await this.plugin.fileRevisionOrdinals(file);
    if (this.file !== file) return; // the user switched files while we awaited
    const byId = new Map(this.threads.map((t) => [t.id, t]));
    this.contentEl.querySelectorAll<HTMLElement>(".review-md-thread").forEach((card) => {
      const id = card.dataset.threadId;
      const slot = card.querySelector<HTMLElement>(".review-md-rev");
      const thread = id ? byId.get(id) : undefined;
      if (!slot || !thread) return;
      slot.empty();
      slot.removeClass("is-visible");
      if (!thread.rev?.bodyHash) return; // seeded fixtures with no stamp stay quiet
      slot.addClass("is-visible");
      this.renderVersionStepper(thread, slot, ordinals, this.outdatedIds.has(thread.id));
    });
    // Drift is now known — repaint chip counts + apply the filter.
    this.applyFilter();
  }

  /**
   * The card's version row: a stepper `‹ vK (sha) ›` in place of the old static
   * "on <sha>" stamp plus the "Content Revisions" accordion. The comment was
   * authored against one version; the stepper opens there and browses the file's
   * history one version at a time. Per the chosen mapping, the LEFT button steps
   * toward the latest version (disabled once there) and the RIGHT button toward
   * older ones (disabled at the oldest). The centred label names the version and,
   * clicked, toggles an inline preview of the anchored content as it was then, so
   * cards stay compact until you ask to see the content.
   */
  private renderVersionStepper(
    thread: ReviewThread,
    slot: HTMLElement,
    ordinals: Map<string, number>,
    outdated: boolean,
  ): void {
    const authored = revKeyOf(thread.rev);
    // Ordered newest→oldest: committed versions by v-number descending. The
    // uncommitted working copy only joins the ladder when the comment itself was
    // authored on it (an otherwise-committed file's ladder is its commits).
    const commits = [...ordinals.entries()].sort((a, b) => b[1] - a[1]).map(([sha]) => sha);
    const versions = authored === WORKING_REV ? [WORKING_REV, ...commits] : commits;
    const startIdx = authored ? versions.indexOf(authored) : -1;

    // No usable git ladder (unstamped, body-hash-only, or a commit not in this
    // file's history): fall back to the plain authored-version stamp, no stepper.
    if (startIdx === -1) {
      this.renderStaticStamp(thread, slot, outdated);
      return;
    }

    let idx = startIdx;
    const cache = new Map<string, string | null>(); // fetched body per version key
    const step = slot.createDiv({ cls: "review-md-verstep" });
    const newer = step.createEl("button", {
      cls: "review-md-verstep-btn",
      attr: { "aria-label": "Newer version" },
    });
    setIcon(newer, "chevron-left");
    const label = step.createEl("button", {
      cls: "review-md-verstep-label",
      attr: {
        "aria-label": "Toggle a preview of the anchored content at this version",
        "aria-expanded": "false",
      },
    });
    const older = step.createEl("button", {
      cls: "review-md-verstep-btn",
      attr: { "aria-label": "Older version" },
    });
    setIcon(older, "chevron-right");
    if (outdated) {
      const badge = step.createSpan({ cls: "review-md-outdated" });
      setIcon(badge, "alert-triangle");
      badge.createSpan({ text: "outdated" });
    }
    const preview = slot.createDiv({ cls: "review-md-verpreview" });
    preview.hidden = true;

    const sync = () => {
      const key = versions[idx];
      const isAuthored = key === authored;
      label.setText(revLabelFor(key, ordinals));
      label.toggleClass("is-authored", isAuthored);
      label.title = isAuthored
        ? "The version this comment was authored against — click to preview its content"
        : `Preview the anchored content as it was in ${revLabelFor(key, ordinals)}`;
      newer.disabled = idx === 0; // already at the latest
      older.disabled = idx === versions.length - 1; // already at the oldest
      if (!preview.hidden) void this.showVersionPreview(thread, preview, key, ordinals, cache);
    };
    newer.onclick = () => {
      if (idx > 0) {
        idx--;
        sync();
      }
    };
    older.onclick = () => {
      if (idx < versions.length - 1) {
        idx++;
        sync();
      }
    };
    label.onclick = () => {
      preview.hidden = !preview.hidden;
      step.toggleClass("is-open", !preview.hidden);
      label.setAttribute("aria-expanded", String(!preview.hidden));
      if (!preview.hidden) void this.showVersionPreview(thread, preview, versions[idx], ordinals, cache);
    };
    sync();
  }

  /** The plain "on <sha>" / "working copy" stamp, for threads with no navigable
   *  git ladder (unstamped fixtures, body-hash-only, or off a git work tree). */
  private renderStaticStamp(thread: ReviewThread, slot: HTMLElement, outdated: boolean): void {
    const rev = thread.rev;
    if (!rev?.bodyHash) return;
    const working = rev.git?.commit === WORKING_REV;
    const version = working ? "working copy" : (rev.git?.commit ?? rev.bodyHash.slice(0, 7));
    const stamp = slot.createSpan({ cls: "review-md-rev-base" });
    setIcon(stamp.createSpan({ cls: "review-md-rev-icon" }), working ? "git-branch" : "git-commit");
    stamp.createSpan({ text: working ? ` ${version}` : ` on ${version}` });
    stamp.title = working
      ? "Comment made on the uncommitted working copy; re-anchors to a commit when the file is committed"
      : `Comment made on version ${version}`;
    if (outdated) {
      const badge = slot.createSpan({ cls: "review-md-outdated" });
      setIcon(badge, "alert-triangle");
      badge.createSpan({ text: "outdated" });
    }
  }

  /**
   * Render the anchored content as it was in one version into the stepper's inline
   * preview box. The body is fetched via `bodyAtRevision` (cached per version so
   * re-stepping is instant) and shown as a rendered mini-diagram for node/edge
   * anchors, else a text snippet centred on the anchor quote. A `want` guard drops
   * a late fetch when the user has already stepped on.
   */
  private async showVersionPreview(
    thread: ReviewThread,
    box: HTMLElement,
    versionKey: string,
    ordinals: Map<string, number>,
    cache: Map<string, string | null>,
  ): Promise<void> {
    const file = this.file;
    if (!file) return;
    box.dataset.want = versionKey;
    box.empty();
    const holder = box.createDiv({ cls: "review-md-reviewed" });
    const label = revLabelFor(versionKey, ordinals);
    let body: string | null;
    if (cache.has(versionKey)) {
      body = cache.get(versionKey) ?? null;
    } else {
      holder.createDiv({ cls: "review-md-reviewed-label", text: `Loading ${label}…` });
      body = await this.plugin.bodyAtRevision(file, versionKey);
      if (!box.isConnected || box.dataset.want !== versionKey) return; // superseded
      cache.set(versionKey, body);
      holder.empty();
    }
    if (body === null) {
      holder.createDiv({ cls: "review-md-reviewed-label", text: `Not available in ${label}` });
      return;
    }
    holder.createDiv({ cls: "review-md-reviewed-label", text: label });

    const type = (thread.anchor as { type?: string })?.type;
    if (type === "mermaidNode" || type === "mermaidEdge") {
      const src = this.plugin.mermaidPreviewSourceFromBody(body, thread);
      if (src) {
        const svg = await this.plugin.renderMermaidSvg(src);
        if (!box.isConnected || box.dataset.want !== versionKey) return; // superseded
        if (svg) {
          const host = holder.createDiv({ cls: "review-md-node-preview is-loaded" });
          if (setSvg(host, svg)) return;
          host.remove();
        }
      }
    }
    const quote = typeof thread.anchor?.quote === "string" ? thread.anchor.quote : "";
    holder.createEl("pre", { text: snippetAround(body, quote) });
  }

  /** Swap a message row's body for an editable textarea with Save / Cancel. */
  private beginEditMessage(
    thread: ReviewThread,
    index: number,
    row: HTMLElement,
    current: string,
  ): void {
    if (!this.file) return;
    if (row.querySelector(".review-md-edit-box")) return; // already editing
    const body = row.querySelector<HTMLElement>(".review-md-body");
    if (body) body.hide();

    const box = row.createDiv({ cls: "review-md-edit-box" });
    const ta = box.createEl("textarea", { cls: "review-md-reply-input" });
    ta.value = current;
    ta.rows = Math.min(8, Math.max(2, current.split("\n").length));
    const editActions = box.createDiv({ cls: "review-md-actions" });

    const doSave = async () => {
      const next = ta.value.trim();
      if (!next) {
        new Notice("review-md: comment can't be empty");
        return;
      }
      try {
        await this.plugin.editMessage(this.file!, thread.id, index, next);
        this.render();
      } catch (err) {
        new Notice(`review-md: ${String(err)}`);
      }
    };
    const doCancel = () => {
      box.remove();
      if (body) body.show();
    };
    const save = labeledButton(editActions, "check", "Save", "mod-cta");
    save.onclick = () => void doSave();
    const cancel = labeledButton(editActions, "x", "Cancel");
    cancel.onclick = doCancel;
    // Same keyboard submit as the reply box: ⌘/Ctrl+Enter saves, Escape cancels.
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void doSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        doCancel();
      }
    });
    ta.focus();
  }

  private async sendReply(thread: ReviewThread, ta: HTMLTextAreaElement): Promise<void> {
    if (!this.file) return;
    const body = ta.value.trim();
    if (!body) {
      new Notice("review-md: reply is empty");
      return;
    }
    try {
      await this.plugin.appendReply(this.file, thread.id, { author: this.author, body });
      ta.value = "";
      new Notice(`review-md: replied to ${thread.id}`);
      this.render();
    } catch (err) {
      new Notice(`review-md: ${String(err)}`);
    }
  }

  /** Dropdown of the three link kinds, anchored to the card's share icon. */
  private showCopyMenu(e: MouseEvent, thread: ReviewThread): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Copy share link").setIcon("link").onClick(() => void this.copyLink(thread, "share")),
    );
    menu.addItem((i) =>
      i
        .setTitle("Copy native link (works without the plugin)")
        .setIcon("file-symlink")
        .onClick(() => void this.copyLink(thread, "native")),
    );
    menu.addItem((i) =>
      i
        .setTitle("Copy reply-link template")
        .setIcon("reply")
        .onClick(() => void this.copyLink(thread, "reply")),
    );
    menu.showAtMouseEvent(e);
  }

  /** Copy one of the three link kinds for a thread to the clipboard. */
  private async copyLink(thread: ReviewThread, kind: "share" | "native" | "reply"): Promise<void> {
    if (!this.file) return;
    let text: string;
    let label: string;
    if (kind === "native") {
      text = this.plugin.buildNativeLink(this.file, thread);
      label = "native link";
    } else if (kind === "reply") {
      text = this.plugin.buildReplyUrl(this.file, thread.id, this.author);
      label = "reply-link template (fill in {{reply}})";
    } else {
      text = this.plugin.buildShareUrl(this.file, thread.id);
      label = "share link";
    }
    await navigator.clipboard.writeText(text);
    new Notice(`review-md: ${label} copied`);
  }

  private async toggleResolved(thread: ReviewThread): Promise<void> {
    if (!this.file) return;
    await this.plugin.setThreadResolved(this.file, thread.id, !thread.resolved);
    this.render();
  }

  private async deleteThread(thread: ReviewThread): Promise<void> {
    if (!this.file) return;
    try {
      const removed = await this.plugin.deleteThread(this.file, thread.id);
      new Notice(removed ? `review-md: deleted thread ${thread.id}` : `review-md: thread ${thread.id} not found`);
      this.render();
    } catch (err) {
      new Notice(`review-md: ${String(err)}`);
    }
  }

  /** Remove a single message from a thread (the per-message trash affordance),
   *  leaving the rest of the thread intact. The sole-message case is routed to
   *  deleteThread by the caller, so this never empties a thread. */
  private async deleteMessage(thread: ReviewThread, index: number): Promise<void> {
    if (!this.file) return;
    try {
      await this.plugin.deleteMessage(this.file, thread.id, index);
      new Notice(`review-md: deleted a comment in ${thread.id}`);
      this.render();
    } catch (err) {
      new Notice(`review-md: ${String(err)}`);
    }
  }
}

/**
 * Inject a rendered mermaid SVG into `host` without assigning `innerHTML`
 * (Obsidian plugin guidelines reject `innerHTML`/`outerHTML` assignment). The
 * SVG string comes from mermaid's own `render`; we parse it as an XML document
 * and adopt the `<svg>` node rather than string-injecting it. Returns false —
 * drawing nothing — if the string doesn't parse to an `<svg>`, so callers keep
 * their text fallback.
 */
function setSvg(host: HTMLElement, svg: string): boolean {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const el = doc.documentElement;
  if (doc.querySelector("parsererror") || el.localName !== "svg") return false;
  host.empty();
  host.appendChild(document.importNode(el, true));
  return true;
}

/** A button with a leading Lucide icon and an optional text label. */
function labeledButton(parent: HTMLElement, icon: string, label: string, cls?: string): HTMLButtonElement {
  const b = parent.createEl("button", cls ? { cls } : {});
  setIcon(b, icon);
  if (label) b.createSpan({ cls: "review-md-btn-label", text: label });
  return b;
}

/** Short content-type label for the card's type badge. */
function anchorTypeLabel(anchor: Record<string, unknown>): string {
  switch (String(anchor?.type ?? "unknown")) {
    case "mermaidNode":
      return "node";
    case "mermaidEdge":
      return "edge";
    case "text":
      return "text";
    case "image":
      return "image";
    case "header":
      return "header";
    case "link":
      return "link";
    default:
      return String(anchor?.type ?? "unknown");
  }
}

/** Human-readable one-liner for a thread's anchor. */
function describeAnchor(anchor: Record<string, unknown>): string {
  const type = String(anchor?.type ?? "unknown");
  if (type === "mermaidNode") return `diagram ${anchor.blockId ?? "?"} · node ${anchor.node ?? "?"}`;
  if (type === "mermaidEdge") return `diagram ${anchor.blockId ?? "?"} · edge ${anchor.from ?? "?"} → ${anchor.to ?? "?"}`;
  if (type === "image") return `image ${anchor.src ?? "?"}`;
  if (type === "link") return `link → ${anchor.href ?? anchor.quote ?? "?"}`;
  if (type === "text") {
    // The full passage is shown in the blockquote preview below, so keep the
    // summary line terse (just a line ref when there's no quote to preview).
    return anchor.quote ? "text" : `text · line ${anchor.line ?? "?"}`;
  }
  return type;
}


/** Compact timestamp for display; falls back to the raw string if unparseable. */
function formatTs(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

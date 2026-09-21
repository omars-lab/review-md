import { ItemView, WorkspaceLeaf, TFile, Notice, setIcon, Menu } from "obsidian";
import type ReviewMdPlugin from "../main";
import { WORKING_REV } from "../main";
import type { ReviewThread } from "../main";

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
    if (next !== this.file) {
      // Leaving a file abandons any thread there we never gave a first comment.
      const prev = this.file;
      this.file = next;
      // A revision is meaningful only within its file — reset the filter on switch.
      this.revisionFilter = null;
      if (prev && prev !== next) void this.plugin.pruneEmptyThreads(prev);
    }
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
      const chip = chips.createEl("button", { cls: "review-md-chip", attr: { "data-cat": cat } });
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
      chip.toggleClass("is-active", this.activeFilters.has(cat));
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
    const rev = thread.rev;
    if (!rev) return null;
    if (rev.git?.commit) return rev.git.commit;
    if (rev.bodyHash) return rev.bodyHash;
    return null;
  }

  /** Human label for a revision key: "Working copy", a git version number
   *  (`v7 (b24cd88)`), or the bare body-hash slug when there's no git ordinal. */
  private revLabelFor(key: string, ordinals: Map<string, number>): string {
    if (key === WORKING_REV) return "Working copy";
    const v = ordinals.get(key);
    return v ? `v${v} (${key.slice(0, 7)})` : key.slice(0, 7);
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
    this.revisions = keys.map((k) => ({ key: k, label: this.revLabelFor(k, ordinals) }));
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
    // Bidirectional link: clicking anywhere on the card (except the controls)
    // scrolls the reader to the anchored region and flashes a highlight over it.
    card.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("button, textarea, a")) return;
      this.setFocused(thread.id);
      if (this.file) this.plugin.highlightAnchor(this.file, thread);
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
      const body = row.createDiv({ cls: "review-md-body", text: m.body });
      const startEdit = () => this.beginEditMessage(thread, index, row, m.body);
      edit.onclick = startEdit;
      body.ondblclick = startEdit; // double-click the text to edit it
    });

    // Reply box.
    const replyBox = card.createDiv({ cls: "review-md-reply" });
    const ta = replyBox.createEl("textarea", {
      cls: "review-md-reply-input",
      attr: { rows: "2", placeholder: "Reply…" },
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
    let armed = false;
    let armTimer = 0;
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.addClass("is-armed");
        del.empty();
        setIcon(del, "trash-2");
        del.createSpan({ cls: "review-md-btn-label", text: "Delete?" });
        armTimer = window.setTimeout(() => {
          armed = false;
          del.removeClass("is-armed");
          del.empty();
          setIcon(del, "trash-2");
        }, 3000);
        return;
      }
      window.clearTimeout(armTimer);
      void this.deleteThread(thread);
    };
  }

  /** Render the highlighted passage as a small blockquote that fits the card. */
  private renderTextPreview(card: HTMLElement, thread: ReviewThread): void {
    const raw = (thread.anchor as { quote?: unknown }).quote;
    const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (!text) return;
    card.createEl("blockquote", { cls: "review-md-text-preview", text: middleEllipsis(text) });
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
      host.innerHTML = svg;
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
    const [bodyHash, flags] = await Promise.all([
      this.plugin.bodyHashFor(file),
      Promise.all(this.threads.map((t) => this.plugin.isThreadOutdated(file, t))),
    ]);
    if (this.file !== file) return; // the user switched files while we awaited
    this.bodyHash = bodyHash;
    this.outdatedIds = new Set(this.threads.filter((_, i) => flags[i]).map((t) => t.id));
    this.fillVersionRows();
  }

  /**
   * Fill each card's `.review-md-rev` slot with the version the comment was
   * authored on — always, so a reader can see which commit/version of the
   * artifact a comment belongs to — plus an "outdated" warning when the anchored
   * content has changed since. Runs after computeStaleness resolves drift.
   */
  private fillVersionRows(): void {
    if (!this.file) return;
    const byId = new Map(this.threads.map((t) => [t.id, t]));
    this.contentEl.querySelectorAll<HTMLElement>(".review-md-thread").forEach((card) => {
      const id = card.dataset.threadId;
      const slot = card.querySelector<HTMLElement>(".review-md-rev");
      const thread = id ? byId.get(id) : undefined;
      if (!slot || !thread) return;
      slot.empty();
      slot.removeClass("is-visible");
      const rev = thread.rev;
      if (!rev?.bodyHash) return; // seeded fixtures with no stamp stay quiet
      slot.addClass("is-visible");

      // Always: which version this comment was made against. A commit sha when the
      // file was git-tracked at authoring time, "working copy" for a comment left
      // on uncommitted state, else the body-hash slug.
      const working = rev.git?.commit === WORKING_REV;
      const version = working ? "working copy" : (rev.git?.commit ?? rev.bodyHash.slice(0, 7));
      const stamp = slot.createSpan({ cls: "review-md-rev-base" });
      setIcon(stamp.createSpan({ cls: "review-md-rev-icon" }), working ? "git-branch" : "git-commit");
      stamp.createSpan({ text: working ? ` ${version}` : ` on ${version}` });
      stamp.title = working
        ? "Comment made on the uncommitted working copy; re-anchors to a commit when the file is committed"
        : `Comment made on version ${version}`;

      // Only when the reviewed body has since diverged: an outdated warning.
      if (this.outdatedIds.has(thread.id)) {
        const badge = slot.createSpan({ cls: "review-md-outdated" });
        setIcon(badge, "alert-triangle");
        badge.createSpan({ text: "outdated" });
      }

      // The affordance to view the exact version this comment was made against.
      const show = labeledButton(slot, "history", "Show reviewed version", "review-md-show-rev");
      show.onclick = () => void this.showReviewedVersion(thread, card);
    });
    // Drift is now known — repaint chip counts + apply the filter.
    this.applyFilter();
  }

  /** Toggle an inline panel showing the text as it was when the comment was made. */
  private async showReviewedVersion(thread: ReviewThread, card: HTMLElement): Promise<void> {
    if (!this.file) return;
    const existing = card.querySelector(".review-md-reviewed");
    if (existing) {
      existing.remove();
      return;
    }
    const quote = typeof thread.anchor?.quote === "string" ? thread.anchor.quote : "";
    const body = await this.plugin.reviewedBodyFor(this.file, thread);
    const box = card.createDiv({ cls: "review-md-reviewed" });
    if (body !== null) {
      const commit = thread.rev?.git?.commit ?? "";
      box.createDiv({ cls: "review-md-reviewed-label", text: `reviewed @ ${commit}` });
      box.createEl("pre", { text: snippetAround(body, quote) });
    } else if (quote) {
      box.createDiv({ cls: "review-md-reviewed-label", text: "stored quote (no git history)" });
      box.createEl("pre", { text: quote });
    } else {
      box.createDiv({ cls: "review-md-reviewed-label", text: "no reviewed version available" });
    }
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

    const save = labeledButton(editActions, "check", "Save", "mod-cta");
    save.onclick = async () => {
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
    const cancel = labeledButton(editActions, "x", "Cancel");
    cancel.onclick = () => {
      box.remove();
      if (body) body.show();
    };
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
}

/** A button with a leading Lucide icon and an optional text label. */
function labeledButton(parent: HTMLElement, icon: string, label: string, cls?: string): HTMLButtonElement {
  const b = parent.createEl("button", cls ? { cls } : {});
  setIcon(b, icon);
  if (label) b.createSpan({ cls: "review-md-btn-label", text: label });
  return b;
}

/**
 * A readable window of the reviewed body: centred on the anchor quote when it's
 * still present, else the opening lines. Keeps the panel from dumping a whole file.
 */
function snippetAround(body: string, quote: string, radius = 240): string {
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
  if (type === "text") {
    // The full passage is shown in the blockquote preview below, so keep the
    // summary line terse (just a line ref when there's no quote to preview).
    return anchor.quote ? "text" : `text · line ${anchor.line ?? "?"}`;
  }
  return type;
}

/** Elide the middle of a long string: "start … end", keeping both ends visible. */
function middleEllipsis(s: string, max = 180): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 3) * 0.6);
  const tail = Math.floor((max - 3) * 0.4);
  return `${s.slice(0, head).trimEnd()} … ${s.slice(s.length - tail).trimStart()}`;
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

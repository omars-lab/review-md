import { ItemView, WorkspaceLeaf, TFile, Notice, setIcon } from "obsidian";
import type ReviewMdPlugin from "../main";
import type { ReviewThread } from "../main";

export const VIEW_TYPE_COMMENTS = "review-md-comments";

/**
 * The comments sidebar: lists the active file's threads (loaded from its sibling
 * `.<name>.comments.md` sidecar via the plugin), each as a card of messages with
 * a reply box and a share link. Read/write goes through the plugin (readThreads /
 * appendReply / setThreadResolved / buildShareUrl) so the sidebar and the
 * x-callback `reply` action share one code path. See design.md and docs/api/.
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
    if (next !== this.file) this.file = next;
    void this.refresh();
  }

  /** Scroll a thread's card into view and focus its reply box (after creation). */
  async focusThread(threadId: string): Promise<void> {
    // The new thread may not be in the cache/DOM yet — reload from the sidecar first.
    await this.refresh();
    const card = this.contentEl.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.addClass("review-md-flash");
    window.setTimeout(() => card.removeClass("review-md-flash"), 1600);
    card.querySelector<HTMLTextAreaElement>(".review-md-reply-input")?.focus();
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

    // Recompute the body hash so stale threads can be flagged, then repaint the
    // affected cards. Async: the initial paint shows cards, staleness lands a
    // tick later (no layout jump — the badge slots into a reserved row).
    const file = this.file;
    void this.plugin.bodyHashFor(file).then((h) => {
      if (this.file === file) {
        this.bodyHash = h;
        this.markStaleThreads();
      }
    });

    const header = root.createDiv({ cls: "review-md-header" });
    header.createEl("h3", { text: this.file.basename });
    const threads = this.threads;
    header.createEl("span", {
      cls: "review-md-count",
      text: threads.length === 1 ? "1 thread" : `${threads.length} threads`,
    });

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
      if (this.file) this.plugin.highlightAnchor(this.file, thread);
    };

    const top = card.createDiv({ cls: "review-md-thread-top" });
    top.createEl("code", { cls: "review-md-tid", text: thread.id });
    top.createEl("span", {
      cls: "review-md-anchor",
      text: describeAnchor(thread.anchor),
      attr: { title: "Click the card to locate this comment in the document" },
    });
    if (thread.resolved) top.createEl("span", { cls: "review-md-resolved-tag", text: "resolved" });

    // Version-staleness row — filled by markStaleThreads() once the current body
    // hash is known, and only when this thread's reviewed version has changed.
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

    const send = labeledButton(actions, "send", "Send", "mod-cta");
    send.onclick = () => void this.sendReply(thread, ta);

    const share = labeledButton(actions, "link", "Copy");
    share.onclick = () => void this.copyShareLink(thread);

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
   * Fill each card's `.review-md-rev` slot with an "outdated" badge when the
   * thread's stored `rev.bodyHash` no longer matches the file's current body.
   * Runs after render() resolves the current hash; leaves fresh threads quiet.
   */
  private markStaleThreads(): void {
    if (!this.file || !this.bodyHash) return;
    const byId = new Map(this.threads.map((t) => [t.id, t]));
    this.contentEl.querySelectorAll<HTMLElement>(".review-md-thread").forEach((card) => {
      const id = card.dataset.threadId;
      const slot = card.querySelector<HTMLElement>(".review-md-rev");
      const thread = id ? byId.get(id) : undefined;
      if (!slot || !thread) return;
      slot.empty();
      slot.removeClass("is-visible");
      const rev = thread.rev;
      if (!rev?.bodyHash || rev.bodyHash === this.bodyHash) return; // no stamp, or unchanged
      slot.addClass("is-visible");
      const badge = slot.createSpan({ cls: "review-md-outdated" });
      setIcon(badge, "alert-triangle");
      badge.createSpan({ text: "outdated" });
      const base = rev.git?.commit ?? rev.bodyHash.slice(0, 7);
      slot.createSpan({ cls: "review-md-rev-base", text: `commented on ${base}` });
      const show = labeledButton(slot, "history", "Show reviewed version", "review-md-show-rev");
      show.onclick = () => void this.showReviewedVersion(thread, card);
    });
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

  private async copyShareLink(thread: ReviewThread): Promise<void> {
    if (!this.file) return;
    const url = this.plugin.buildShareUrl(this.file, thread.id);
    await navigator.clipboard.writeText(url);
    new Notice("review-md: share link copied");
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

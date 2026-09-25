# Comment creation: instant-thread → draft composer

## The old flow (instant create)

In comment mode, a single click in the reader minted a thread immediately:
`handleCommentClick` resolved the anchor, then called `createThread(file, anchor)`
straight away, opened the sidebar, and focused the (empty) new card. The first
comment was typed into that card's reply box afterwards.

Two problems, both confirmed against the live render:

1. **No preview of what you were anchoring to.** The thread was already written by
   the time you looked at the card — you couldn't see the target (which node, which
   passage) *before* committing to it.
2. **Empty-thread litter.** Every click wrote a message-less thread. A mis-click, or
   a click you thought better of, left an empty thread in the sidecar. A
   `pruneEmptyThreads` sweep (on file-leave, and before the next mint) existed
   purely to garbage-collect these — a workaround for a gesture that created state
   too eagerly.

## Why the composer

Move the write to the end of the gesture, not the start: a click should *propose* a
comment, not commit one. The reviewer sees the anchor, types (or doesn't), and only
**Comment** writes anything — **Cancel** discards with no sidecar write at all. This
removes the empty-thread failure mode by construction rather than sweeping it up
afterward.

## What changed

- `handleCommentClick` no longer calls `createThread`. It resolves the anchor
  exactly as before (`resolveClickAnchor` and all its img/link/mermaid/text
  hit-testing are **unchanged**), opens the sidebar, and hands the anchor to the
  sidebar via `openDraftComposer` → `CommentsView.beginDraft`. The
  clicked-comment-node and edge-badge branches (which open an *existing* thread) are
  untouched.
- `CommentsView` gained a `draftAnchor` field. While set, `render()` paints a
  **draft card at the top** of the panel: the anchor preview (reusing the same
  node/edge/text/link/image renderers as a real card) plus a focused input with
  **Comment** / **Cancel**. ⌘/Ctrl+Enter posts, Escape cancels — the keyboard
  pattern the reply/edit boxes already use.
- The thread is written only on **Comment**, via
  `createThread(file, anchor, { author, body })`. `createThread` grew an optional
  `firstMessage` param so the thread and its first comment land in a **single**
  sidecar write — no transient message-less thread is ever committed. The author is
  the effective reviewer name (`plugin.effectiveAuthor()`), not a hard-coded name.
- The pre-mint `pruneEmptyThreads(file)` call was removed from the click handler (no
  empty threads are created now). The file-leave prune in `syncActiveFile` stays, so
  any *legacy* empty threads still get cleaned up.

## Chosen shape (vs. a floating popup)

The composer renders as a card **in the sidebar**, not a popover positioned over the
clicked element in the document. Reasons: it reuses the existing card + anchor-preview
rendering (one code path, consistent look), it doesn't have to track the anchor's
on-screen position across scroll/re-layout, and it sits right where the resulting
thread will live. A document-anchored popup was considered and rejected as more
fragile for no real gain.

## Note

Changing the create gesture makes the comment-mode demo GIF (`docs/media/`) stale —
recapturing that is a separate media workstream, deliberately not done here.

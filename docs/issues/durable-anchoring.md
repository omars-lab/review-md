# Durable block-ref anchoring for text threads

## The problem

A text thread used to anchor on its stored `quote` alone: `highlightAnchor`
re-found the comment by substring-matching the quote against the rendered blocks
(`findBlockContaining`). That is resilient to edits *above* the anchor (it's
content-addressed, not line-addressed), but it breaks in exactly the cases that
matter for a review that outlives a few edits:

- **The quoted text itself is edited** → no block matches, the comment is orphaned.
- **The quote appears more than once** → the flash lands on the wrong block.
- **Share / reply deep-links never resolved.** `review-md-open` / `review-md-reply`
  and the sidebar Copy link all build `…#^<threadId>`, but nothing ever wrote a
  `^<id>` marker into the source, so the native block scroll silently no-op'd for
  text threads.

## The fix

On text-thread creation the plugin writes a native Obsidian **block id** (`^id`)
onto the anchored source block and records it as `anchor.blockId`. Obsidian
re-tracks a `^id` across edits natively (it moves with the block, stays unique),
so the anchor and every `#^id` deep-link survive edits to the quoted text.

- **blockId = thread id** when we mint one. If the block already carries an id
  (Obsidian allows only one per block), we **reuse** it — several threads on the
  same block share one block id, and each keeps its own thread `id` and `quote`.
- **Placement.** From the clicked section's start line (stamped onto the DOM by a
  line post-processor — `getSectionInfo` is only available in a post-processor,
  never on an arbitrary click, and line numbers are read fresh at click time,
  never trusted stale), we extend to the block's last non-blank line (without
  reaching into a fenced code block) and append ` ^id`. Verified live that
  Obsidian parses this into `metadataCache.blocks` even for a blockquote's last
  `> …` line, so `#^id` resolves. Best-effort: if the block can't be located the
  anchor stays quote-only (the old behaviour).
- **Highlight fallback.** `highlightAnchor` still flashes via quote match when the
  text is present; when the quote was edited away it falls back to
  `openLinkText(file#^blockId)` — the durable ref — to at least scroll there.
- **Cleanup.** When a thread is deleted or an abandoned message-less thread is
  pruned, its `^id` is stripped from source **only if no surviving thread still
  references that block id** (`cleanupBlockId`).

## Reconciling with the sidecar principle

`docs/issues/comment-sidecar.md` established that **commenting must not create a
revision on the reviewed file** — that's why comment payload lives in the sibling
`.<name>.comments.md`. A block id written into the reviewed file is in tension
with that, and the reconciliation is deliberate:

- A `^id` marker is **anchoring scaffolding, not comment content.** It carries no
  prose, no author, no message — only a stable handle. The payload still lives
  entirely in the sidecar.
- **Block-id markers are excluded from the staleness signal.** `bodyHashFor` now
  strips `^id` markers (`stripBlockIds`) before hashing, exactly as it already
  strips frontmatter. So adding or removing an anchor **never** flips this or any
  other thread to "outdated" — verified live: creating a text thread left
  `isThreadOutdated` false. The reviewed file's *content* hash is unchanged by
  anchoring activity; only its git blob moves (git is identity/retrieval only, not
  staleness — see `version-stamping.md`).
- This is the composition the version-stamping doc already anticipated: "block-refs
  make an anchor survive edits within the working file; the version stamp records
  the baseline the anchor was made against."

This was Omar's call in the dogfood thread `a7b8c9` ("one block ref per thread so
links survive edits?" → "yes, one block ref per thread"), 2026-09-20.

## Verified live (sandbox, 2026-09-20)

- Line post-processor stamps every rendered section (15 blocks on `design.md`).
- Create text thread → `^<id>` appended to the block's last line, `anchor.blockId`
  stored, `isThreadOutdated` **false** (block id excluded from hash).
- Obsidian parsed the id into `metadataCache.blocks` (so `#^id` resolves) — even on
  a blockquote line.
- Second thread on the same block **reused** the id (one `^id` in source).
- Deleting a thread while another still uses the id **kept** the ref; deleting the
  last one **stripped** it and it left the metadata cache.

## Related

- `docs/issues/comment-sidecar.md` — the payload-vs-scaffolding boundary.
- `docs/issues/version-stamping.md` — the baseline half of anchoring.

# Comments panel: search, sort and thread folding

Follow-on to [panel-surgical-updates](panel-surgical-updates.md). Once the panel
stopped rebuilding itself on every write, it could hold state that a rebuild
would have thrown away — and that is what a long review needs: a way to find a
thread, an order that matches how you read, and cards that don't scroll for a
page each.

## What was added

All three live in the sticky header (`.review-md-header`) below the status chips,
in a `.review-md-tools` row, and all three compose with the chips and the
Revisions filter that were already there.

**Search** (`aria-label="Search comments"`): a case-insensitive substring over
everything a thread carries — its id, the anchor's type label (`node`, `edge`,
`text`…) and every string in the anchor (quote, href, src, node id, edge
endpoints), each message's author and body. `threadMatches` in `src/pure.ts`.
Non-matching cards get the same `is-filtered-out` class the chips use. Escape
clears the box.

**Sort** (`aria-label="Sort threads (<mode>)"`, an Obsidian `Menu`): three modes,
`compareThreads` in `src/pure.ts`. In every mode open threads lead and resolved
ones trail — the order the panel always had — and ties fall back to recency, then
to the sidecar's own (creation) order.

| Mode           | Key                                                          |
| -------------- | ------------------------------------------------------------ |
| Recency (default) | newest message timestamp, falling back to `rev.ts`        |
| Doc position   | the anchor's line in the current body — see below            |
| Author         | the first message's author, A→Z, case-insensitive            |

Recency is the default on the assumption that a reviewer opens the panel to see
what moved since they last looked. The choice is in-memory for the view's life
(not a setting) — a sort is a reading posture, not a preference to persist.

**Fold**: a thread with more than one message gets a "Show N earlier" / "Hide
earlier" toggle (`aria-expanded`) at the head of its messages; folded, only the
last message shows. A thread starts folded when it is resolved or has more than
`FOLD_OVER` (3) messages (`startsFolded`). After that first sight the fold state
is remembered per thread id in the view (`folded: Map<id, boolean>`) and only
the user's own toggles change it — a reply landing on a folded thread keeps it
folded (the new message is the visible one), and a card rebuilt for an anchor/rev
change reads the same map. The map is cleared on a file switch.

## What "doc position" means per anchor type

`anchorLineIn(body, anchor)` in `src/pure.ts` returns a 0-based line in the
current file text, read fresh on every paint (`app.vault.cachedRead`), so the
order follows edits rather than what was recorded at click time. The signal used,
per type, best first:

- **text / header** — the line carrying the anchor's `^blockId` (durable across
  edits; the re-anchor hook adds one), else the first line containing the quote
  (first 60 characters, whitespace-normalised, case-insensitive), else the
  `line` recorded when the comment was made.
- **mermaidNode** — the first line *inside a ```mermaid fence* that names the
  node id as a whole word. Prose mentions don't count. So nodes sort in
  declaration order within a diagram, and diagrams in document order. (The
  anchor's `blockId` is not used: it is empty for click-created threads and the
  doc has no `^id` on the fence.)
- **mermaidEdge** — the line of the `from … --> … to` link (the same link
  pattern `anchorContentFor` uses: `-->`, `==>`, `-.->`, `~~~`); else the line
  naming `from` in the first fence that also names `to`.
- **image** — the first line containing the `src`; when that is an `app://` URL
  (what the DOM hands back), the first line containing its file name.
- **link** — the first line containing the `href`, else the link text (quote).
- anything else — the quote, else unknown.

Unknown positions sort after every known one (then by recency), never hide.

## Verified live (harness `docs` vault)

Cold paint: header shows search + "Recency" sort; order `a7b8c9, qklp1y, d1a2b3,
e4f5a6` (newest activity first, resolved last); only the resolved `e4f5a6` starts
folded ("Show 1 earlier"). Positions read from `design.md`: qklp1y 84, d1a2b3 86,
e4f5a6 87, a7b8c9 99 — "Doc position" gives `qklp1y, d1a2b3, a7b8c9, e4f5a6`.
Search `VAULT` → `qklp1y` only; `claude` → the three threads claude replied on;
`edge` → the edge thread (type label); `zzz` → none; Escape → all four.

Surgical survival, in one `eval`: search `claude`, sort Doc position, unfold
`e4f5a6`, fold `d1a2b3`, type into `d1a2b3`'s reply box, then
`plugin.appendReply` on `qklp1y` + `refresh()`. After: search text, sort label,
both fold states, the card order, the draft text, focus and caret all as before;
`qklp1y` grew to 3 messages on the same element and stayed unfolded (its fold was
seeded at 2 messages). `focusThread("qklp1y")` then landed with `is-focused`,
the flash class and focus in its reply box. Screenshot `stage3-panel.png`.

One thing that looked like a loss and wasn't: a draft typed into a card the
search had *hidden* reported `active:false` — a `display:none` element cannot
hold focus in the first place (`focus()` is a no-op on it), so nothing was lost by
the update. Re-run on a visible card: preserved.

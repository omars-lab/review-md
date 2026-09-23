# Comments panel: surgical updates instead of a full rebuild

## What the teardown cost

`CommentsView.render()` emptied `contentEl` and rebuilt the header and every
thread card from scratch. It was the only repaint path, so it ran after **every**
write — reply, edit, resolve, delete, new thread — and, because the plugin's
`notifyReviewChanged` also calls `view.refresh()` after each sidecar write, most
writes rebuilt the panel **twice**. Each rebuild threw away everything the DOM was
holding for the reviewer:

- a reply or edit half-typed in *another* card's textarea;
- the focused element (and the keyboard caret), and the scroll offset;
- an armed two-step delete;
- an open version preview (the stepper's inline "as it was in vK" box), which had
  to be re-fetched and reopened;
- every mermaid mini-render (re-rendered per card, per rebuild).

`syncActiveFile` already had to special-case "same file → do NOT re-render" to
stop a click into the editor from blowing the panel away, which was the first
sign the rebuild was the wrong primitive. At four threads the double rebuild was
merely wasteful; at forty it also made the panel unusable while a review was in
flight (every reply from a collaborator's x-callback link clobbered your draft).

## What changed

**`render()` is now the cold path only** — first paint and a file switch. It
still rebuilds everything, and records `renderedPath`. **`refresh()`** reloads the
sidecar and then, if the panel is already painted for this file, calls
**`reconcile(next)`** instead.

`reconcile` is driven by a pure diff, `diffThreads(prev, next)` in `src/pure.ts`
(unit-tested), which names exactly what moved: `added` ids, `removed` ids, and
`changed` ids each with the *fields* that differ — `messages`, `resolved`,
`anchor`, `rev`. The panel keeps a `Map<threadId, ThreadCard>` and acts only on
what the diff names:

| Diff says             | Panel does                                                                    |
| --------------------- | ----------------------------------------------------------------------------- |
| `removed`             | `card.el.remove()`                                                            |
| `added`               | `buildCard()` and append                                                      |
| `changed: messages`   | repaint just `.review-md-messages` (an open edit box is carried across)       |
| `changed: resolved`   | flip the card class, the "resolved" pill and the Resolve ⇄ Reopen label       |
| `changed: anchor/rev` | rebuild that one card in place (`replaceWith`) — the preview/version row depend on these |
| nothing               | nothing — the second refresh of every write is a true no-op                   |

Then `applyOrder()` moves cards into display order with the fewest DOM moves (a
card already at its slot is not touched), and the async passes that own other
regions re-run: `refreshRevisions` (the header dropdown), `computeStaleness` →
`fillVersionRows` (the version rows), `applyFilter` (chips + visibility).

Two supporting changes make the in-place updates safe:

- **Handlers read the live record.** Every closure in a card (locate, share, post,
  resolve/reopen, delete, per-message edit/delete) reads `card.thread` at click
  time rather than a `thread` captured when the card was built. Before this, a
  card kept after a write would have toggled `!thread.resolved` on a stale object
  and flipped the wrong way.
- **The diff is taken against the DOM's own records**, `[...cards.values()].map(c
  => c.thread)`, not a remembered array. Two refreshes overlap after every write;
  whichever lands second sees an empty diff instead of re-adding a card.

`fillVersionRows` now stamps each row with what it was built from
(`rev key | outdated`) and skips rows whose inputs didn't move — that is what keeps
an open version preview open across a write elsewhere.

The draft composer got its own slot (`.review-md-draft-slot`) so it can be painted
and cleared without touching the cards; the "no threads yet" note is toggled with
`hidden` rather than rebuilt. `focusThread` is unchanged in behaviour (refresh →
select → scroll → flash → focus the reply box); it just no longer costs a rebuild.

## Invariants preserved (verified live in the harness)

In one `eval` against the `docs` vault: type into `d1a2b3`'s reply box, arm
`a7b8c9`'s delete, open `a7b8c9`'s version preview, scroll the panel, then write a
reply to `qklp1y` through `plugin.appendReply` (the same sidecar write +
`notifyReviewChanged` → `refresh` as the x-callback link). After the write:

```
taValue "draft in progress"  caret 5  active true  scrollTop 40  armed true
sameCardEl true  previewOpen true (v4 (b1237be) content loaded)
focused d1a2b3  qklp1y messages 3 → 4, last body "surgical test 2"
```

Reopen → resolve on `e4f5a6` flipped the label/pill/class on the **same element**
and moved it between the open and resolved groups, chip counts following.

Two things the first live pass appeared to lose turned out to be the harness, not
the panel: the x-callback `reply` handler itself calls `leaf.openFile` +
`openLinkText`, which hands focus to the editor pane; and an armed delete disarms
itself after 3 s, which elapsed between two separate CLI calls. Re-running the
check inside one `eval` (above) showed both preserved.

## Still a rebuild, on purpose

- First paint and a file switch (`render()`): nothing to preserve.
- A card whose `anchor` or `rev` changed (the post-commit re-anchor hook): its
  preview and version row are built from those, so the card is rebuilt — but only
  that card.
- A message list whose content changed repaints its whole `.review-md-messages`;
  an open edit box is re-opened with its typed text when its message is still
  there unchanged.

# Live Preview mermaid overlay: post-processors don't fire in CM6

## Problem

`#24` (Live Preview click-to-comment, **full parity**) needs the mermaid comment
overlay — the injected `rvw_<id>` comment nodes and the midpoint 💬 edge badges —
to render in **Live Preview**, not only in reading view. In reading view the
overlay is applied by a `registerMarkdownPostProcessor` callback
(`augmentRenderedMermaid`, see [`mermaid-augment-mechanism.md`](mermaid-augment-mechanism.md)).

The obvious move — "the post-processor already augments mermaid, it'll cover Live
Preview too" — is wrong.

## What the evidence showed

A probe stamped every post-processed element with a `data-review-md-line-start`
attribute and counted them in a Live Preview editor:

```
=> {"lineStamped":0,"mermStamped":0,"embedHasStamp":false}
```

Zero. **`registerMarkdownPostProcessor` callbacks never run for the CM6 editor
surface** (Live Preview / source mode). They fire only for reading view and for
fully-rendered embeds. So the entire post-processor-driven overlay path is dead in
Live Preview — nothing was ever going to call `augmentRenderedMermaid` there.

A second probe checked whether an `innerHTML` swap into a CM6-rendered mermaid
widget even survives a measure cycle (CM6 owns that DOM and could revert it):

```
=> {"rvwAfterSwap":2,"rvwAfterScroll":2}
```

It survives — CM6 does not immediately rebuild the widget after a scroll, so an
overlay swapped in stays put until CM6 has a real reason to rebuild.

## What replaced it

Live Preview gets its own entry point: a **debounced `MutationObserver` on each
source-mode editor's `.cm-content`** (`ensureLivePreviewAugmenter` →
`scanLivePreviewMermaid` in `src/main.ts`). When CM6 renders a
`.cm-embed-block.cm-lang-mermaid` widget the observer fires; we map the widget back
to its source with `cm.posAtDOM(widget)` → line → the fence body read straight from
the live editor buffer (`livePreviewMermaidSource`), then hand it to the *same*
`augmentRenderedMermaid` used by reading view. The DOM shape of the mermaid SVG is
identical in both surfaces (`g.node[id^="flowchart-"]`, edge `path#L_from_to_n`), so
the augmenter needs no changes — only a different trigger.

Key design points that make this safe:

- **Self-healing on rebuild.** When CM6 rebuilds a widget it strips our overlay;
  the observer fires again and we re-augment. No lifecycle hook needed.
- **No re-entry loop.** The augment mutates the DOM, which would re-trigger the
  observer. `scanLivePreviewMermaid` skips a widget that's already fully overlaid
  (our `.review-md-mermaid svg` present for node comments, a
  `.review-md-edge-badge[data-thread=…]` per applicable edge thread), and a
  `lpAugmenting` WeakSet guards a widget mid-render so the async augment can't
  re-enter itself.
- **Buffer, not vault.** Source is read from the live `Editor` buffer, so unsaved
  edits are reflected; `posAtDOM` handles the widget→offset mapping that
  `getSectionInfo` (post-processor-only) would otherwise provide.
- **Toggle parity.** `toggleMermaidComments` now branches on `view.getMode()`:
  reading views `previewMode.rerender(true)` as before; source views get
  `scanLivePreviewMermaid` (on) or `stripLivePreviewMermaid` (off), the latter
  re-rendering the original source over any widget we'd replaced.

## Verification

Sandbox (`.dev-vault`, `design.md`, two diagrams with node + edge threads):

- Live Preview, overlay on: `rvwNodes:3, reviewMdHosts:2, edgeBadges:1`.
- Toggle off: `0, 0` (reverts to native). Toggle on: `3, 1` (re-augments).
- Reading view unchanged: `rvwNodes:3, edgeBadges:1` (no regression).

## Don't

- Don't try to route Live Preview through `registerMarkdownPostProcessor` or a
  code-block processor — proven not to fire (above, and
  [`mermaid-augment-mechanism.md`](mermaid-augment-mechanism.md)).
- Don't add a per-widget "done" dataset flag: CM6 may reuse the widget element
  while replacing its inner SVG, so the flag would outlive the overlay it claims is
  present. Detect the overlay from the actual DOM instead (as `scanLivePreviewMermaid`
  does).

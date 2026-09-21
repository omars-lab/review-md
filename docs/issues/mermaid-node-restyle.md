# Mermaid node comments: restyle the node, don't inject one

## The change

**User request (2026-09-20):** "instead of adding nodes to diagram, can we use
style to change the color of the node / special comment color? and change back
when thread resolved?"

Originally (`#37` / POC-6) a `mermaidNode` comment was shown by **injecting a new
node** into the diagram — `<commented node> -.💬.-> rvw_<id>(["<comment> 💬 N"])`
via `buildAugmentedSource`, which required re-rendering the whole diagram with
`window.mermaid.render` and swapping the SVG. That disrupted the layout (an extra
stadium node + dashed connector per thread) and, in Live Preview, meant swapping
CM6's own widget contents.

## What replaced it

The live overlay now **decorates the native SVG in place, non-destructively**:

- **Node recolour** — the commented node's built-in shape gets a CSS class
  (`review-md-commented`) that recolours it to the comment amber
  (`#fff3bf`/`#f0c000`) while the thread is **open**. On **resolve** the class is
  dropped and the colour reverts to native — exactly "change back when resolved".
- **Count badge** — a small `💬 N` badge (`✓` when resolved) is dropped on the
  node's top-right corner so the thread stays discoverable (colour alone is
  ambiguous). This unifies node treatment with the edge treatment, which already
  used a midpoint badge (`overlayEdgeBadges`); both share the badge CSS.

`styleCommentedNodes` finds the node by the same selector the highlight code uses
(`g.node[id*="-<node>-"]`), toggles the class, and appends the badge `<g>` into the
node's own `<g class="node">` so it shares the node's local coordinates
(`getBBox()` → top-right corner).

## Why this is better

- **No re-render.** The live path no longer calls `mermaid.render`, doesn't depend
  on `window.mermaid` being present, and never rewrites the diagram source or swaps
  the SVG. Faster, no flicker, no layout disruption.
- **Live Preview got much simpler.** The CM6 augmenter no longer swaps widget
  innerHTML (which risked fighting CM6's widget lifecycle — see
  [`live-preview-mermaid-overlay.md`](live-preview-mermaid-overlay.md)); it just adds
  a class + badge to the native node. Reverting on toggle-off is likewise just
  removing the class + badge (no re-render) — `stripLivePreviewMermaid` went from an
  async re-render to a synchronous DOM cleanup.
- **"Already overlaid" detection unified.** Both node and edge overlays leave one
  badge per thread, so the LP idempotency/loop guard checks badge presence for both.

## `buildAugmentedSource` / Bake unchanged

The `rvw_` node injection still exists — but **only** in the explicit **Bake
comments into diagram(s)** command (`bakeMermaidComments`), which permanently writes
the comment nodes into the stored ```mermaid source. That's a separate, destructive,
opt-in feature; the *live overlay* no longer uses it.

## Verification

Rebuilt clean (`tsc` + esbuild). Live-verify in `.dev-vault/design.md`: open
`mermaidNode` threads show the node recoloured amber + a `💬 N` badge; resolving a
thread reverts the node to native colour and flips the badge to `✓`; toggling the
overlay off removes both; reading view and Live Preview behave identically.

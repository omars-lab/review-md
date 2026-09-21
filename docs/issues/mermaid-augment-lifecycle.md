# Mermaid overlay lifecycle — why a MutationObserver, not the post-processor

**Context:** the mermaid comment overlay (recoloured nodes + count/edge badges) was applied from a
`registerMarkdownPostProcessor`. In reading view it would appear once, then silently vanish — a
diagram scrolled out and back, a theme change, or any re-layout left the node unstyled while its
threads still showed in the comments panel. See `mermaid-augment-mechanism.md` for how the
post-processor was originally adopted (that doc's premise is corrected here).

## The wrong root cause (researched first, disproved)

`docs/research.md` (2026-09-21) diagnosed a *one-shot observer that disconnects after first apply*
and recommended `ctx.addChild(new MarkdownRenderChild(el))` with a persistent, idempotent observer
tied to the section lifecycle. That was implemented (a `MermaidAugmentChild` with a lifecycle
observer + a signature marker). Build passed; the empirical test still showed `badges=0` on
scroll-in. The research's own "verify empirically" caveat was the correct warning — the premise
(that the post-processor re-fires per render) was never checked.

## The real root cause (empirically confirmed)

**Obsidian reading view caches rendered sections and does NOT re-run the markdown post-processor
when it restores one.** A decisive test destroyed and rebuilt the reading view (source→preview
toggle), scrolled to the Architecture diagram, and recorded which hooks fired:

```
{ ppFirings: [], augEvents: [], badges: 0, marker: none }   // before the fix
```

`ppFirings: []` — the post-processor never fired for the restored section, so anything it (or a
child it created) would apply was never applied. The data path was never the problem:
`mermaidCommentsFor` / `mermaidEdgeCommentsFor` returned `matchedNodes:3, matchedEdges:1` for that
diagram throughout. **A markdown post-processor is the wrong hook for durable reading-view
augmentation** — it runs at a section's *first* render only, not on cache restore.

## The fix

Drive augmentation from a persistent **`MutationObserver` on the view's render container**,
independent of the post-processor — mirroring `ensureLivePreviewAugmenter`, which already observes
`.cm-content` for Live Preview. One unified entry point, `ensureMermaidAugmenter()`, dispatches by
mode (`getMode()`): `ensureLivePreviewAugmenter` (source) or `ensureReadingViewAugmenter` (preview).
Each attaches one debounced (120 ms) observer per view; whenever a mermaid `<svg>` (re)appears the
scan re-decorates it, and a restore that strips the overlay simply fires the observer again. The
observers are (re)attached on `active-leaf-change` / `file-open` / `onLayoutReady`.

The reading-view scan (`scanReadingViewMermaid`) is **source-free**: it can't cheaply get the fence
source (that was the post-processor's `getSectionInfo`), so it matches a thread to a diagram by
whether the anchored node/edge actually exists in that diagram's rendered SVG
(`g.node[id*="-<node>-"]`, `findEdgePath`), skips baked threads (`g.node[id*="rvw_<id>"]`), then
calls `styleCommentedNodes` / `overlayEdgeBadges` directly. Idempotency mirrors the LP scan:
`nodeDone`/`edgeDone` checks skip an already-overlaid diagram, and a per-host `rvAugmenting` WeakSet
guards against re-entry from our own badge mutations.

## Evidence it works

Same decisive test, after the fix — a full cache-bust with the post-processor never firing:

```
{ ppFirings: [], augEvents: [], badges: 2, marker: none }   // after
{ badges: 2, commented: 1, edgeBadges: 1 }                  // node recolour + edge badge, scroll-in only
```

Badges now appear purely from the container observer on scroll-in, with no post-processor firing and
no manual nudge. `docs/media/mermaid-badges.png` is captured from this real behavior via
`.claude/skills/demo-media/scroll-to-mermaid.js` (scroll + let the observer fire) — the old
`augment-mermaid.js` manual-augment nudge is no longer needed.

## Why the code looks the way it does

`src/main.ts` no longer augments mermaid from a post-processor. Don't reintroduce one for the
overlay — it was tested and does not re-fire on cache restore (this is the whole reason for the
pivot). The overlay is owned by the two per-view observers; the shared apply helpers
(`styleCommentedNodes`, `overlayEdgeBadges`, `augmentRenderedMermaid`) are unchanged.

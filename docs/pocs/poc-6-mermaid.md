# POC-6 — mermaid comment nodes (augmented render, requirement 9)

**Risk:** requirement 9 wants comments dropped on a mermaid node to appear as *connected
notes in the diagram itself* — "replaces original mermaid with mermaid + comments" — while the
stored ```mermaid source stays untouched (threads live in frontmatter; the augmented diagram is
produced only at render time, with an on-demand "bake" command as the destructive opt-in).

**PASS bar (from the plan):** clicking a diagram node starts a thread; the injected comment node
appears *connected* in the render and redraws on reload/resolve; stored ```mermaid source
unchanged. If mermaid re-render can't be driven, fall back to badge-pins-on-nodes.

**Verdict: PASS** ✅ (2026-09-19, live). No fallback to badge-pins needed. Proven data-driven from
frontmatter in a real Obsidian 1.13.7 reading view.

## Sub-spikes

| # | Question | Result |
|---|---|---|
| **6a** | Can we map a rendered SVG element back to its mermaid node id + label? | **PASS** — nodes render as `g.node[id^="flowchart-<NODEID>-<counter>"]`; label is the node's `textContent`. |
| **6b** | Is a mermaid render API reachable to re-render an augmented source? | **PASS** — `window.mermaid.render(id, source)` → `Promise<{svg, bindFunctions}>`, using Obsidian's own initialized mermaid (theme matches). |
| **6c** | Can we make the augmented diagram *stick* in Obsidian's render pipeline, driven by frontmatter? | **PASS** — via a **post-processor** (see below). |
| **6d** | Document findings + verdict. | this file. |

## The mechanism (6c) — what works, and what doesn't

Two approaches were tried against a live instance:

1. **`registerMarkdownCodeBlockProcessor("mermaid", …)` — REJECTED.** Obsidian renders mermaid
   through its **own markdown renderer**, not the public code-block registry, so registering a
   handler for `"mermaid"` does **not** override the built-in. Result: built-in SVG rendered, our
   handler never fired (no `.review-md-mermaid` host, no `<pre>` fallback). This is the crux
   architectural finding: **you cannot take over mermaid via the code-block API.**

2. **`registerMarkdownPostProcessor(…)` — WORKS.** For each rendered section we detect a mermaid
   block (via `ctx.getSectionInfo(el)` → the raw fence lines, so we read the *stored source
   verbatim*), read `mermaidNode` threads from the file's frontmatter, and:
   - build `original source + one dashed comment node per thread`
     (`C -. "💬" .-> rvw_<id>(["<first line><br/>💬 N msgs [✓]"])` + a `reviewCmt` classDef),
   - wait (via a `MutationObserver` on the block) for the built-in SVG to land, then **swap once**
     to our `window.mermaid.render` output of the augmented source,
   - wire each comment node's `g.node` click → open its thread (POC: a `Notice`).

   Because this runs **inside the post-processor**, it re-applies on **every** re-render (scroll,
   edit, reload) — unlike a one-shot DOM poke, which Obsidian's next render reverts (that was the
   dead end from the earlier eval-swap attempt; see the pivots note). Diagrams with **no** threads
   are left 100% native (we return early), so we only touch diagrams that have comments.

Code: `src/main.ts` → `registerMarkdownPostProcessor` + `mermaidSourceFor` / `mermaidCommentsFor` /
`buildAugmentedSource` / `augmentRenderedMermaid`.

## Live result (recorded 2026-09-19)

Target: `design.md` (a dogfood doc) with three `mermaidNode` threads in frontmatter:

```
augmentedDiagrams: 2        # arch + lifecycle (the two with threads); req-9 diagram stays native
commentNodes:      flowchart-rvw_d1a2b3-15,  # "frontmatter or a sidecar at scale?"  2 msgs   (on node CS)
                   flowchart-rvw_e4f5a6-17,  # "does augmenting revert on re-render?" 2 msgs ✓ (on node MA, resolved)
                   flowchart-rvw_a7b8c9-11   # "one block ref per thread…"            1 msg    (on node Store, lifecycle)
```

Screenshot (in-process `dev:screenshot`) shows the Architecture diagram with the original purple
nodes **plus** two yellow rounded comment nodes hanging off `Comment store` and `Mermaid augmenter`
via dashed 💬 edges; the resolved thread shows a ✓. The stored ```mermaid source in `design.md` is
unchanged — augmentation is render-time only.

## Anchor schema (mermaidNode)

```yaml
- id: d1a2b3
  anchor: { type: mermaidNode, blockId: arch, node: CS, quote: "Comment store (frontmatter)" }
  resolved: false
  messages: [ { author, ts, body }, … ]
```

`node` is the mermaid node id; `blockId` names the diagram (for disambiguation / the bake command);
`quote` is the node label as a fallback if the id ever drifts. POC matching is by node id appearing
in the diagram source; the real build keys on `blockId` once diagrams carry a stable id.

## Gotchas found

- **Background window freezes reading-view rendering.** A note opened while Obsidian is *not* the
  foreground macOS app never parses into sections (`renderer.sections.length === 0`, blank preview),
  so screenshots come back empty and DOM probes see nothing — even though the file and frontmatter
  are loaded. Fix: foreground the isolated instance
  (`osascript -e 'tell application "Obsidian" to activate'`) before rendering/screenshotting. Added
  to the test-harness memory.
- **`dev:screenshot` captures the visible leaf, not `workspace.activeLeaf`.** Opening a file into a
  background leaf and screenshotting shows the *other* (visible) tab. Open into the visible leaf
  (`revealLeaf` + `setActiveLeaf({focus:true})`) before capturing.
- Built-in mermaid can't be overridden via the code-block API (see mechanism §1).

## Still to build (not part of this spike)

- **"Bake comments into diagram" command** (P4): fold the injected nodes into the stored source on
  demand (destructive opt-in). The augmenter already emits the exact source it would bake.
- Real click → open the thread pane (POC currently fires a `Notice`).
- Stable per-diagram `blockId` so multiple diagrams with the same node id disambiguate.

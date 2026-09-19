# Mermaid augmented render — how we landed on a post-processor

**Context:** requirement 9 needs comments on a mermaid node to show as *connected* nodes in the
rendered diagram, without editing the stored ```mermaid source (threads live in frontmatter).

## What was tried

1. **One-shot DOM swap via `eval` (dead end).** Render an augmented source with
   `window.mermaid.render` and set `document.querySelector('.mermaid').innerHTML = svg`. The DOM
   *did* update (6 nodes confirmed), but the next screenshot showed the **original** diagram: any
   Obsidian re-render of the section (scroll, focus, reload) discards a mutation made outside the
   render pipeline. A one-shot poke can never be the mechanism.

2. **`registerMarkdownCodeBlockProcessor("mermaid", …)` (rejected).** The natural "let me own
   mermaid blocks" API. It does **not** override the built-in: Obsidian renders mermaid through its
   own markdown renderer, not the public code-block registry. Result — built-in SVG rendered, our
   handler never fired (no host, no `<pre>` fallback). Confirmed live.

3. **`registerMarkdownPostProcessor` (adopted).** Runs as part of *every* render of a section, so
   augmentation re-applies on scroll/edit/reload — fixing (1)'s revert problem structurally. We read
   the fence source via `ctx.getSectionInfo` (the stored source verbatim), read `mermaidNode`
   threads from frontmatter, wait (MutationObserver) for the built-in SVG, then swap once to
   `window.mermaid.render(source + injected comment nodes)`, and wire node clicks → thread. Diagrams
   without threads are left native.

## Evidence it works

`design.md` with 3 `mermaidNode` threads → 2 diagrams augmented, comment nodes connected by dashed
💬 edges, resolved thread shows ✓, source unchanged. See `docs/pocs/poc-6-mermaid.md` for the live
numbers and screenshot description.

## Why the code looks the way it does

`src/main.ts` uses a post-processor + `MutationObserver` (not a code-block processor, not a direct
DOM swap) *because* of the three findings above. Don't "simplify" it back to a code-block processor
— that path was tested and doesn't fire.

## Test-harness gotcha uncovered here

Reading-view rendering is **suspended while the Obsidian window is backgrounded**
(`renderer.sections.length === 0`, blank preview, empty screenshots). Foreground the isolated
instance (`osascript -e 'tell application "Obsidian" to activate'`) before rendering/screenshotting.

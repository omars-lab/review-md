# Research: Mermaid augmentation lost on reading-view re-render / scroll

> **Superseded (2026-09-21) — read [`issues/mermaid-augment-lifecycle.md`](issues/mermaid-augment-lifecycle.md) first.**
> This document's recommended fix (`ctx.addChild(new MarkdownRenderChild(el))` + a persistent
> lifecycle observer) was implemented and **failed empirically**: its premise — that the reading-view
> post-processor re-fires on scroll-in — is false. Obsidian restores cached sections without re-running
> the post-processor, so no post-processor-anchored hook re-applies. The shipped fix is a per-view
> `MutationObserver` on the render container. The section survey below is still useful background; the
> "Recommended fix" is not.

*Observed 2026-09-21. Primary sources: Obsidian Developer Docs, Obsidian forum. Where a
claim could not be verified against a primary source it is marked **(inferred)**.*

## The problem

review-md augments rendered Mermaid diagrams in **Reading view** with a markdown
post-processor:

```ts
this.registerMarkdownPostProcessor((el, ctx) =>
  void this.augmentRenderedMermaid(el, src, ctx.sourcePath));
```

`augmentRenderedMermaid` sets up a **one-shot `MutationObserver`** on `el`, waits for
the `<svg>` to appear, injects comment badges / recolours nodes, then **disconnects the
observer after applying once**.

Symptom: when a diagram scrolls into view (reading view renders sections lazily) or the
section re-renders, the badges are **not reliably re-applied** — they are absent until
the augment is re-driven manually. The comment-lookup data path is correct; this is a
render **timing / lifecycle** problem.

## Findings

### 1. How reading view renders, and when post-processors (don't) re-run

- Post-processors run **after Markdown is processed into HTML**, and operate on the
  rendered element; the framework "scans the processed HTML and transforms matching
  elements." ([Markdown post processing — Developer Docs](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing))
- A widely-repeated community characterisation: a post-processor "works **once** when
  the markdown note is rendered to HTML for the first time" — i.e. it fires per
  *render* of a block, not continuously. ([Markdown post processing — marcusolsson plugin docs](https://marcusolsson.github.io/obsidian-plugin-docs/editor/markdown-post-processing))
- Reading view is **not one static DOM**: rendered blocks are `MarkdownRenderChild`
  components that are **loaded and unloaded** as the view changes, which is why plugins
  must register cleanup — see the thread where render children were "not being unloaded
  when switching notes." ([forum: render children not unloaded](https://forum.obsidian.md/t/solved-markdown-render-childes-are-not-being-unloaded-when-switching-notes-in-the-same-tab/49681))
- **(inferred / not found in a primary doc):** I could **not** find an official
  document that explicitly states reading view *unloads off-screen sections on scroll
  and re-runs the post-processor when they scroll back*. The official docs don't spell
  out the virtualization model, and one forum thread on forcing re-renders "does not
  address whether individual sections are recreated during scroll."
  ([forum: how to force rerender](https://forum.obsidian.md/t/how-to-force-rerender-of-reading-view/91882),
  [forum: reading view rendering pipeline](https://forum.obsidian.md/t/reading-view-rendering-pipeline/56156))
  What *is* established and sufficient for the fix: a block's post-processor runs at
  **that block's render time**, the rendered node is a lifecycle-managed child, and
  Mermaid's SVG is produced **asynchronously** after the processor returns — so any
  augmentation that assumes a single, stable, already-present SVG is fragile.

### 2. Idiomatic lifecycle: `ctx.addChild(new MarkdownRenderChild(el))`

The recommended pattern is to wrap post-processor DOM in a `MarkdownRenderChild` and
register it with `ctx.addChild(...)`, then do setup in `onload()` and teardown in
`onunload()`:

- `MarkdownRenderChild extends Component`; `onload()` is "where you'd set up event
  listeners, **observers**, or other resources tied to the rendered markdown section,"
  and `onunload()` tears them down. It inherits `register(cb)`, `registerEvent(...)`,
  `registerDomEvent(...)`, `registerInterval(...)` so "all observers, timers, and DOM
  handlers are properly managed within the section's render lifecycle."
  ([MarkdownRenderChild — Developer Docs](https://docs.obsidian.md/Reference/TypeScript+API/MarkdownRenderChild))
- "Register the rendered block via `ctx.addChild(new MarkdownRenderChild(el))` so it is
  **unloaded with the section**." Without it, "a keystroke in Live Preview re-runs the
  processor" and stale continuations "append into a **detached element**."
  ([search synthesis of MarkdownRenderChild usage](https://docs.obsidian.md/Reference/TypeScript+API/MarkdownRenderChild),
  [erik-naslund/obsidian-skiss review notes](https://github.com/erik-naslund/obsidian-skiss/issues/30))
- The [Dataview](https://github.com/blacksmithgu/obsidian-dataview) pattern (cited on the
  forum) is exactly this: a `MarkdownRenderChild` subclass that "hooks on obsidian events
  and then forces a rerender of that child component," giving seamless updates without a
  full-view rebuild. ([forum: how to force rerender](https://forum.obsidian.md/t/how-to-force-rerender-of-reading-view/91882))

### 3. Is "disconnect after first apply" an anti-pattern?

Yes, for this use. Two distinct failure modes:

1. **Async SVG:** Mermaid renders its `<svg>` asynchronously. A one-shot observer that
   fires on the first mutation and disconnects can win the race in one session and lose
   it in another (exactly the non-determinism observed). **(inferred)**
2. **Re-render wipes the injection:** if the block re-renders for *any* reason (theme
   change, Mermaid re-layout, section reflow, live-preview keystroke) the injected
   badges are discarded and the disconnected observer never re-applies them. **(inferred,
   consistent with the "runs once" behaviour above.)**

The durable pattern is a **persistent, idempotent** observer whose lifetime is tied to
the `MarkdownRenderChild` (so it is cleaned up on `onunload`), re-applying the
augmentation whenever the SVG (re)appears — not a fire-once-and-disconnect observer.

### 4. Mermaid-specific corroboration

- Obsidian's changelog records ongoing fixes in this exact area: "Code blocks now
  **re-render correctly when a plugin's post processor changes**," and "`getSectionInfo()`
  is now implemented for custom code blocks in Live Preview" — evidence that
  post-processor + code-block re-render timing has been a moving target.
  ([Obsidian changelog](https://obsidian.md/changelog/page/17/))
- Mermaid is rendered by Obsidian's **built-in** code-block handler, so a generic
  `registerMarkdownPostProcessor` sees the section element and must wait for the SVG the
  built-in handler produces; there is no synchronous guarantee the SVG exists when the
  processor runs. **(inferred from the code-block processor model in**
  [Markdown post processing — Developer Docs](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing)**)**
- I did **not** find a single canonical GitHub issue titled after this exact symptom in
  the time available; the conclusion rests on the lifecycle docs above plus the observed
  behaviour, not on a matching bug report. Stated plainly so it can be re-checked.

## Recommended fix for review-md

Tie the augmentation to the block's render lifecycle with a `MarkdownRenderChild`, and
use a **persistent, idempotent** observer instead of a one-shot one. Re-applying must be
safe to run many times (the current badge code already rebuilds badges per apply, so it
is close to idempotent).

```ts
class MermaidAugment extends MarkdownRenderChild {
  constructor(
    containerEl: HTMLElement,
    private readonly apply: (host: HTMLElement) => void,
  ) { super(containerEl); }

  onload(): void {
    const run = () => {
      const host = this.containerEl.querySelector<HTMLElement>(".mermaid") ?? this.containerEl;
      if (host.querySelector("svg")) this.apply(host);   // idempotent re-apply
    };
    // Keep observing: re-apply on the async first render AND on any later re-render
    // (theme change, mermaid re-layout). No disconnect-after-first.
    const obs = new MutationObserver(run);
    obs.observe(this.containerEl, { childList: true, subtree: true });
    this.register(() => obs.disconnect());              // cleaned up on unload
    run();                                               // in case the SVG is already there
  }
}

// in the post-processor:
this.registerMarkdownPostProcessor((el, ctx) => {
  const mermaidBlocks = el.querySelectorAll<HTMLElement>(".mermaid, pre.mermaid, code.language-mermaid");
  if (!mermaidBlocks.length) return;
  const src = /* existing source extraction */;
  ctx.addChild(new MermaidAugment(el, (host) =>
    void this.augmentRenderedMermaid(host, src, ctx.sourcePath)));
});
```

Key changes vs. today:

1. **`ctx.addChild(...)`** ties the observer's lifetime to the section — no leaks, and it
   is re-created cleanly when the section re-renders.
2. **Persistent observer** (no `disconnect()` after first apply) so a Mermaid re-layout
   or theme change re-applies the badges instead of losing them.
3. **Idempotent `apply`** — safe to call on every mutation; guard with the existing
   "rebuild the badge each apply" logic and a cheap "already-applied and unchanged" early
   return if churn shows up in profiling.

Trade-offs / caveats:

- A live observer fires on every DOM mutation inside the block; keep `apply` cheap and
  bail fast when there is no `<svg>` or nothing changed. Debounce with
  `requestAnimationFrame` if profiling shows churn.
- `augmentRenderedMermaid` currently `await`s the comment lookup; prefer resolving the
  thread set **once** in the post-processor and passing it in, so the per-mutation
  `apply` stays synchronous and fast.
- **Verify empirically:** the section-unload-on-scroll model is inferred, not
  doc-confirmed. Before committing, instrument the post-processor (log block id +
  timestamp on each run) and scroll a long doc to confirm *when* it re-fires; that single
  test tells you whether `addChild` alone is enough or the persistent observer is doing
  the real work.

## Sources

- [Markdown post processing — Obsidian Developer Docs](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing)
- [MarkdownRenderChild — Obsidian Developer Docs](https://docs.obsidian.md/Reference/TypeScript+API/MarkdownRenderChild)
- [Component.load — Obsidian Developer Docs](https://docs.obsidian.md/Reference/TypeScript+API/Component/load)
- [MarkdownPreviewRenderer.registerPostProcessor — Developer Docs](https://docs.obsidian.md/Reference/TypeScript+API/MarkdownPreviewRenderer/registerPostProcessor)
- [Markdown post processing — marcusolsson plugin docs](https://marcusolsson.github.io/obsidian-plugin-docs/editor/markdown-post-processing)
- [forum: How to force rerender of reading view](https://forum.obsidian.md/t/how-to-force-rerender-of-reading-view/91882)
- [forum: Reading view rendering pipeline](https://forum.obsidian.md/t/reading-view-rendering-pipeline/56156)
- [forum: Markdown render children not being unloaded when switching notes](https://forum.obsidian.md/t/solved-markdown-render-childes-are-not-being-unloaded-when-switching-notes-in-the-same-tab/49681)
- [forum: renderMarkdown not executing post-passes of code blocks](https://forum.obsidian.md/t/rendermarkdown-not-executing-post-passes-of-code-blocks/47176)
- [erik-naslund/obsidian-skiss — deep review notes on postprocessor lifecycle](https://github.com/erik-naslund/obsidian-skiss/issues/30)
- [Obsidian changelog — code-block re-render + getSectionInfo fixes](https://obsidian.md/changelog/page/17/)

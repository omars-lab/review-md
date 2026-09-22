# Mermaid augmenter leaked closed MarkdownViews (audit #1)

## Symptom

Every markdown tab opened during a session was retained in memory after it was
closed — the `MarkdownView` and its whole DOM subtree — for the rest of the
plugin's lifetime. This is the audit's finding **#1 (MutationObserver +
MarkdownView leak on closed tabs)** and a blocker for community-plugin submission,
since lifecycle teardown is exactly what Obsidian's reviewers check.

## Root cause

`ensureLivePreviewAugmenter` / `ensureReadingViewAugmenter` create one
`MutationObserver` per view and stored the disconnect via **`this.register(() =>
obs.disconnect())`**. `Plugin.register` callbacks fire only on **plugin unload**, so:

- the registration list held `obs` for the whole plugin lifetime;
- `obs`'s callback is `scan = debounce(() => this.scan…(view))`, which closes over
  `view`;
- therefore every observer transitively pinned its (now closed) `MarkdownView`.

The `WeakMap<MarkdownView, MutationObserver>` couldn't collect anything, because the
plugin's registration array was a *strong* path to the same observers. Observers on
closed tabs also kept firing their debounced scans.

## Fix

Tie teardown to the **view**, not the plugin:

- `view.register(() => { obs.disconnect(); this.<map>.delete(view); })` — Obsidian's
  `Component.register` (a `MarkdownView` is a Component) fires when the leaf/view is
  detached, so the observer is disconnected and the map entry dropped exactly when
  the tab closes. No strong reference outlives the view.
- `onunload` disconnects observers for any views still open at unload by walking the
  **live** `getLeavesOfType("markdown")` — never a retained list — so it holds no
  closed views either.

## Verification (live, via scripts/capture-media.mjs eval)

Open a file → the view is present in the observer map (`has === true`); `leaf.detach()`
→ the entry is gone (`has === false`). Confirmed for both reading mode (`rvObservers`)
and Live Preview / source mode (`lpObservers`). Also confirmed `view.register` fires
on `detach` while `view._loaded` flips to false.

## Gotcha that bit during this fix

`view.register` verified as firing, yet the plugin map entry survived — because the
running bundle was **stale**: `npm run typecheck` passes without emitting, so the
symlinked `main.js` still held the old code until `npm run build`. Reload loads
`main.js`, not the `.ts`; always build before `capture-media reload` when verifying a
behaviour change.

# shot-list — review-md README / marketing captures

The rubric the `demo-media` skill reads at run time. One row per feature; work top
to bottom. Each shot names its output, a **manual** recipe (Obsidian command IDs +
`eval`), and, where the feature is about links, an **x-callback** recipe. Edit this
file (not `SKILL.md`) when the feature set changes.

Setup for every run:

```
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
node scripts/capture-media.mjs doctor && node scripts/capture-media.mjs reload
node scripts/capture-media.mjs open --file design.md            # dogfood doc with live threads
node scripts/capture-media.mjs cmd  --id review-md:open-comments-view
```

Reusable selectors:

| name | selector |
|---|---|
| whole window | *(omit `--selector`)* |
| comments panel | `.workspace-leaf-content[data-type="review-md-comments"]` |
| one card | `.review-md-thread[data-thread-id="<id>"]` |
| panel header + chips | `.review-md-header` |
| rendered doc | `.markdown-reading-view` |
| augmented diagram | `.mermaid:has(.review-md-node-badge)` |

Live threads in `.dev-vault/.design.comments.md`: `d1a2b3` (mermaidNode, committed
`on d3de8c5`), `c0ffee` (mermaidNode, **working copy**), `qklp1y` (mermaidEdge),
`a7b8c9` (text), `e4f5a6` (no rev). Use these ids below.

---

## Screenshots

### 1. hero — the reviewer (doc + comments side by side)
The headline image. Whole window so it reads as "a real workspace".
- **manual:** `cmd --id review-md:open-comments-view`, then
  `shot --out docs/media/hero.png --settle 500`
- Crop variant for a narrower README column: `--selector '.workspace-split.mod-root' --pad 0`.

### 2. comment thread card (badge · version stamp · excerpt · reply)
Shows the anatomy of a thread: type badge, `on <commit>`, anchored excerpt, messages, Post/Resolve/delete.
- **manual:** `shot --out docs/media/thread-card.png --selector '.review-md-thread[data-thread-id="d1a2b3"]' --pad 8 --settle 300`

### 3. triage header — filter chips
`N open · N hidden · N resolved` chips that narrow the list.
- **manual:** `shot --out docs/media/filter-chips.png --selector '.review-md-header' --pad 8`

### 4. mermaid comment badges (augmented diagram)
Recoloured nodes + count badges (`💬`/`N`/`✓`) and edge badges, injected without
touching the diagram source (requirement 9).
- **Gotcha (learned):** the reading view **lazy-renders**, so the mermaid
  post-processor's auto-augment does not reliably fire when a diagram is scrolled
  into view under scripted stepping (separate `eval`/`cmd`/scroll calls each let the
  section re-render out from under the observer). Drive the augment **atomically** in
  one eval that scrolls, polls for the rendered host, then calls the plugin's own
  `augmentRenderedMermaid(host, source, path)`. The helper
  [`augment-mermaid.js`](augment-mermaid.js) does exactly this for the Architecture
  diagram — pass it a fresh `reload` first:
  ```
  node scripts/capture-media.mjs reload
  node scripts/capture-media.mjs eval --file .claude/skills/demo-media/augment-mermaid.js   # => badges=2 commented=1
  node scripts/capture-media.mjs shot --out docs/media/mermaid-badges.png \
       --selector '.mermaid:has(.review-md-node-badge)' --pad 20 --settle 300
  ```
  For a different diagram, copy the helper and swap the `src`/node-id it targets.

### 5. version stamp — committed vs working copy
Two cards: one `on <commit>`, one **working copy**. Capture the pair.
- **manual:** `shot --out docs/media/version-stamp.png --selector '.workspace-leaf-content[data-type="review-md-comments"]' --pad 6`
  (the panel already shows both `d1a2b3` = committed and `c0ffee` = working copy).

### 6. share / reply by link — the x-callback path
The deep-link workflow, driven by the real `obsidian://review-md-*` API.
- **x-callback:**
  ```
  open --file design.md --thread d1a2b3
  shot --out docs/media/deep-link-open.png --selector '.workspace-leaf-content[data-type="review-md-comments"]' --pad 6 --settle 700
  reply --file design.md --thread d1a2b3 --body "confirmed — shipping this" --author omar
  shot --out docs/media/deep-link-reply.png --selector '.review-md-thread[data-thread-id="d1a2b3"]' --pad 8 --settle 500
  ```
- **manual equivalent** (copies the same URL to the clipboard):
  `cmd --id review-md:copy-share-link` / `review-md:copy-reply-link`.

---

## GIFs

### 7. comment-mode toggle (short loop)
Click-to-comment surface appearing. Frames → gif.
- ```
  shot --out docs/media/frames/comment-mode/f-000.png --selector '.markdown-reading-view' --pad 0
  cmd  --id review-md:toggle-comment-mode
  shot --out docs/media/frames/comment-mode/f-001.png --selector '.markdown-reading-view' --pad 0 --settle 300
  cmd  --id review-md:toggle-comment-mode
  shot --out docs/media/frames/comment-mode/f-002.png --selector '.markdown-reading-view' --pad 0 --settle 300
  gif  --frames docs/media/frames/comment-mode --out docs/media/comment-mode.gif --fps 4 --width 900
  ```

### 8. deep-link → focus → reply (the x-callback story, animated)
Best single "what is this" GIF: a link opens the file, focuses the thread, a reply lands.
- ```
  shot  --out docs/media/frames/deeplink/f-000.png --selector '.workspace-leaf-content[data-type="review-md-comments"]'
  open  --file design.md --thread qklp1y
  shot  --out docs/media/frames/deeplink/f-001.png --selector '.workspace-leaf-content[data-type="review-md-comments"]' --settle 500
  reply --file design.md --thread qklp1y --body "edge re-anchors on re-layout" --author omar
  shot  --out docs/media/frames/deeplink/f-002.png --selector '.workspace-leaf-content[data-type="review-md-comments"]' --settle 500
  gif   --frames docs/media/frames/deeplink --out docs/media/deeplink.gif --fps 3 --width 700
  ```

> Commit only the final `.png`/`.gif` in `docs/media/`; `docs/media/frames/` is
> intermediate and gitignored.

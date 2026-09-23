# shot-list — review-md README / marketing captures

The rubric the `demo-media` skill reads at run time. One row per feature; work top
to bottom. Each shot names its output, a **manual** recipe (Obsidian command IDs +
`eval`), and, where the feature is about links, an **x-callback** recipe. Edit this
file (not `SKILL.md`) when the feature set changes.

Setup for every run:

```
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
node scripts/capture-media.mjs doctor && node scripts/capture-media.mjs reload
node scripts/capture-media.mjs open --file designs/design.md     # dogfood doc with live threads
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

Live threads in `docs/designs/.design.comments.md`: `d1a2b3` (mermaidNode `CS`, committed
v3 `28ae788`, outdated), `e4f5a6` (mermaidNode `MA`, committed v3 `28ae788`, resolved),
`a7b8c9` (mermaidNode `Store`, committed v4 `b1237be`), `qklp1y` (mermaidEdge `URL → PH`,
committed v5 `bd9dda7`). `design.md` has six commits of real history (v1 `42cdea2` … v6
`38238a7`), so the version stepper walks a genuine ladder. Use these ids below.

---

## Screenshots

### 1. hero — the reviewer (doc + comments side by side)
The headline image. Whole window so it reads as "a real workspace".
- **manual:** `cmd --id review-md:open-comments-view`, then
  `shot --out docs/media/hero.png --settle 500`
- Crop variant for a narrower README column: `--selector '.workspace-split.mod-root' --pad 0`.

### 2. comment thread card (badge · version stepper · excerpt · reply)
Shows the anatomy of a thread: type badge, the version stepper, anchored excerpt, messages, Post/Resolve/delete.
- **manual:** `shot --out docs/media/thread-card.png --selector '.review-md-thread[data-thread-id="d1a2b3"]' --pad 8 --settle 300`

### 3. triage header — filter chips
`N open · N hidden · N resolved` chips that narrow the list.
- **manual:** `shot --out docs/media/filter-chips.png --selector '.review-md-header' --pad 8`

### 4. mermaid comment badges (augmented diagram)
Recoloured nodes + count badges (`💬`/`N`/`✓`) and edge badges, injected without
touching the diagram source (requirement 9).
- **How it augments now:** the plugin drives the overlay from a MutationObserver on
  the reading view's render container, so a diagram auto-augments whenever its `<svg>`
  (re)appears — on first render *and* on scroll-in from cache (see
  `docs/issues/mermaid-augment-lifecycle.md`). The capture therefore just needs to
  scroll the diagram into view and let the observer fire; no manual augment call. The
  helper [`scroll-to-mermaid.js`](scroll-to-mermaid.js) scrolls the Architecture
  diagram in and polls for the auto-rendered badges:
  ```
  node scripts/capture-media.mjs reload
  node scripts/capture-media.mjs eval --file .claude/skills/demo-media/scroll-to-mermaid.js   # => badges=2 commented=1
  node scripts/capture-media.mjs shot --out docs/media/mermaid-badges.png \
       --selector '.mermaid:has(.review-md-node-badge)' --pad 20 --settle 300
  ```
  For a different diagram, copy the helper and swap the heading/node-id it scrolls to.
  (The old [`augment-mermaid.js`](augment-mermaid.js) nudge — a manual
  `augmentRenderedMermaid` call with a hardcoded source — is no longer needed to make
  badges appear; keep it only as a way to force a one-off augment for debugging.)

### 5. version stepper — browse the anchored element across git history
The rev line is an inline stepper: `‹ vN (sha) ›` (left chevron = newer, disabled on the
latest version; right = older, disabled on the oldest; label bold on the authored
version). Clicking the label previews the anchored element **as it was in that version**
— a rendered mini-diagram for a mermaid node/edge, else a text snippet. Best shot: step
one card to a version whose content *differs* from now, so the version preview and the
card's current preview visibly disagree — the drift the feature exists to surface.
- **manual:** open the panel, then set the state in `eval` — click the card's
  `.review-md-verstep-label` to open the preview, then click
  `.review-md-verstep-btn[aria-label="Older version"]` to step to a differing version;
  move the cursor off the button first (`cliclick m:600,950`) so no "Older version"
  tooltip lands in the shot, then:
  `shot --out docs/media/version-stepper.png --selector '.review-md-thread[data-thread-id="d1a2b3"]' --pad 8 --settle 400`
  (`d1a2b3`'s `CS` node reads "Comment store · frontmatter" at **v2 `8dfd923`** but
  "… .name.comments.md sidecar" now — a clean before/after in one card, and the thread
  below is literally that frontmatter-vs-sidecar decision.)

### 6. share / reply by link — the x-callback path
The deep-link workflow, driven by the real `obsidian://review-md-*` API.
- **x-callback:**
  ```
  open --file designs/design.md --thread d1a2b3
  shot --out docs/media/deep-link-open.png --selector '.workspace-leaf-content[data-type="review-md-comments"]' --pad 6 --settle 700
  reply --file designs/design.md --thread d1a2b3 --body "confirmed — shipping this" --author omar
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
Best single "what is this" GIF: a link opens the file, the panel jumps to the thread, a
reply lands. Panel selector below is `SEL='.workspace-leaf-content[data-type="review-md-comments"]'`.
- **Focus deterministically, don't race the deep link.** `open --thread <id>` *does* scroll
  the sidebar to the card, but `focusThread` runs `refresh()` first (resets scroll) and the
  smooth-scroll + 1600ms flash finish asynchronously — a `shot` right after often catches the
  panel still at the top. Drive the plugin's own `focusThread` from `eval` instead, then shoot
  while the flash is up (`--settle 250`):
  ```
  eval --code '(async()=>{const v=app.workspace.getLeavesOfType("review-md-comments")[0].view; await v.focusThread("qklp1y"); return "ok";})()'
  ```
- **The `reply` x-callback writes the *git-tracked* sidecar** `docs/designs/.design.comments.md`
  (the demo vault is the real `docs/`, not a throwaway). Capture the frame, then restore it:
  `git checkout -- docs/designs/.design.comments.md`.
- Frames — top of panel, then focused `qklp1y` + flash, then the reply landing (its toast
  "review-md: replied to qklp1y…" doubles as proof the x-callback fired), then a clean hold:
  ```
  open --file designs/design.md                       # panel at top
  cliclick m:600,950                                   # cursor off any button (no tooltip)
  shot --out docs/media/frames/deeplink/f-000.png --selector "$SEL" --pad 6 --settle 400
  shot --out docs/media/frames/deeplink/f-001.png --selector "$SEL" --pad 6 --settle 200
  eval --code '…focusThread("qklp1y")…'  ; cliclick m:600,950
  shot --out docs/media/frames/deeplink/f-002.png --selector "$SEL" --pad 6 --settle 250
  reply --file designs/design.md --thread qklp1y --body "great — no vault check on the reply hop then" --author omar
  eval --code '…focusThread("qklp1y")…'  ; cliclick m:600,950
  shot --out docs/media/frames/deeplink/f-003.png --selector "$SEL" --pad 6 --settle 300   # reply + toast
  eval --code '…focusThread("qklp1y")…'  ; cliclick m:600,950
  shot --out docs/media/frames/deeplink/f-004.png --selector "$SEL" --pad 6 --settle 1800  # clean hold
  gif  --frames docs/media/frames/deeplink --out docs/media/deeplink.gif --fps 2 --width 620
  git checkout -- docs/designs/.design.comments.md     # drop the demo reply
  ```

> Commit only the final `.png`/`.gif` in `docs/media/`; `docs/media/frames/` is
> intermediate and gitignored.

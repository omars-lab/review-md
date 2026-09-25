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

**Sticky-header nudge.** The panel header is `position: sticky`, so anything that scrolls
a card to the top of the panel (`scrollIntoView({block:"start"})`, `focusThread`) parks
its top edge *under* the header. Before shooting a card, push the scroll container so
the card clears the header:

```
eval --code '(()=>{const v=app.workspace.getLeavesOfType("review-md-comments")[0].view; const c=v.contentEl; const card=c.querySelector(".review-md-thread[data-thread-id=\"<id>\"]"); const h=c.querySelector(".review-md-header"); c.scrollTop+=card.getBoundingClientRect().top-h.getBoundingClientRect().bottom-12; return "ok";})()'
```

(`v.contentEl` — class `view-content review-md-comments` — is the scroll container; a
`.view-content` child is not, so setting `scrollTop` on it throws.) Items 2, 3c and §8
use this; it is written `NUDGE <id>` below.

Live threads in `docs/designs/.design.comments.md`: `d1a2b3` (mermaidNode `CS`, committed
v3 `50ba884`, outdated), `e4f5a6` (mermaidNode `MA`, committed v3 `50ba884`, resolved),
`a7b8c9` (mermaidNode `Store`, committed v4 `1551edf`), `qklp1y` (mermaidEdge `URL → PH`,
committed v5 `3f82635`). `design.md` has six commits of real history (v1 `b87b326` … v6
`3b03b61`), so the version stepper walks a genuine ladder. Use these ids below.

---

## Screenshots

### 1. hero — the reviewer (doc + comments side by side)
The headline image. Whole window so it reads as "a real workspace".
- **manual:** `cmd --id review-md:open-comments-view`, then
  `shot --out docs/media/hero.png --settle 500`
- Crop variant for a narrower README column: `--selector '.workspace-split.mod-root' --pad 0`.

### 2. comment thread card (badge · version stepper · excerpt · reply)
Shows the anatomy of a thread: type badge, the version stepper, anchored excerpt, messages, Post/Resolve/delete.
- **manual:** scroll the card into view, `NUDGE d1a2b3`, then
  `shot --out docs/media/thread-card.png --selector '.review-md-thread[data-thread-id="d1a2b3"]' --pad 8 --settle 300`

### 3. triage header — chips, search, sort
`N open · N hidden · N resolved` chips that narrow the list, plus the tools row: a
search box (id / anchor / author / body substring, Esc clears) and a sort menu
(Recency · Doc position · Author). Shoot it in its **default** state — empty search,
sort "Recency" — so the header reads as the resting UI; item 3b shows it in use.
- **manual:** reset first (`eval`: clear `.review-md-search` and call `setSort("recency")`
  on the view — see the reset snippet under 3b), then
  `shot --out docs/media/filter-chips.png --selector '.review-md-header' --pad 8 --settle 300`
  (filename kept — README references it).

### 3b. search + sort — the header in use
The panel narrowed by a search with a non-default sort, so both controls visibly do
something: search `claude` (matches the three threads claude replied on) with sort
**Doc position** (cards in the order their anchors appear in the doc).
- **manual:** set the state in `eval`, then shoot the whole panel:
  ```
  eval --code '(()=>{const v=app.workspace.getLeavesOfType("review-md-comments")[0].view; v.setSort("position"); const s=v.contentEl.querySelector(".review-md-search"); s.value="claude"; s.dispatchEvent(new Event("input")); return "ok";})()'
  shot --out docs/media/search-sort.png --selector '.workspace-leaf-content[data-type="review-md-comments"]' --pad 6 --settle 400
  ```
- **reset** (run before any later "default" shot):
  ```
  eval --code '(()=>{const v=app.workspace.getLeavesOfType("review-md-comments")[0].view; v.setSort("recency"); const s=v.contentEl.querySelector(".review-md-search"); s.value=""; s.dispatchEvent(new Event("input")); return "ok";})()'
  ```
  (`setSort` is private in TS but plain JS at run time — `eval` reaches it.)

### 3c. thread fold
Long or resolved threads start folded to their last message with a **Show N earlier**
toggle; `d1a2b3` (2 messages, unresolved) is unfolded by default, so fold it by hand.
- **manual:** `eval`: click its `.review-md-fold` button
  (`v.contentEl.querySelector('.review-md-thread[data-thread-id="d1a2b3"] .review-md-fold').click()`),
  `NUDGE d1a2b3`, then
  `shot --out docs/media/thread-fold.png --selector '.review-md-thread[data-thread-id="d1a2b3"]' --pad 8 --settle 300`
  and unfold it again afterwards (item 2 wants the full anatomy).

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
  (`d1a2b3`'s `CS` node reads "Comment store · frontmatter" at **v2 `ec14c64`** but
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

### 7. comment mode → click → draft composer → thread (the create story)
Turn on comment mode (status bar shows "✍️ review-md: comment mode"), click a rendered
element, a **draft composer** card appears at the top of the panel with the anchor
preview, type, hit Comment — the thread is written only then. Whole-window frames, because
the story spans both panes: the click lands in the doc on the left, the composer appears on
the right, and the status-bar indicator sits at the bottom.
- The plugin's comment-mode handler is a document-level capture-phase `click` listener
  (`handleCommentClick` in `src/main.ts`), so a synthetic bubbling `MouseEvent` on any
  rendered element in `.markdown-reading-view` drives it. Clicking the **Architecture**
  heading resolves to a **`text` anchor** (`{"type":"text","quote":"Architecture","line":77}`),
  not `header` — the composer preview still reads as one clean line.
- **The Comment click writes two tracked files.** The sidecar gets the thread, and a
  `text` anchor also writes a block-id into the doc itself (`## Architecture ^<id>`),
  which re-renders the reading view and resets its scroll to the top. Restore **both**
  afterwards and turn comment mode off:
  `git checkout -- docs/designs/.design.comments.md docs/designs/design.md`.
- **Reading view renders lazily**, so the `h2` is not in the DOM until its section has
  scrolled in. Find the markdown view and scroll it first (`require("obsidian")` is not
  available inside `eval`, so locate the view by leaf type):
  ```
  eval --code '(()=>{const mv=app.workspace.getLeavesOfType("markdown").map(l=>l.view).find(v=>v.file&&v.file.path==="designs/design.md"); mv.previewMode.applyScroll(76); return "ok";})()'
  ```
  `mv.previewMode.rerender(true)` forces a repaint if the section still looks stale.
- **Whole-window frames want a wide pane.** Collapse the left sidebar
  (`eval --code 'app.workspace.leftSplit.collapse()'`) so the Architecture diagram fits;
  its svg has `max-width:none` and overflows a ~300px pane (a residual clip of one label is
  acceptable). The harness vault may also show a one-time **"Display Mermaid diagrams in
  this vault? Allow"** prompt in the reading view — click Allow (via `eval` on its button)
  before the first frame; it is harness-only state and never touches the repo.
  ```
  cliclick m:600,950
  shot --out docs/media/frames/comment-mode/f-000.png --settle 300                    # reading view at Architecture, mode off
  cmd  --id review-md:toggle-comment-mode
  shot --out docs/media/frames/comment-mode/f-001.png --settle 300                    # status bar: ✍️ comment mode
  eval --code '(()=>{const h=[...document.querySelectorAll(".markdown-reading-view h2")].find(e=>e.textContent.trim()==="Architecture"); h.scrollIntoView({block:"center"}); h.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true})); return "ok";})()'
  shot --out docs/media/frames/comment-mode/f-002.png --settle 500                    # draft card + anchor preview + toast
  eval --code '(()=>{const t=document.querySelector(".review-md-draft .review-md-reply-input"); t.value="looks good — ship it"; t.dispatchEvent(new Event("input")); return "ok";})()'
  shot --out docs/media/frames/comment-mode/f-003.png --settle 200                    # typed
  eval --code '(()=>{document.querySelector(".review-md-draft .review-md-actions .mod-cta").click(); return "ok";})()'
  # the doc rewrite scrolled the reading view to the top — re-run the applyScroll(76) eval, then:
  shot --out docs/media/frames/comment-mode/f-004.png --settle 400                    # new thread focused, "2 open"
  shot --out docs/media/frames/comment-mode/f-005.png --settle 1800                   # clean hold (a copy of f-004 is fine)
  gif  --frames docs/media/frames/comment-mode --out docs/media/comment-mode.gif --fps 1 --width 900
  cmd  --id review-md:toggle-comment-mode                                             # mode off
  git checkout -- docs/designs/.design.comments.md docs/designs/design.md             # drop the demo thread + block-id
  ```
  The toast expires in a few seconds; if the f-004 re-shot misses it, the focused card
  and the "2 open" chip carry the story on their own.

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
  `focusThread` scrolls the card to the top of the panel, i.e. under the sticky header —
  follow every call with `NUDGE qklp1y` before shooting. Frames f-000/f-001 show the
  header with its tools row (search + sort) as of the panel UX pass.
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
  eval --code '…focusThread("qklp1y")…'  ; NUDGE qklp1y ; cliclick m:600,950
  shot --out docs/media/frames/deeplink/f-002.png --selector "$SEL" --pad 6 --settle 250
  reply --file designs/design.md --thread qklp1y --body "great — no vault check on the reply hop then" --author omar
  eval --code '…focusThread("qklp1y")…'  ; NUDGE qklp1y ; cliclick m:600,950
  shot --out docs/media/frames/deeplink/f-003.png --selector "$SEL" --pad 6 --settle 300   # reply + toast (qklp1y re-sorts to top under Recency)
  eval --code '…focusThread("qklp1y")…'  ; NUDGE qklp1y ; cliclick m:600,950
  shot --out docs/media/frames/deeplink/f-004.png --selector "$SEL" --pad 6 --settle 1800  # clean hold
  gif  --frames docs/media/frames/deeplink --out docs/media/deeplink.gif --fps 2 --width 620
  git checkout -- docs/designs/.design.comments.md     # drop the demo reply
  ```

> Commit only the final `.png`/`.gif` in `docs/media/`; `docs/media/frames/` is
> intermediate and gitignored.

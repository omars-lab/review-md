# Build plan — `review-md`: click-to-comment markdown review tool

**Status:** design/plan. Decision now committed to **build our own** (was Option C in the prior
evaluation). Open sub-decision: **host = Obsidian plugin *or* standalone app**, resolved by the
POCs below — not by argument. Nothing is built yet. This repo (`review-md`) *is* the tool.

> This file supersedes the earlier A–E evaluation brief. The old landscape research is kept in
> §"Prior research" so it isn't re-run. The new direction and feature set (Omar, 2026-09-19) are
> in §"What we're building".

---

## Premise (why this exists)

Review a **rendered** markdown doc — Mermaid + GFM footnotes actually drawn — and **drop feedback
anchored to the exact spot**, where each piece of feedback becomes a **chat thread** persisted in
the file itself, shareable and repliable by URL, so an agent (our `review-design` skill) can read
it back as review input. VS Code preview renders neither Mermaid nor footnotes, and no off-the-shelf
tool does "click anywhere on the render → per-file, git-tracked thread." So we build it.

## What we're building (the requirements — Omar, 2026-09-19)

1. **Open any markdown file into our reviewer via an `obsidian://` / x-callback URL** — a deep link
   that lands the reviewer on a specific file (and optionally a specific thread).
2. **Click any part of the rendered markdown → drop a comment** at that anchor.
3. **Each comment is its own chat thread** (an ordered list of messages / replies).
4. **Share a single thread** — copy a deep link that reopens the file focused on that one thread.
5. **Reply to a thread via an x-callback URL** — a link that opens the reviewer with that thread
   focused and a reply composed/appended (with `x-success`/`x-error` callback support).
6. **Comment on images** (a thread anchored to an image as a whole). **Coordinate/region pinning
   within an image is deferred** — not needed now; parked in `docs/backlog.md` (Omar, 2026-09-19:
   "we don't need coordinates for images … ready to trade that off if plugins can work").
7. **Comments live in a git-tracked sibling sidecar** `.<name>.comments.md` (for `design.md` →
   `.design.comments.md`) — written there on create/reply, and **loaded from there** on open.
   (Originally frontmatter-primary per POC-4; **pivoted to the sidecar** on 2026-09-19 so that
   commenting never creates a revision on the reviewed file — the reviewed file's git history stays
   content-only. The sidecar is checked in, not gitignored. Pivot recorded in
   `docs/issues/comment-sidecar.md`.)
8. Feedback is **git-friendly and agent-parseable** — a schema we own end-to-end (carried over
   from the original requirement 4, the load-bearing one).
9. **Comment on a Mermaid diagram node, and the comment renders as a connected node *inside* the
   diagram** (Omar, 2026-09-19). Chosen model: **augmented render, non-destructive.** Threads live in
   the sidecar (req 7 → now the sidecar); at render time the plugin re-runs Mermaid on `original
   source + injected comment nodes/edges` so the rendered diagram becomes "Mermaid + comments" while
   the stored ```mermaid block is untouched. Overlay is toggleable; resolving a thread removes its node; clicking
   a comment node opens the thread. A separate **"Bake comments into diagram"** command emits a merged
   `.md`/diagram copy for sharing outside Obsidian (the destructive form, on demand only). Rejected:
   baking into source by default (pollutes the authored diagram, fights req 7) and badge-pins-only
   (doesn't make the comment a graph node, which is the ask).
9b. **Comment on a Mermaid edge/arrow** (Omar, 2026-09-19). A new `mermaidEdge` anchor
    (`{blockId, from, to, index}`), detected from the rendered link path's id (`L_<from>_<to>_<n>` —
    the LS-/LE- classes older mermaid emitted are absent in Obsidian's build, so we key off the id).
    Chosen model (user-chosen via AskUserQuestion): a **💬 badge overlaid at the edge midpoint**
    (`getPointAtLength(len/2)`), appended into the edge path's own SVG group so it shares the diagram's
    coordinate space — non-destructive, no re-render (an edge can't be re-expressed as a mermaid node).
    Clicking the badge opens the thread; the sidebar card previews the arrow as `from -->|💬| to` with
    the real node shapes. Built + live-verified 2026-09-19 (task #37).
10. **Track comments per committed version of the file** (Omar, 2026-09-19). Each thread records the
    version it was authored against, so a thread can be flagged **outdated** when the reviewed content
    later changes, and the exact reviewed text retrieved. Chosen model (user-chosen via
    AskUserQuestion): **hybrid stamp** — a body hash (frontmatter stripped) as the staleness signal,
    plus git commit/blob for identity/retrieval when the file is git-tracked; and a **badge +
    retrieve action** UI ("outdated" badge with a *Show reviewed version* button) over silently
    re-anchoring. Full design + trade-offs: `docs/issues/version-stamping.md`.

## The host: Obsidian plugin preferred; standalone is the fallback

**Decided direction (Omar, 2026-09-19): build the Obsidian plugin, and accept its precision
trade-offs.** The research showed the split, and Omar chose the plugin side of it:

- **Obsidian plugin (preferred)** — native Mermaid/footnote rendering, native `obsidian://` URLs, a
  real vault workflow. Its cap is that reading-mode → source mapping is **section/block-granular,
  not character-precise** (`getSectionInfo` gives a block's line range, not the clicked span). Omar
  is **ready to trade that off**: a comment anchored to the containing block/section is good enough,
  and image comments attach to the whole image (no in-image coordinates). Less to build.
- **Standalone app (fallback only)** — we'd own the renderer (markdown-it + mermaid + footnote +
  a source-map plugin) to get character-precise anchors and coordinate overlays. Only worth it if
  the plugin **can't do the core loop at all** (POC-1/POC-4 fail), not merely if precision is
  coarse. Cost: we build/maintain the renderer and a separate URL scheme, outside the vault.

**Resolution rule:** POC-1 and POC-4 are the go/no-go for the plugin (protocol plumbing + frontmatter
storage). POC-2 is now a *tuning* spike, not a decision driver — we already accept section
granularity. Pivot to standalone **only if** POC-1 or POC-4 fail. The **data model, x-callback
scheme, and agent-facing schema are identical either way**, so the pivot (if ever) stays cheap.

---

## Architecture (host-independent)

### Data model — sidecar schema (requirement 7)

Storage: a `review:` block in the frontmatter of a git-tracked sibling sidecar `.<name>.comments.md`
(for `design.md` → `.design.comments.md`), read/written via `vault.adapter` + `parseYaml`/`stringifyYaml`
(dotfiles aren't indexed by Obsidian, so `processFrontMatter`/`metadataCache` can't touch them). A
generated markdown body below the frontmatter keeps the file legible on GitHub. Schema sketch (the
`review:` block, identical to the old frontmatter-primary shape):

```yaml
review:
  uid: ab12cd34            # rename-stable file id (Advanced URI pattern); links resolve by this
  threads:
    - id: k3x9qp           # 6-char id: Math.random().toString(36).substring(2,8)
      anchor:
        type: text         # text | image | section
        line: 42           # 0-based section lineStart (best-effort; recomputed, never trusted stale)
        blockId: k3x9qp    # persisted into source as `^k3x9qp` so native block-scroll also works
        quote: "radial band mapping"   # exact clicked run, for re-anchoring after edits
      resolved: false
      rev:                   # version stamp (req 10) — the version this thread was authored against
        bodyHash: ea936ad0  # sha256 of the doc BODY, frontmatter stripped → the staleness signal
        ts: 2026-09-20T03:08:23Z
        git:                 # present only when the file is git-tracked (identity/retrieval only)
          commit: 8dfd923    #   short HEAD at authoring time
          blob: 31f7fa6      #   committed blob HEAD:<relpath>
      messages:
        - { author: omar,   ts: 2026-09-19T10:00:00Z, body: "why radial here?" }
        - { author: claude, ts: 2026-09-19T10:05:00Z, body: "..." }
    - id: p7m2ab
      anchor:
        type: image
        src: "img/foo.png"   # whole-image anchor; in-image coordinates deferred (docs/backlog.md)
      resolved: false
      messages: [ ... ]
    - id: q9r4tz
      anchor:
        type: mermaidNode     # comment on a node inside a ```mermaid block (req 9)
        blockId: k3x9qp       # the mermaid code block's own ^blockId (which diagram)
        node: C               # mermaid node id (or a label-hash fallback if the node is unnamed)
        quote: "human comments"   # node label at comment time, for re-anchoring if ids change
      resolved: false
      messages: [ ... ]
```

- **Text anchor** = section line + `quote` + a persisted `^blockId`. Re-anchor by: try `blockId`,
  else fuzzy-match `quote` near `line`. Section granularity is the accepted floor.
- **Image anchor** = the image as a whole (its `src`); no coordinates for now. (Schema leaves room
  to add optional `nx,ny,w,h` later without a breaking change — see backlog.)
- **Mermaid-node anchor** (req 9) = which diagram (`blockId`) + which node (`node` id, `quote` =
  label fallback). At render time the plugin injects, per unresolved thread, a comment node + dashed
  edge (`C -.💬.-> <threadId>(["<first line> · N replies"]):::rvw`) and re-renders; clicking the
  injected node opens the thread. The stored ```mermaid source is never mutated (the "Bake" command
  is the only path that writes injected nodes into a diagram, into a separate copy).
- **Version stamp** (`rev`, req 10) = a per-thread record of the version reviewed. **`bodyHash`**
  (sha256 of the reviewed file's body with frontmatter stripped) is the **sole staleness signal**. It's
  git-free and frontmatter-agnostic; since the sidecar move (req 7) comments no longer touch the
  reviewed file at all, so its whole-file hash is stable too, but `bodyHash` stays the signal because
  it fires pre-commit and in non-git vaults. `git.commit`/`git.blob` (`HEAD:<relpath>`) are recorded
  only when the reviewed file is git-tracked, for **identity and retrieval** (`git show <commit>:<file>`),
  never for staleness. Optional and Node-optional: on mobile/restricted renderers `git` is omitted and
  `bodyHash` still computes via Web Crypto. Full trade-offs: `docs/issues/version-stamping.md`.
- **Agent contract:** `review-design` reads `review.threads[]` directly — stable keys, documented
  here. Unresolved threads with the anchor `quote` are its findings input.

### x-callback URL scheme (requirements 1, 4, 5) — **BUILT & PROVEN LIVE 2026-09-19**

**One Obsidian action per operation** — NOT one action with an `action=`/`op=` selector.
Obsidian *reserves* `action` (it overwrites it with the handler's own name) and `vault` (it
consumes it for routing and strips it before the handler runs), so a selector param can never
arrive. Each operation is registered as its own action via `registerObsidianProtocolHandler`.
Full pivot trail: `docs/issues/xcallback-reserved-params.md`.

| Purpose | URL |
|---|---|
| Open file (+ focus thread = share link, req 1/4) | `obsidian://review-md-open?vault=V&file=<path>&thread=<id>` |
| Reply to a thread (req 5) | `obsidian://review-md-reply?vault=V&file=<path>&thread=<id>&body=<text>&author=<name>&x-success=<url>&x-error=<url>` |

- **Single source of truth:** `src/protocol/xcallback.schema.json` defines the actions + params;
  the plugin registers one handler per `operations[].action` and validates incoming params against
  it. `vault` is marked `reserved` (required in the URL for routing, but Obsidian never delivers it,
  so the plugin must not validate its presence — this was a real bug, see the issue doc).
- **Generated API docs** (req: "swagger/openapi for folks"): `scripts/gen-xcallback-api.mjs` emits
  `docs/api/xcallback.openapi.json` (OpenAPI 3.1), `docs/api/index.html` (Swagger UI) and
  `docs/api/xcallback.md`. `make api-docs` writes them; `make api-check` + a `repo: local`
  pre-commit hook fail on drift, so the docs can never fall out of sync with the schema.
- Handler: resolve `file` in the active vault → open leaf → scroll block `^thread` into view.
  `reply` appends `{author, ts, body}` to the thread in frontmatter via `processFrontMatter`, then
  opens at the thread; on completion `window.open`s `x-success` (errors call `x-error`, else Notice).
- **Reserved param rule:** never name a caller-facing param `action` or `vault`.
- Both actions verified end-to-end via `open '<url>'` with raw-disk read-back (direct `eval` of the
  handler is NOT a sufficient test — it skips the URL router + validation where the bugs lived).

### UI

- **Reading-mode click layer** — `registerMarkdownPostProcessor` injects a click affordance per
  rendered section; a `MarkdownRenderChild` owns the listeners (auto-cleanup on re-render). Click →
  popover to start a thread → write frontmatter.
- **Image comments** — click a rendered image → start a thread anchored to that image (whole
  image, no coordinate pin). A small badge on the image indicates it has threads.
- **Comments sidebar** — an `ItemView` (right leaf) listing threads for the active file; click a
  thread → scroll+highlight its anchor; reply inline; resolve/unresolve. `activateView()` via
  `getRightLeaf` + `revealLeaf`.

---

## POCs / spikes — run these FIRST, document each (Omar's ask: "see if we need POCs, document findings")

Throwaway spikes to de-risk the load-bearing unknowns **before** committing to the host or the full
build. Each is a tiny plugin/app, gets a **pass/fail bar**, and writes findings to
`docs/pocs/<slug>.md` (what was tried, evidence, verdict — the durable trail, not just memory).
Checkpoint the repo (`git init`) before the first spike so throwaways are recoverable.

| # | Question (the risk) | Method | PASS bar |
|---|---|---|---|
| **POC-1** ⭐ | **Go/no-go: does the protocol plumbing work end to end?** | Register `obsidian://review-md`; build a link that opens a file and scrolls to a `^block`; handle `x-success`. | Clicking a generated link opens the right file, lands on the block, and calls back. |
| **POC-2** | Text anchoring in reading mode (tuning, not a driver — section granularity already accepted). | Click a rendered paragraph → `getSectionInfo` → mint+persist `^blockId` → reload; edit text above, re-anchor. | Thread re-finds its containing block after edits (fuzzy `quote` fallback). |
| **POC-3** | Can we start/render an image-anchored thread in reading mode? | Inspect the *real* image DOM (devtools) for `![alt]()` and `![[embed]]`; click → thread; show a has-threads badge. | Clicking either image form starts a thread and the badge redraws on reload. (No coordinates.) |
| **POC-4** ⭐ | **Go/no-go: does frontmatter storage scale (req 7)?** | `processFrontMatter` write ~50 threads w/ replies; reload; check YAML fidelity, Properties-UI, cache. | 50 threads round-trip without corrupting the doc or breaking the note; else adopt **sidecar/hybrid** (ids in frontmatter, bodies in `.review/`), documented. |
| **POC-5** | *(fallback — run only if POC-1 or POC-4 fail)* Standalone renderer viable? | markdown-it + mermaid + footnote + source-map plugin; click → source range; own URL scheme. | Core loop (click→thread→store→link) works outside Obsidian. → pivot host. |
| **POC-6** ⭐ | **PASS ✅ (2026-09-19, live).** Mermaid augmented render (req 9): intercept a rendered mermaid block, map node→SVG `<g class="node">`, swap in a re-rendered diagram with frontmatter-driven comment nodes. | **Post-processor** (NOT `registerMarkdownCodeBlockProcessor` — built-in mermaid can't be overridden that way): read fence source via `getSectionInfo`, read `mermaidNode` threads from frontmatter, wait for built-in SVG then swap in `window.mermaid.render(source + injected nodes)`; click node → thread. Re-applies on every render. `docs/pocs/poc-6-mermaid.md`. | **MET** — clicking a comment node fires its thread; injected nodes appear connected (dashed 💬 edges, ✓ when resolved) and redraw on reload; stored ```mermaid source unchanged. No fallback to badge-pins needed. |

**Gate:** POC-1 and POC-4 are go/no-go for the plugin. If both pass (expected), build the plugin;
record the confirmation in `docs/pocs/host-decision.md`. Only if one fails do we run POC-5 and
reconsider the standalone. POC-2/POC-3/POC-6 are feature spikes — they shape *how* text/image/mermaid
comments work, they don't gate the plugin decision. **POC-1, POC-4 and POC-6 all PASSED live
(2026-09-19).**

## Dev & test automation (verified 2026-09-19 — `docs/issues/obsidian-automation-gate.md`)

We can run the whole POC/dev loop from the shell in an **isolated sandbox** that never touches the
real Obsidian config. What's verified:

- **Isolated instance:** `/Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir=<scratch>`
  relocates all global state to `<scratch>`; the default `~/Library/Application Support/obsidian` is
  untouched.
- **Auto-open a vault:** pre-write `<scratch>/obsidian.json` =
  `{"vaults":{"<rand 16-hex>":{"path":"<abs>","ts":<ms>,"open":true}}}` **before launch**.
- **Install the plugin:** symlink build output into `<vault>/.obsidian/plugins/review-md/` and list
  it in `community-plugins.json` (`scripts/install-dev.mjs` does this).
- **Official CLI (Obsidian ≥1.12.7, we have 1.13.7):**
  `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli` gives `eval`, `plugin:enable`,
  `plugin:reload`, `dev:screenshot` (in-process capture — no Screen Recording perm), `devtools`.
  Enable it once at **Settings → General → Advanced → Command line interface**, then drive POCs with
  `obsidian eval code="…"` and capture with `obsidian dev:screenshot path=…`.
- **The one manual step:** click *Trust author…* (or *Browse in Restricted Mode* + let the CLI
  `app.plugins.enablePlugin('review-md')`). Do it **once**; trust persists in the `--user-data-dir`,
  so snapshot that dir and every later run is click-free. Alt for CI: Playwright on the unpacked
  `app.asar` clicks the button deterministically (`qawatake/obsidian-e2e-sample` pattern).

## Phased build (after the POC gate)

1. **P0 — foundations:** `git init` + checkpoint; `.gitignore` (ignore `.obsidian/workspace.json`,
   build output, `node_modules`; track the plugin + any feedback the schema puts in git); Node via
   `.nvmrc`; TS/esbuild scaffold (or the standalone scaffold if pivoted).
2. **P1 — data layer:** ✅ sidecar (`.<name>.comments.md`) read/write of the schema above via
   `vault.adapter` + `parseYaml`/`stringifyYaml` (pivoted from frontmatter-primary, 2026-09-19 — see
   `docs/issues/comment-sidecar.md`); file `uid`; thread id minting; legacy-frontmatter migration on
   first write; `review-design`-facing parse documented.
3. **P2 — text threads:** ✅ **built 2026-09-19** — the reviewer UI core:
   - **Comments sidebar** (`src/views/comments-view.ts`, `ItemView` `review-md-comments`): lists the
     active file's `review.threads`, open threads first then resolved; each card shows the anchor,
     messages, a reply box (Send), Copy link, and Resolve/Reopen. Ribbon + command open it. Reads/
     writes go through shared plugin helpers (`appendReply`, `setThreadResolved`, `threadsForFile`,
     `buildShareUrl`) so the sidebar and the x-callback `reply` action are **one code path**.
   - **Comment mode** (click-to-comment authoring, req 2). **Decision (2026-09-19, user-chosen):**
     a **comment-mode toggle** (ribbon + command) over a selection-popover or context-menu — matches
     the "click any rendered element" requirement and is uniform across text/image/mermaid. While
     armed: a **Figma-style speech-bubble cursor** (custom CSS `cursor` on the reading view) signals
     the doc is click-armed. **Selection-aware:** a click anchors to the highlighted text (stored as
     `quote`) when there's a selection, else to the clicked image (`{type:image,src}`) or mermaid
     node (`{type:mermaidNode,node}`), else the clicked block's text. New thread is created
     message-less; the sidebar focuses it so the first comment is typed there.
   - **Bidirectional link (user-requested):** clicking a thread's anchor line scrolls the reader to
     the anchored region and **flashes a highlight** (`.review-md-flash`) over it — text block via
     quote match, image via `src`, mermaid node via node id. Best-effort; no-op if not rendered.
   - **Comment-mode toggle hotkey fix (2026-09-19):** the bare `c` toggle was firing while the user
     typed in a reply box (Obsidian does *not* suppress single-key command hotkeys inside inputs, as
     an earlier code comment wrongly assumed). Fixed by dropping the forced command hotkey and using a
     guarded `document` keydown handler that ignores `c` when the target is an input/textarea/select/
     contenteditable/`.cm-editor` (`isTypingTarget`). Verified: `c` in a reply box types the letter;
     `c` on the body toggles the mode.
   - **Reviewer-card previews (2026-09-19)** — each thread card shows a small preview of what it
     anchors to, so the reviewer sees the target without leaving the sidebar:
     - *Mermaid-node threads* render a **mini Mermaid preview of just the commented node** (its own
       shape + label, re-rendered via `window.mermaid.render`), background themed to the card
       (`background: transparent` on the SVG so the card's `--background-primary` shows through, not
       Mermaid's hardcoded light fill).
     - *Text threads* render the anchored quote as a **small italic blockquote** with **middle
       elision** (`start … end`) so a long quote fits the card (`middleEllipsis`, 60/40 head/tail).
   - Verified end-to-end in the isolated harness: comment-mode click on a text selection created a
     thread persisted to frontmatter; `highlightAnchor` flashed the exact paragraph; sidebar reply
     round-tripped to disk.
   - **Durable block-ref anchoring** ✅ **built 2026-09-20** — text threads write a native `^blockId`
     onto the anchored source block (a line post-processor stamps each rendered section's source line
     range so a click can locate it), so the anchor + every `#^id` deep-link survive edits to the
     quoted text. blockId = thread id, or an existing id reused when a block already has one (threads
     on one block share it). Block-id markers are excluded from `bodyHash` (`stripBlockIds`), so
     anchoring never false-flags staleness; deleting/pruning a thread strips its `^id` only when no
     surviving thread uses it. Reconciled with the sidecar principle (scaffolding, not payload) in
     `docs/issues/durable-anchoring.md`. Live-verified: create → `^id` in source + parsed into
     `metadataCache.blocks`, staleness stays false, shared-id reuse, orphan cleanup.
   - **Still TODO:** works in **reading view** only (Live Preview/CodeMirror click-to-comment
     deferred, task #24). Pruning of abandoned message-less threads ✅ (task #26).
4. **P3 — URLs:** ✅ **built 2026-09-19** — `review-md-open` / `review-md-reply` actions +
   `x-success`/`x-error`, validated against `xcallback.schema.json`, with generated OpenAPI/Swagger
   docs + drift hook. ✅ **completed 2026-09-20** — three commands on the focused thread
   (Copy share link / Copy native link / Copy reply-link template) surfaced via the sidebar card's
   copy-menu and the command palette; `buildNativeLink` emits `[[file#^blockId]]` (leans on #25's
   durable block ids) so a shared link resolves even with the plugin disabled, and `buildReplyUrl`
   emits a `review-md-reply` URL with a `{{reply}}` body placeholder (body is schema-required).
5. **P4 — image + mermaid comments:** whole-image threads + has-threads badge per POC-3 (no
   coordinates); **Mermaid node comments per POC-6** (req 9) — click node → thread, augmented render
   injecting comment nodes from frontmatter. ✅ **"Bake comments into diagram" command built
   2026-09-19** — folds the injected comment nodes into the file's own ```mermaid fences in place
   (idempotent: skips already-baked threads; the live augmenter stands down on baked threads so
   there's no double injection). ✅ **overlay toggle built 2026-09-20** — a "Toggle mermaid comment
   overlay" command flips a persisted `showMermaidComments` setting; off, `augmentRenderedMermaid`
   stands down and re-rendering the open reading views hands the DOM back to Obsidian's native SVG
   (source + sidecar untouched; verified: 4 overlay nodes → 0 → 4, persisted to `data.json`).
   ✅ **injected comment nodes excluded from comment-mode anchoring 2026-09-19** — a click on a
   `rvw_<id>` node opens its existing thread instead of minting a comment-on-a-comment.
6. **P5 — agent loop:** wire `review-design` to read threads; round-trip smoke test; `review-setup`
   validation skill (PASS/FAIL checklist, scriptable vs GUI-only steps separated).
7. **P6 — version stamping (req 10):** ✅ **built 2026-09-19.** Every new thread is stamped with a
   `rev` (`buildRev`): `bodyHash` (frontmatter-stripped sha256, via Web Crypto) always, plus
   `git.commit`/`git.blob` when the file is git-tracked (`execFile` on `git`, 4s timeout, silently
   omitted off-git or on mobile). The sidebar compares each thread's `rev.bodyHash` to the current
   body hash and, on mismatch, shows an **"outdated" badge** + "commented on `<commit|hash>`" + a
   **Show reviewed version** button that recovers the reviewed text (`git show <commit>:<file>` →
   strip frontmatter → snippet around the anchor quote; falls back to the stored `quote` off-git).
   Verified empirically: adding/editing a comment does **not** flip staleness (frontmatter excluded),
   a body edit does, and reverting clears it. `docs/issues/version-stamping.md`.

## Key research findings (from the API research pass — trust, don't re-derive)

- **Protocol handler:** `registerObsidianProtocolHandler(action, handler)`; handler gets one
  `ObsidianProtocolData` object = `action` + each query param **as a decoded string** (no arrays/
  nesting — pack structured data into one encoded param). Auto-unregistered on unload.
  **Reserved params (learned the hard way, 2026-09-19):** Obsidian *overwrites* `action` with the
  handler's own name and *strips* `vault` (consumed for routing) before calling the handler — so
  neither can be used as a caller-facing param, and required-param validation must skip `vault`.
  See `docs/issues/xcallback-reserved-params.md`.
- **Native URI:** `obsidian://open?vault=&file=`; in-note target encoded into `file`
  (`%23Heading`, block `%23%5EblockId`). Advanced URI adds `x-success`/`x-error` by `window.open`ing
  the callback URL with result params, and resolves rename-stable links via a frontmatter `uid`.
- **Reading-mode anchoring:** `registerMarkdownPostProcessor`; `ctx.getSectionInfo(el)` →
  `{ text (WHOLE doc), lineStart, lineEnd }` (0-based) — **section granularity, can be `null`,
  never cache** (lines shift on edit). Character-precise sub-span anchoring is best-effort fuzzy
  matching. Prior art: **Annotation Sidebar** plugin (anchors after the rendered section).
- **Images:** `![alt]()` → `<img src="app://local/…">`; `![[x.png]]` →
  `<span class="internal-embed media-embed image-embed …"><img></span>` — **class names internal,
  confirm live via devtools**. No coordinate API; overlay + normalized coords is the approach.
  References: PDF Annotator (coord pins + sidecar), Excalidraw (coordinate-anchored objects).
- **Frontmatter:** `app.fileManager.processFrontMatter(file, fm => {…})` — mutate in place, atomic,
  supports nested arrays/objects. **Caveat:** large blobs bloat `metadataCache`, YAML round-trip is
  lossy (comments/order), Properties UI chokes on deep nesting → sidecar recommended for bulk;
  POC-4 tests whether frontmatter-primary (req 7) holds. Read via
  `metadataCache.getFileCache(file).frontmatter` (read-only snapshot).
- **Sidebar:** `ItemView` (`getViewType/getDisplayText/onOpen`) + `registerView`; activate via
  `getRightLeaf(false).setViewState(...)` then `revealLeaf`; never cache the leaf.
- **Thread/file ids:** thread id `Math.random().toString(36).substring(2,6chars)`; persist `^id`
  into source at the anchored block (mirrors Advanced URI `BlockUtils`); file `uid` in frontmatter.

## Prior research — the off-the-shelf landscape (do not re-run)

The exact combo "click anywhere on the *rendered* preview → per-file git sidecar" **does not exist
off the shelf**; every tool anchors to selected text, none inside a rendered diagram/image. Closest:
**Side Comments** (Obsidian, per-file JSON sidecar, undocumented schema, desktop-only, text-select
only); **Aside** (`vicky469/aside`, purpose-built for humans+agents, storage unverified);
Hypothesis (cloud); GitHub/GitLab PR review (source-line, cloud). This is why we build. Full table
and links were in the prior evaluation; the gap they leave is precisely requirements 2, 4, 5, 6.

## Constraints & gotchas (carry these)

- **This repo is not yet a git repo** — `git init` + first checkpoint before any spike (CLAUDE.md).
- **Node:** repo will get a `.nvmrc`; don't run bare `node` (v18) — `nvm use` first.
- **Look at the real render** before hardcoding DOM selectors for images/sections (CLAUDE.md rule;
  the research explicitly could not confirm current class strings live).
- **The trust gate is the one unscriptable step** (see `docs/issues/obsidian-automation-gate.md`):
  first-open of a plugin-bearing vault shows a *Trust author?* modal; no file bypasses it
  (`app.json` is `{}`, `community-plugins.json` only *lists* the plugin). Everything *around* it is
  scriptable — see "Dev & test automation" below.
- **Document pivots** in `docs/issues/<slug>.md`; POC findings in `docs/pocs/<slug>.md`; deferred
  scope in `docs/backlog.md` (image coordinates + char-precise anchoring already parked there).
- Keep the agent-facing schema stable and documented — it's the load-bearing contract.

## References

- Obsidian API: `registerObsidianProtocolHandler`, `getSectionInfo`, `processFrontMatter`, Views —
  https://docs.obsidian.md · type defs https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- Native URI: https://obsidian.md/help/Extending+Obsidian/Obsidian+URI
- Advanced URI (x-success, uid links, BlockUtils): https://github.com/Vinzent03/obsidian-advanced-uri
- Annotation Sidebar (reading-mode anchor pattern): https://www.obsidianstats.com/plugins/annotation-sidebar
- PDF Annotator (coord pins + sidecar): https://community.obsidian.md/plugins/local-pdf-annotator ·
  Excalidraw (coord-anchored objects): https://github.com/zsviczian/obsidian-excalidraw-plugin
- Our skills (external, 3d-models PR #278): `review-design`, `write-design`, `design-craft`.

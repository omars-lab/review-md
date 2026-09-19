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
7. **Comments live in the markdown file's frontmatter** — written there on create/reply, and
   **loaded from there** on open. (Storage trade-off flagged in POC-4; frontmatter is the default
   per this requirement, sidecar is the documented fallback if it doesn't scale.)
8. Feedback is **git-friendly and agent-parseable** — a schema we own end-to-end (carried over
   from the original requirement 4, the load-bearing one).

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

### Data model — frontmatter schema (requirement 7)

Default storage: a `review:` block in the file's YAML frontmatter, read/written atomically. Sketch:

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
      messages:
        - { author: omar,   ts: 2026-09-19T10:00:00Z, body: "why radial here?" }
        - { author: claude, ts: 2026-09-19T10:05:00Z, body: "..." }
    - id: p7m2ab
      anchor:
        type: image
        src: "img/foo.png"   # whole-image anchor; in-image coordinates deferred (docs/backlog.md)
      resolved: false
      messages: [ ... ]
```

- **Text anchor** = section line + `quote` + a persisted `^blockId`. Re-anchor by: try `blockId`,
  else fuzzy-match `quote` near `line`. Section granularity is the accepted floor.
- **Image anchor** = the image as a whole (its `src`); no coordinates for now. (Schema leaves room
  to add optional `nx,ny,w,h` later without a breaking change — see backlog.)
- **Agent contract:** `review-design` reads `review.threads[]` directly — stable keys, documented
  here. Unresolved threads with the anchor `quote` are its findings input.

### x-callback URL scheme (requirements 1, 4, 5)

One custom action, `review-md`, registered via `registerObsidianProtocolHandler("review-md", …)`
(or the app's own scheme in the standalone case). All params are strings.

| Purpose | URL |
|---|---|
| Open file | `obsidian://review-md?vault=V&uid=<fileUid>` (or `&file=<path>`) |
| Open + focus thread (share link, req 4) | `obsidian://review-md?uid=<fileUid>&thread=<id>` |
| Reply to a thread (req 5) | `obsidian://review-md?action=reply&uid=<fileUid>&thread=<id>&body=<text>&x-success=<url>&x-error=<url>` |

- Handler: resolve file by `uid` → open leaf → reveal comments view → scroll block `^thread` into
  view + highlight → focus the thread panel. `reply` also appends `body` (or opens the composer
  prefilled) and, on completion, `window.open`s `x-success` with result params (mirrors Advanced
  URI's `success()`); errors call `x-error`.
- **Native fallback** so links degrade without our logic: also emit
  `obsidian://open?file=<path>%23%5E<thread>` which at least scrolls to the anchored block.
- "Share thread" / "Copy reply link" are commands/buttons that build these URLs onto the clipboard.

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

**Gate:** POC-1 and POC-4 are go/no-go for the plugin. If both pass (expected), build the plugin;
record the confirmation in `docs/pocs/host-decision.md`. Only if one fails do we run POC-5 and
reconsider the standalone. POC-2/POC-3 tune the plugin, they don't gate it.

## Phased build (after the POC gate)

1. **P0 — foundations:** `git init` + checkpoint; `.gitignore` (ignore `.obsidian/workspace.json`,
   build output, `node_modules`; track the plugin + any feedback the schema puts in git); Node via
   `.nvmrc`; TS/esbuild scaffold (or the standalone scaffold if pivoted).
2. **P1 — data layer:** frontmatter (or sidecar) read/write of the schema above; file `uid`; thread
   id minting; `review-design`-facing parse documented.
3. **P2 — text threads:** reading-mode click → thread → sidebar list → reply → resolve; anchoring
   per POC-2 outcome.
4. **P3 — URLs:** `review-md` open/focus/reply actions + `x-success`/`x-error`; share-thread and
   copy-reply-link commands; native fallback links.
5. **P4 — image comments:** whole-image threads + has-threads badge per POC-3 (no coordinates).
6. **P5 — agent loop:** wire `review-design` to read threads; round-trip smoke test; `review-setup`
   validation skill (PASS/FAIL checklist, scriptable vs GUI-only steps separated).

## Key research findings (from the API research pass — trust, don't re-derive)

- **Protocol handler:** `registerObsidianProtocolHandler(action, handler)`; handler gets one
  `ObsidianProtocolData` object = `action` + each query param **as a decoded string** (no arrays/
  nesting — pack structured data into one encoded param). Auto-unregistered on unload.
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
- **Enabling a community plugin is GUI-only** (Restricted Mode off + trust); a setup skill guides
  it, can't script it. For dev, symlink/copy into `.obsidian/plugins/review-md/`.
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

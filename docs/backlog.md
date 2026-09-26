# Backlog — `review-md`

Deferred ideas and traded-off scope. Pulled into the plan when needed. One line per item; expand
into `docs/pocs/` or `docs/issues/` if/when picked up.

## Next

- **Beta via BRAT, before the official store release** — the store submission waits on
  a beta round. Merging to `main` is not a release: as of 2026-09-25 there are **no
  GitHub releases at all**, so the README's BRAT install path doesn't work yet.
  Steps: (1) `make version V=0.1.0` → `make release-check` → `make release` to cut the
  first GitHub release (manifest is still `0.0.1`); (2) install it through BRAT in a
  clean vault to prove the path end-to-end; (3) hand `omars-lab/review-md` to beta
  testers and collect issues; (4) fix, cut `0.1.x` betas as needed; (5) **only once
  there's been a good round of beta testers** do we look at the store submission below. Cutting a release is outward-facing — needs Omar's go on the
  version number. Requested 2026-09-25 ("beta testing before official release").
  **Progress 2026-09-25:** (1) done — `0.1.0` released. (2) done — BRAT installs 0.1.0 in
  a clean vault and `make setup-verify` passes (see
  [`docs/issues/setup-via-brat.md`](issues/setup-via-brat.md)). The repo being private
  was blocking (3): BRAT gets a 404 without access. **Cleared 2026-09-25:**
  `omars-lab/review-md` is now public (Omar's call, after a clean full-history gitleaks
  scan). The manifest and the 0.1.0 assets download without a login, so testers need no
  token. Next: (3) recruit testers.

- **Beta-tester polish from a first-run walkthrough (2026-09-26).** An agent installed the
  plugin in a fresh vault as a newcomer would and screenshotted each step. Shipped in
  `feat/beta-polish`:
  - Fixed: diagram comments now appear in Live Preview without re-focusing the doc.
  - Fixed: off git, cards no longer show a content hash that looks like a commit.
  - Chip "hidden" → "outdated".
  - The outdated badge now has a tooltip saying what it means.
  - Reviewer name defaults to git's `user.name`.
  - Version shown in Settings, plus Report an issue (button and command).
  - Comment mode has its own ribbon icon.
  - The empty sidebar now says how to start.
  - Copy menu and commands use plain words.
  - Only threads with 3+ messages fold.
  - The AI digest opens with a lead-in, and shows today's text for outdated threads.
  - README Quick start.

  Shipped in `feat/beta-polish-2` (2026-09-26):
  - Commented passages carry an amber margin bar and a comment button that opens the
    thread, in reading view and Live Preview.
  - A card's reply box stays hidden until the card is focused or has a draft.
  - Chips say "passage" / "heading" / "diagram box" / "arrow" (sidebar only; the CLI and
    search keep the type names).

  Still open:
  1. **The CLI's staleness is whole-doc** (agent item 2 below). Until it's fixed, the
     CLI digest can't show "now reads" the way the plugin's does.

- **More for agents: endpoints to wrap in the `reviews` CLI** — ranked by value for the
  effort (brainstormed 2026-09-25, after the export URL + CLI shipped; gaps 1–2 came out of
  the first dogfood run, [`.claude/skills/reviews/notes.md`](../.claude/skills/reviews/notes.md)).
  1. ~~**Resolve / reopen**~~ — **DONE 2026-09-26.** `obsidian://review-md-resolve?file&thread[&state=open]`,
     `reviews resolve <doc> <id> [--reopen]`, and `reviews reply … --resolve`.
  2. **Per-passage staleness in the CLI** — move the plugin's `isThreadOutdated` logic
     (hash just the anchored block / node / image when it can) into `src/pure.ts` and use it
     in `reviews`. Today every thread reads OUTDATED after any edit anywhere in the doc.
  3. ~~**`--since <time>`**~~ — **DONE 2026-09-26.** On list/find; takes an age (`2h`,
     `3d`) or a date.
  4. **`reviews diff <doc> <id>`** — the anchored passage as the reviewer saw it
     (`git show <rev.git.commit>:<path>`) next to today's, so an agent sees whether the
     point was already addressed. Small, read-only.
  5. **Start a thread** — `obsidian://review-md-comment?file&quote=<text>&body` +
     `reviews comment`, so an agent can review a doc, not just answer. Medium: the plugin
     must find the passage by quote and write the `^id` into the doc.
  6. **Get data back without the clipboard** — have `review-md-export` pass the digest to
     `x-success` (e.g. `…?digest=`) for callers that can't read the clipboard. Small, but
     URL length caps it; the CLI already covers reading from a clone.
  7. **MCP server over the CLI** — list/find/show/reply as MCP tools so any agent host
     gets them without shell access. Largest; worth it once 1–3 exist.

## Deferred

- **Publish review-md as an official Obsidian community plugin** — **gated on the
  BRAT beta above; do not submit before it.** Submit to the
  in-app plugin directory so users can search "Review MD" and click Install (the
  truly one-click path). Requires: a PR to `obsidianmd/obsidian-releases` adding the
  plugin to `community-plugins.json`, passing Obsidian's automated + human review
  (plugin guidelines: no `innerHTML`/`outerHTML` assignment, proper `onunload`
  teardown, `isDesktopOnly` honoured, no network calls without disclosure, etc.),
  and a tagged GitHub release (already automated via `make release`). **The
  hardening pass is done** — full record in
  [`docs/issues/community-plugin-hardening.md`](issues/community-plugin-hardening.md):
  the `MutationObserver`/`MarkdownView` leak (audit #1) is fixed, the two
  `innerHTML` SVG injects now go through a `DOMParser`-based `setSvg` helper, the
  sample-plugin `console.log`s and the two inline `.style.cursor` assignments are
  gone, and the POC-4 dev command + the POC-1/POC-4 vault-report writers were
  removed so no dev scaffolding ships. `isDesktopOnly: true` and command naming
  already correct. The last soft item — the badge palette's hard-coded amber
  hex — is now centralised into theme-aware CSS variables (sidebar chips follow
  light/dark; the diagram amber stays fixed-light because the mermaid canvas is
  light in both themes). No soft items remain. Code-ready to submit once the beta
  closes; until it lands, BRAT (`omars-lab/review-md`) is the install path. Requested
  2026-09-21. ROI: high value (widest reach, best UX), gated only on Obsidian's
  review turnaround (days–weeks).

- ~~**Make `docs/` the tracked Obsidian dev vault so Revisions v-numbers render**~~ —
  **DONE 2026-09-21.** `git mv design.md → docs/designs/design.md` (history preserved),
  `docs/` is now the dev vault (config + fixtures gitignored, docs + review sidecars
  tracked). Exposed and fixed a latent bug: `fileRevisionOrdinals` used `git log
  --follow --reverse`, which drops the rename trace and returns only the tip commit —
  `--follow` can't be combined with `--reverse`. Pivot record:
  [`docs/issues/docs-vault-and-follow-reverse.md`](issues/docs-vault-and-follow-reverse.md).

- ~~**Fix mermaid augment lost on reading-view re-render/scroll**~~ — **DONE 2026-09-21.** The
  researched fix (`ctx.addChild` + lifecycle observer) was disproved empirically: the real root
  cause is that Obsidian's reading view caches sections and does **not** re-run the markdown
  post-processor on restore, so no post-processor-based hook re-applies. Replaced with a per-view
  `MutationObserver` on the render container (unified with the Live-Preview augmenter via
  `ensureMermaidAugmenter`). Pivot record: [`docs/issues/mermaid-augment-lifecycle.md`](issues/mermaid-augment-lifecycle.md).

- ~~**Comment on a link (`link` anchor type)**~~ — **DONE 2026-09-21.** New `link` anchor
  type alongside `text`/`header`/`image`/`mermaidNode`/`mermaidEdge`, fields `href` (internal
  `[[wikilink]]` target read off `data-href`, or an external URL off `href`) + `quote` (display
  text). **Design deviation from the spec:** kept the existing **single-click** comment-mode
  path rather than adding a double-click gesture — `resolveClickAnchor` gains an `<a>` hit-test
  after `img` and before the text fallback, so clicking a link in comment mode anchors to the
  link and clicking prose still anchors to the block. Double-click would have been inconsistent
  with every other anchor type and more code for no gain. Wired at all eleven per-type sites
  (create, staleness `anchorContentFor`, `highlightAnchor` flash/scroll, sidecar body, card
  badge + inline preview, CLI `anchorWhere`, `validate-comments` `ANCHOR_REQUIRED: href+quote`).
  Verified live end-to-end in the harness (internal + external link → correct anchor; staleness
  present/removed; card badge + preview render; flash locates the `<a>`).

- **In-image coordinate/region pinning** — anchor a comment to a specific point or rectangle inside
  an image, not just the image as a whole. Traded off 2026-09-19 ("we don't need coordinates for
  images … ready to trade that off if plugins can work") to keep the Obsidian-plugin route, since
  Obsidian has no coordinate API (DOM-overlay hack, fragile internal classes). The frontmatter
  `image` anchor schema leaves room for optional `nx,ny,w,h` so this is additive, not a breaking
  change. Would likely require the standalone-renderer host (see plan §"The host").

- **Character-precise text anchoring** — anchor to the exact clicked span rather than the containing
  block/section. Traded off with the plugin route (reading-mode → source mapping is section-granular
  via `getSectionInfo`). Would require owning the renderer (markdown-it source-map). Revisit only if
  section granularity proves too coarse in real review use.

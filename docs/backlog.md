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

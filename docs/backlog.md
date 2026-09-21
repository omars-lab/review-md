# Backlog — `review-md`

Deferred ideas and traded-off scope. Pulled into the plan when needed. One line per item; expand
into `docs/pocs/` or `docs/issues/` if/when picked up.

## Deferred

- **Publish review-md as an official Obsidian community plugin** — submit to the
  in-app plugin directory so users can search "Review MD" and click Install (the
  truly one-click path). Requires: a PR to `obsidianmd/obsidian-releases` adding the
  plugin to `community-plugins.json`, passing Obsidian's automated + human review
  (plugin guidelines: no `innerHTML`/`outerHTML` assignment, proper `onunload`
  teardown, `isDesktopOnly` honoured, no network calls without disclosure, etc.),
  and a tagged GitHub release (already automated via `make release`). Pre-req cleanup
  before submitting: the audit's open findings — esp. **#1 MutationObserver +
  MarkdownView leak on closed tabs** (lifecycle teardown is exactly what reviewers
  check) — plus a scan for any `innerHTML` usage. Until this lands, BRAT
  (`omars-lab/review-md`) is the install path. Requested 2026-09-21. ROI: high value
  (widest reach, best UX) but gated on review turnaround (days–weeks) and the
  lifecycle fixes; do the hardening pass first, then submit.

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

- **Comment on a link (`link` anchor type)** — in comment mode, **double-clicking a link**
  selects the *entire* link and starts a thread anchored to it (rather than the surrounding
  `text` block). New anchor type `link` alongside `text`/`header`/`image`/`mermaidNode`/
  `mermaidEdge`; likely fields: `href` (the link target — internal `[[wikilink]]` or external
  URL), `quote` (the link display text), and the existing `line`/`blockId` for fallback. Render:
  the reviewer highlights the whole `<a>`/`.internal-link`/`.external-link` element on
  double-click and anchors there. Staleness (`anchorContentFor`) extracts the link's
  href+text. Additive — extends the anchor union and `validate-comments` `ANCHOR_REQUIRED`,
  no breaking change. Requested 2026-09-21. ROI: medium — reuses the click-to-comment plumbing;
  the new work is link-element hit detection (double-click vs the single-click block anchor) and
  the extraction case. Pull into a small POC or issue note when picked up.

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

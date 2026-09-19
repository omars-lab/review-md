# Backlog — `review-md`

Deferred ideas and traded-off scope. Pulled into the plan when needed. One line per item; expand
into `docs/pocs/` or `docs/issues/` if/when picked up.

## Deferred

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

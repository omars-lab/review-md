# Comments move to a git-tracked sibling sidecar file

## The pivot

Comments used to live in the reviewed file's own YAML frontmatter (requirement 7,
POC-4's "frontmatter-primary"). They now live in a **sibling sidecar** next to the
reviewed file: for `design.md`, the comments are in `.design.comments.md` (a
hidden dotfile, same directory). The sidecar is **git-tracked** (checked in), not
gitignored.

Decision by Omar, 2026-09-19.

## Why

**Commenting should not create a revision on the reviewed file.** When threads
lived in the reviewed file's frontmatter, every new comment, reply, resolve or
edit rewrote `design.md` — so `git log design.md` filled with comment churn and
the file's blob changed constantly, even though its actual prose/diagrams never
moved. Moving comments to a sibling file means:

- The reviewed file's git history reflects **content** changes only. Comment
  activity touches `.design.comments.md`, never `design.md`.
- The reviewed file's committed blob is stable across comment activity, which
  reinforces the version-stamping design (`docs/issues/version-stamping.md`): the
  `bodyHash` staleness signal was already frontmatter-agnostic, but now the whole
  reviewed file — frontmatter included — is stable when only comments change.
- Comments are still **checked in** and travel with the repo, so review history is
  durable and diffable, and an agent (`review-design`) can read threads straight
  from the sidecar.

This is the "sidecar fallback" POC-4 documented — promoted to the default.

## Format

`.<basename>.comments.md` is a normal markdown file with two parts:

1. **Frontmatter `review:` block — the source of truth.** The same schema as
   before (`uid`, `threads[]` with `anchor`, `resolved`, `messages`, `rev`).
2. **A generated, human-readable body** listing each thread and its messages, so
   the file reads well on GitHub and produces legible git diffs. The body is
   regenerated on every write from the frontmatter; it is never parsed back.

## Implementation notes

- **Obsidian ignores dotfiles.** A leading-`.` path is not indexed in the vault,
  gets no `TFile`, and never appears in `metadataCache`. So the store can't use
  `processFrontMatter` / `getFileCache` on the sidecar. Instead it uses the raw
  `vault.adapter` (`exists`/`read`/`write`) and (de)serialises the `review:` block
  with `parseYaml` / `stringifyYaml` from the `obsidian` module.
- **All thread access is centralised** in `main.ts` behind `readReview` /
  `readThreads` (read) and `mutateReview` (read-modify-write). `createThread`,
  `appendReply`, `editMessage`, `deleteThread`, `setThreadResolved`, the mermaid
  augmenter and the bake command all go through them. Reads are now **async**
  (adapter I/O), so the sidebar caches threads in `CommentsView.threads` and
  reloads via `refresh()`.
- **No metadata event fires for the sidecar** (it's not a vault file), so after a
  write the plugin explicitly refreshes the sidebar and re-renders the reviewed
  file's reading view (`notifyReviewChanged`) so the mermaid augmenter re-injects
  its comment nodes.
- **Legacy migration.** If a reviewed file still has an in-frontmatter `review:`
  block and no sidecar yet, `readReview` falls back to it; the next write creates
  the sidecar and strips the `review:` block from the reviewed file
  (`stripLegacyFrontmatter`) — a one-time move, verified live on the dogfood
  `design.md` (3 threads migrated, source frontmatter left with only `title`).

## Related

- `docs/issues/version-stamping.md` — the staleness signal this reinforces.
- `docs/pocs/poc-4-frontmatter.md` — where the sidecar fallback was first sketched.

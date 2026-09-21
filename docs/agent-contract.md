# Agent contract — reading review-md threads (P5)

The `review-design` agent (external skill, 3d-models PR #278) consumes comment
threads as its **findings input**, and `review-setup` validates that a vault is
wired for the loop. Both read the same stable contract described here. Nothing in
the loop requires Obsidian to be running — threads live in plain files on disk.

## Where threads live

For a reviewed file `<dir>/<name>.md`, threads live in a **git-tracked sibling
sidecar**:

```
<dir>/.<name>.comments.md
```

(A dotfile, so Obsidian's vault index and `metadataCache` ignore it; the plugin
reads/writes it through the raw adapter.) The sidecar move (req 7) means
commenting never revises the reviewed file — its git blob and body stay stable
when only comments change. See [`comment-sidecar.md`](issues/comment-sidecar.md).

The sidecar's YAML **frontmatter is the source of truth**; its Markdown body is a
generated, human-readable/diffable rendering — never parse the body.

## Sidecar shape

```markdown
---
review:
  uid: <stable id for this file's review set>
  threads:
    - id: <short id>
      resolved: <bool>
      anchor: { … see anchor shapes … }
      rev:                      # optional; the version this thread was authored against
        bodyHash: <sha256[:12] of the reviewed body>
        ts: <ISO8601>
        git: { commit: <short>, blob: "HEAD:<relpath>" }   # only when git-tracked
      messages:
        - { author: <name>, ts: <ISO8601>, body: <text> }
---

# Comments — <name>.md   (generated body below; do not parse)
```

### Anchor shapes

| `type`        | keys                                   | means                        |
|---------------|----------------------------------------|------------------------------|
| `text`        | `quote`, `line?`, `blockId?`           | a passage of prose           |
| `mermaidNode` | `node`, `quote`, `blockId?`            | a diagram node               |
| `mermaidEdge` | `from`, `to`, `quote`, `blockId?`      | a diagram arrow              |
| `image`       | `src`                                  | a whole image                |

`quote` is the anchor text an agent keys its findings to. `blockId`, when present,
is a native Obsidian `^id` on the source block, so `[[<name>#^<blockId>]]` deep
-links resolve even with the plugin disabled (see
[`durable-anchoring.md`](issues/durable-anchoring.md)).

## Findings input

**Unresolved threads (`resolved: false`) with their anchor `quote` are the
findings the agent acts on.** A thread's discussion is its `messages[]` in order;
the first message is the opening comment.

## Staleness

`rev.bodyHash` is the **sole staleness signal**: the sha256 (first 12 hex chars)
of the reviewed file's body with the YAML frontmatter stripped **and block-id
markers (`^id`) stripped** — so neither adding a comment nor writing an anchor
block-id ever false-flags a thread. A thread is **stale** when its `rev.bodyHash`
differs from the reviewed file's current bodyHash: the text it was reviewed
against has since changed. `git.commit`/`git.blob` are for identity and retrieval
only (`git show <commit>:<relpath>`), never staleness. Full rationale:
[`version-stamping.md`](issues/version-stamping.md).

## Reading it: `scripts/review-threads.mjs`

A headless, dependency-light reader (uses only the `yaml` package) that locates
the sidecar, parses it, and re-derives the bodyHash to flag stale threads —
byte-for-byte the same computation the plugin stamps (proven by round-trip: a
thread the plugin stamps reads back `outdated: false`, and flips to `true` after
the body is edited).

```
npm run threads -- path/to/design.md              # readable findings digest
npm run threads -- path/to/design.md --unresolved # only open threads
npm run threads -- path/to/design.md --json       # structured, each thread + `outdated`
```

`--json` emits `{ uid, file, threads: [ { …thread, outdated } ] }` — the stable
programmatic surface for the agent. Exit codes: `0` read OK (even with zero
threads), `2` usage error, `3` no sidecar (no comments yet).

## review-setup checklist

`review-setup` should verify, PASS/FAIL:

- [ ] The `review-md` plugin is installed and enabled in the target vault.
- [ ] `obsidian://review-md-open` and `obsidian://review-md-reply` resolve (the
      x-callback actions the reviewer/agent round-trip on).
- [ ] For each reviewed file that has comments, its sidecar
      `<dir>/.<name>.comments.md` exists and `npm run threads -- <file> --json`
      exits `0` with parseable output.
- [ ] The sidecar is git-tracked (not `.gitignore`d) so review state ships with
      the repo.
- [ ] `npm run threads -- <file>` re-derives a bodyHash equal to the plugin's for
      an unedited file (staleness signal is trustworthy).

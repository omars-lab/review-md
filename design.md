---
title: review-md — design
review:
  uid: designdoc0001
  threads:
    - id: d1a2b3
      anchor:
        type: mermaidNode
        blockId: arch
        node: CS
        quote: Comment store (frontmatter)
      resolved: false
      messages:
        - author: omar
          ts: 2026-09-19T10:00:00Z
          body: "frontmatter or a sidecar at scale?"
        - author: claude
          ts: 2026-09-19T10:05:00Z
          body: "POC-4: frontmatter-primary good to ~40 threads; sidecar fallback documented."
    - id: e4f5a6
      anchor:
        type: mermaidNode
        blockId: arch
        node: MA
        quote: Mermaid augmenter
      resolved: true
      messages:
        - author: omar
          ts: 2026-09-19T10:10:00Z
          body: "does augmenting revert on re-render?"
        - author: claude
          ts: 2026-09-19T10:12:00Z
          body: "no — we own the mermaid code-block processor, so ours IS the render."
    - id: a7b8c9
      anchor:
        type: mermaidNode
        blockId: lifecycle
        node: Store
        quote: write thread to frontmatter
      resolved: false
      messages:
        - author: omar
          ts: 2026-09-19T10:20:00Z
          body: "one block ref per thread so links survive edits?"
---

# review-md — design

> A dogfood target: this doc is meant to be **opened in the review-md reviewer**
> and commented on. The comment nodes you see hanging off the diagrams below are
> **not written into the diagram source** — they're rendered from the `review.threads`
> in this file's frontmatter (augmented render, requirement 9).

## What it is

An Obsidian plugin to review any markdown file: click any rendered element to drop
a comment, each comment is its own chat thread, threads live in the file's
frontmatter (git-friendly, agent-parseable), and threads are shareable/repliable via
`obsidian://` x-callback URLs. The full URL API (one action per operation:
`review-md-open`, `review-md-reply`) is documented in [`docs/api/`](docs/api/xcallback.md)
— generated from `src/protocol/xcallback.schema.json` and kept in sync by a pre-commit hook.

## Architecture

Click **Comment store** or **Mermaid augmenter** below — those nodes carry live
threads from this file's frontmatter.

```mermaid
flowchart TB
  URL["obsidian://review-md-open?vault=…&file=…&thread=…"] --> PH[Protocol handler]
  PH --> RV[Reviewer view]
  RV -->|click a rendered element| CS[Comment store · frontmatter]
  CS --> MA[Mermaid augmenter]
  MA -->|augmented SVG| RV
  RV --> SL[Share link · x-callback]
  SL -.->|reply URL| PH
```

## Comment lifecycle

```mermaid
flowchart LR
  Render[Rendered markdown] -->|click| Anchor[Resolve anchor]
  Anchor --> Thread[New thread]
  Thread --> Store[Write to frontmatter]
  Store --> Reload[Re-render]
  Reload --> Render
```

## Anchor types

| type | anchors to | key fields |
|---|---|---|
| `text` | a phrase / block | `line`, `blockId`, `quote` |
| `image` | a whole image | `src` (coords deferred → backlog) |
| `mermaidNode` | a diagram node | `blockId`, `node`, `quote` |

## Storage schema (frontmatter)

```yaml
review:
  uid: <stable file id>
  threads:
    - id: <short id>          # also the ^blockId link target
      anchor: { type, … }
      resolved: false
      messages:
        - { author, ts, body }
```

## Requirement 9 — mermaid comment nodes

Threads on a diagram node stay in frontmatter. At render time the plugin re-renders
`original source + injected comment nodes` (diagram source untouched), and a
"Bake comments into diagram" command can fold them into the source on demand.

```mermaid
flowchart LR
  Src["stored ```mermaid (untouched)"] --> Aug[Augmenter]
  FM[frontmatter threads] --> Aug
  Aug --> Out["render: diagram + 💬 nodes"]
  Aug -.->|Bake command| Baked["source + 💬 nodes written in"]
```

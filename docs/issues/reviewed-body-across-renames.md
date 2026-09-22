# Reviewed body (and diagram preview) must follow renames

## Symptom

The **Content Revisions** accordion for a mermaid node/edge comment showed the
node's bare *text declaration* (`CS["Comment store …"]`), never a rendered preview
of the diagram as it was reviewed. Every card also reported **"stored quote (no git
history)"** even though the thread carried a real commit stamp and the repo has full
history — including the flagship dogfood doc `docs/designs/design.md`.

## Root cause

Two independent gaps, both on the reviewed-version path:

1. **`fillReviewedVersion` rendered text unconditionally.** For any anchor type it
   emitted `<pre>snippetAround(body, quote)</pre>`. A mermaid node/edge anchor's
   stored `quote` is its text declaration, so the accordion could only ever show
   text — never the diagram, unlike the card's top preview which renders a mini SVG
   from the *current* file.

2. **`reviewedBodyFor` didn't follow renames.** It ran `git show <commit>:<current
   path>` only. `design.md` was later moved into `docs/designs/`, so for every
   thread stamped to a commit *before* that rename, `<commit>:docs/designs/design.md`
   doesn't exist → `git show` fails → `null` → the sidebar falls back to the stored
   quote. Since all the dogfood mermaid threads are stamped to pre-rename commits
   (`28ae788`, `b1237be`, `bd9dda7`), the git-recovery feature was effectively dead
   for the one doc it's demoed on. This is the same rename that broke `v`-numbering
   (see [docs-vault-and-follow-reverse.md](docs-vault-and-follow-reverse.md)).

## Fix

- **`reviewedMermaidPreviewSource(file, thread)`** (main.ts) builds a minimal
  node/edge mermaid source from the *reviewed* version's fences — the same minimal
  preview style the card already shows for the current version, so the accordion
  reads as a genuine before/after of that element. `fillReviewedVersion` renders it
  to SVG for mermaid anchors and falls through to the text snippet if the diagram is
  gone from that version or mermaid can't render it.
- The fence splitter moved to `pure.ts` as **`mermaidBlocksFrom(text)`** so the
  preview builders can run against any version's text (current file *or* a blob from
  git), and it's unit-tested. `mermaidNodePreviewSource` / `mermaidEdgePreviewSource`
  now delegate to block-set cores (`nodePreviewFromBlocks` / `edgePreviewFromBlocks`).
- **`reviewedBodyFor`** retries across the file's historical paths
  (`historicalPaths` walks `git log --follow --name-only`) when the current path
  doesn't exist at the stamped commit. This repairs *all* reviewed-body recovery on
  renamed files, not just the mermaid case — the text-snippet path benefits too.

## Why minimal preview, not the whole old diagram

The card's top preview already renders the *current* element in isolation; showing
the *previous* element in the same isolated style makes the two directly comparable.
Rendering the entire prior diagram would answer a different question (how the whole
diagram changed) and wouldn't line up with the card. If a full-diagram diff is wanted
later, it's an additive option on top of this, not a change to it.

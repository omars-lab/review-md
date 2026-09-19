# POC-1 — `obsidian://review-md` protocol handler (go/no-go)

**Risk:** the whole share/reply/open feature set (requirements 1, 4, 5) rests on a custom
`obsidian://` action working end to end: open the right file, jump to a thread anchor, and call back.

**PASS bar:** clicking a generated link opens the right file, lands on the `^block`, and (for
replies) fires `x-success`.

## Status

| Piece | State |
|---|---|
| Handler registered (`registerObsidianProtocolHandler("review-md", …)`) | built in `src/main.ts` |
| Open file + jump to `^thread` + `x-success`/`x-error` | built (self-reports to `POC-1-report.md`) |
| End-to-end run in Obsidian | ⏳ pending one-time GUI enable |

The handler is **self-reporting**: on fire it writes `POC-1-report.md` into the vault, so the result
is verifiable from the file system without the dev console.

## How to run

1. `npm run build && npm run install:dev` (done — vault at `.dev-vault`).
2. Open `.dev-vault` as a vault; disable Restricted Mode; enable **Review MD** (GUI-only).
3. From a terminal:
   ```sh
   open 'obsidian://review-md?vault=.dev-vault&file=sample.md&thread=anchor-me'
   ```
   `sample.md` contains a `^anchor-me` block ref to land on.
4. Confirm Obsidian focuses `sample.md` at the `^anchor-me` block, then read
   `.dev-vault/POC-1-report.md` — it should say **RESULT: PASS** with the opened path + params.
5. Reply/x-success check:
   ```sh
   open 'obsidian://review-md?vault=.dev-vault&file=sample.md&thread=anchor-me&action=reply&x-success=obsidian://open?vault=.dev-vault%26file=POC-1-report.md'
   ```
   The `x-success` URL should be invoked after the handler runs.

## Notes / limitations found (from API research)

- Protocol params arrive **only as strings** (no arrays/nesting) — structured data must be packed
  into one encoded param. Fine for `file`/`uid`/`thread`/`action`/`body`.
- `file` resolution is path-based here; the durable version resolves by frontmatter `uid`
  (rename-stable), added with the data layer.
- Block-scroll uses `openLinkText(file#^id)`; if the anchor block id isn't present yet the file
  still opens (degrades gracefully).

## Verdict

Pending the one-time GUI enable. All code is in place and self-reporting; this is expected to PASS
(protocol handlers are a stable, documented API). Record the result here after running.

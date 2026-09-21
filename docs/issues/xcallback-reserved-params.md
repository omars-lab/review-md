# x-callback: Obsidian reserves `action` and `vault`, so operations get one action each

**Date:** 2026-09-19
**Status:** resolved (scheme redesigned)

## Symptom

Firing the reply URL did nothing — no thread append, no `console.error`, no Notice:

```
open "obsidian://review-md?action=reply&vault=.dev-vault&file=design.md&thread=d1a2b3&body=…"
```

Meanwhile the handler code was provably correct: invoking `plugin.handleReply(params)`
directly via `obsidian-cli eval` appended the reply and persisted it to disk.

## Investigation (live, isolated harness)

1. A freshly registered probe action (`obsidian://rvwprobe?hello=world`) **did** dispatch, so
   OS → Obsidian URL delivery was working and the isolated instance was the sole handler.
2. `app.workspace.protocolHandler.handlers` (a `Map`) contained `review-md` as our exact
   function, and re-registering it threw `Action "review-md" is already registered` — so
   registration was fine too.
3. Wrapping the `review-md` entry in the Map with a counter and firing the URL revealed what
   Obsidian actually passes to a handler:

   ```
   fired: obsidian://review-md?action=open&vault=.dev-vault&file=design.md
   handler received: { action: "review-md", file: "design.md" }
   ```

## Root cause

Obsidian's protocol router **reserves two query params** and does not pass them through as the
caller wrote them:

- **`action`** is overwritten with the registered handler's own name (`review-md`), destroying
  any `action=open` / `action=reply` selector the caller supplied.
- **`vault`** is consumed internally to route the URL to the correct vault window and is stripped
  before the handler runs.

Our original design selected the operation with an `action=<op>` query param — a direct collision
with Obsidian's reserved `action`. The operation selector could never arrive.

## Fix

**One registered Obsidian action per operation** (chosen 2026-09-19 over a single action with an
`op` selector param). This embraces Obsidian's model — the action after `obsidian://` *is* the
operation — and matches the x-callback-url idiom (distinct action endpoints):

| Operation | URL |
|---|---|
| open | `obsidian://review-md-open?vault=…&file=…&thread=…` |
| reply | `obsidian://review-md-reply?vault=…&file=…&thread=…&body=…&author=…` |

`vault` stays in the URL (Obsidian needs it to pick the vault window) but the handler never reads
it — it resolves `file` against the active vault. The `action` param is gone from the schema; the
operation is the action name itself.

## Second bug, same root cause: `vault` validated as required

After switching to one-action-per-operation, URLs *still* did nothing — `handleReply` ran clean
in direct `eval` but every `open '<url>'` was a no-op with no error surfaced. Instrumenting the
handler showed it dispatched (`hits: 1`) and returned without throwing, yet nothing persisted.

The reason: the plugin wraps each handler in `try { validateParams(op, params); … }`. The schema
marks `vault` **required**, but Obsidian strips `vault` before delivering params — so
`validateParams` threw `missing required param(s): vault` on *every* URL call, before
`handleReply`/`handleUri` could run. Direct `eval` calls bypass the protocol wrapper (they call
`handleReply` directly), which is why they appeared to work — a false positive that hid the bug.

Fix: params carry a `reserved: true` flag (currently just `vault`) meaning "required in the URL
for Obsidian's routing, but never delivered to the plugin." `validateParams` skips reserved params;
the generated docs still show them as required (`yes — URL only`) so callers know to include them.

**Lesson (added to the test note):** a direct `handleReply`/`handleUri` `eval` is necessary but
NOT sufficient — it skips the protocol wrapper and the URL router, which is exactly where both of
these bugs lived. The real gate is firing `open '<url>'` and reading the result from **raw disk**.

## Guardrails so this can't regress

- The schema (`src/protocol/xcallback.schema.json`) is the single source of truth; each operation
  carries its own `action`. The plugin registers one handler per `operations[].action`.
- **Never** name a caller-facing param `action` or `vault` — both are reserved by Obsidian. This
  is enforced by convention in the schema and called out here.
- Live end-to-end test (both actions fired via `open`) is the real gate; direct `handleReply`
  eval is necessary but **not sufficient** — it bypasses the URL router that caused this bug.

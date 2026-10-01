# Links route by vault id, not name

## What happened (2026-10-01)

Testing the new `mode=edit` link on a doc in `youtube/docs`:

```
obsidian://review-md-open?vault=docs&file=design%2Fpencil-arc-scoring.md&mode=edit
```

opened `3d-models/docs` instead, which has no such file. Four vaults were open, and three
of them are named `docs` (youtube, hifth, 3d-models). Obsidian routes `vault=` to the first
vault with that name, and that wasn't the one the link came from.

Every link review-md hands out had the same problem: the share link, the reply template,
and the open/reply links in the export digest were all built from `app.vault.getName()`.
A link copied in one `docs` vault could open another.

## What changed

Obsidian also accepts the vault's **id** in `vault=` (the key under `vaults` in
`obsidian.json`, exposed at runtime as `app.appId`). Ids are unique. The same link with
`vault=yt0docs0vault001` opened the right doc, in the editor; with `mode=read`, in Reading
view (checked by reading the active leaf's view state after each).

`linkVault(appId, name)` in `src/pure.ts` picks the id, and falls back to the name if the
app has none. The share link, reply template and digest links use it. The digest heading
still names the vault for a person to read. The schema's `vault` param now says
"name or id".

## Related

`docs/issues/setup-same-named-vaults.md`: the same name clash, hit by the setup script's
`obsidian eval vault=docs`.

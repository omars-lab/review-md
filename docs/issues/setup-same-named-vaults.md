# setup-vault: a same-named vault got the install

## What happened (2026-10-01)

`make setup-install VAULT=/Users/omareid/Workspace/git/youtube/docs` reported success
("installed review-md vnull") but the youtube vault ended up with only BRAT's files, not
enabled, and no review-md. Meanwhile `hifth/docs` had review-md updated to 0.1.2 and one
line of its tracked `obsidian42-brat/data.json` rewritten (`"version": "latest"` → `""`).

## Why

`setup-vault.mjs` writes BRAT's files to the path it is given, but every live step (enable
BRAT, BRAT's `addPlugin`, enable review-md) goes through `obsidian eval vault=<name>`, and
`<name>` was `basename(path)` = `docs`. Three open vaults were named `docs` (youtube, hifth,
3d-models); the app answered for hifth. The readiness probe (`app.vault.getName()`) passed
because hifth's name is also `docs`, so nothing noticed. `vnull` was the youtube vault's
review-md version: never installed.

## What changed

`wrongLiveVault(name, vault)` asks the app for `app.vault.adapter.basePath` and compares it
with the target path. `install` stops before its first change when they differ; `check`
reports it as an `app attached to vault` row and skips the live reads, which were also
reading the other vault's restricted-mode setting.

The fix is a refusal, not a redirect: the CLI has no way to address a vault by path, so the
person switches Obsidian to the right vault and re-runs.

## Still open

- `verify` takes a vault *name* and has the same blind spot. Its `plugin loaded` row now
  names the folder that answered, so read that line.
- The `hifth/docs` BRAT setting this run changed has to be put back by hand there.

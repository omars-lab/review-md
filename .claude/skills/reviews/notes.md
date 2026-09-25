# reviews CLI — dogfood notes

One dated line per finding from running the [reviews skill](SKILL.md) for real.
Fixed items say where; open ones are mirrored in `docs/backlog.md`.

## 2026-09-25 — first run, on this repo's `docs/` vault

- **Useful:** `stats docs` answers "where is feedback waiting?" in one table.
- **Useful:** `--json` + `show` + `reply` make a clean loop; `--dry-run` shows the exact
  obsidian:// URL before anything is sent.
- **Useful:** reply round-trips — sent through Obsidian, read back with `show` (proved in
  an isolated vault).
- **Fixed:** folder JSON gave `file` relative to the vault while `root` was the folder
  passed in, so from a subfolder the path pointed nowhere and couldn't be passed back to
  `show`/`reply`. Now `file` is always the on-disk path, plus `vaultPath` for Obsidian.
- **Fixed:** no way to ask "what's waiting on me?" — every open thread here had already
  been answered. Added `--waiting <name>` (threads where <name> didn't speak last); it cut
  3 open threads to the 1 that actually needs a reply.
- **Fixed:** `show` labelled a lone open thread "open and resolved".
- **Missing:** no way to resolve. An agent can answer but not close, so answered threads
  pile up as open. Needs a `review-md-resolve` URL in the plugin first → backlog.
- **Noisy:** every thread shows OUTDATED because the CLI compares the whole doc's hash;
  any edit anywhere flags every thread. The plugin checks just the anchored passage when
  it can — the CLI should do the same → backlog.
- **Gotcha:** `reply` needs Obsidian running with the doc's vault open; with two Obsidian
  windows/instances the URL goes to whichever claimed the obsidian:// scheme first.

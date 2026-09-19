# review-md

Click any part of a **rendered** markdown doc and drop a comment. Each comment is its own chat
thread; threads live in the file's **frontmatter**, are **shareable** and **repliable** via
`obsidian://` x-callback URLs, and are readable by review agents.

An Obsidian plugin. See [`.claude/plans/design-review-tooling.md`](.claude/plans/design-review-tooling.md)
for the full design, [`docs/backlog.md`](docs/backlog.md) for deferred scope, and `docs/pocs/` for
de-risking spikes.

## Status

Early scaffold. Go/no-go POCs (protocol handler, frontmatter-at-scale) precede the full build.

## Features (target)

1. Open any file into the reviewer via an `obsidian://review-md` deep link.
2. Click rendered markdown → start a comment thread anchored to that spot.
3. Each comment is a chat thread (messages + replies).
4. Share a single thread via a deep link.
5. Reply to a thread via an x-callback URL (`x-success` / `x-error`).
6. Comment on images (whole-image; in-image coordinates are backlog).
7. Threads persist in the markdown file's YAML frontmatter.

## Develop

```sh
nvm use                 # Node from .nvmrc (v22.22.3)
npm install
npm run dev             # esbuild watch → main.js
```

Symlink or copy `main.js`, `manifest.json`, `styles.css` into a vault's
`.obsidian/plugins/review-md/`, then enable it (Community plugins, GUI).

## Security / secrets

- **gitleaks** runs on every commit (pre-commit) and is available as `npm run secrets`.
- **dotenvx**: local secrets go in an encrypted `.env` (committable); the private key lives in
  `.env.keys` which is git-ignored. Never commit `.env.keys`.

## License

MIT

# Image threads stored a machine address, not the image

## What happened

A beta screenshot showed an image thread's card as a long
`app://468bc…/Users/<name>/Library/Mobile Documents/…/hub-42.png` string
instead of the picture. Three things were wrong, all from one cause: on click
the plugin stored the rendered `<img>`'s `src`, and Obsidian renders vault
images as `app://<id>/<absolute path>?<mtime>`.

- **The card showed the address, not the image.** Draft cards printed the
  `src`; thread cards showed nothing at all for an image.
- **The address is private and machine-bound.** It names the user's home
  folder, sits in a sidecar that is often committed, and points at nothing on
  anyone else's machine.
- **Every image thread looked gone.** The "is the anchor still there" check
  looked for the `src` in the note's text. The note says `![[hub-42.png]]`,
  never the `app://` address, so image threads always read as lost.

## What changed

- **Store the vault path.** A new click stores `shots/hub-42.png`
  (`imageVaultPath` in `src/pure.ts`). Web images keep their URL. On mobile,
  where there is no vault folder on disk, the old `src` is kept.
- **Show the real image.** Cards (draft and thread) load the file through
  `vault.getResourcePath`, so the picture shows whether or not the note is open,
  with the vault path under it. If the file is gone, only the name shows.
- **Find images by file name.** The presence check and the line lookup match
  the file name, so old `app://` threads and new ones both work. The
  one-line summary (`reviews list`, digests) shows an old thread's file name
  rather than the machine path.
- **Jump to the image by vault path.** Clicking a card compares vault paths,
  not raw `src` strings, which also ignores the `?mtime` that changes.

Old sidecars are not rewritten; they keep working through the file-name match.

## Considered and not done

A saved screenshot of the commented area (desktop-only Electron capture, a PNG
per thread in the vault). It would freeze what the reviewer saw, but adds files
to sync and commit and changes the sidecar shape. A live copy of the element
was chosen instead: for images that is the image itself; diagrams already get
a small rendered diagram; headings read as headings.

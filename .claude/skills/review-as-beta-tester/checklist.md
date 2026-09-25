# Beta tester checklist — review-md

Read top to bottom each run. Each check says what to look at and what "good" is.
`<ver>` is the version in `manifest.json` on `main`.

## 1. Public face — before anyone installs

- **Repo is public.** `gh repo view omars-lab/review-md --json visibility` → `PUBLIC`.
  Private means BRAT 404s for every tester.
- **BRAT's files download without a login.** Each of these returns `200` from `curl -sS
  -o /dev/null -w "%{http_code}"` (add `-L` for the release files):
  - `https://raw.githubusercontent.com/omars-lab/review-md/main/manifest.json`
  - `https://github.com/omars-lab/review-md/releases/download/<ver>/main.js`
  - `…/<ver>/manifest.json` and `…/<ver>/styles.css`
- **The release is published, not a draft**, its tag is exactly `<ver>` (no `v`), and it
  has all three files attached. `gh release view <ver>`. Moving or re-pushing a tag can
  turn a release back into a draft — check after any history rewrite.
- **`main` and the release agree.** The manifest on `main` says `<ver>`, and
  `versions.json` has an entry for it. BRAT reads the version from `main`, then fetches
  the release with that exact tag.
- **No personal email in history.** `gh api "repos/omars-lab/review-md/commits?per_page=100"
  --jq "[.[].commit.author.email] | unique"` shows only the GitHub noreply address. Also
  `git config user.email` in the clone is the noreply address, so the next commit doesn't
  reintroduce it. (Old merged PRs keep their original commits — only GitHub Support can
  purge those.)
- **Open PRs look right.** `gh pr list` — nothing stale or half-done sits at the top of the
  repo page for a visitor to trip over.
- **README reads well on GitHub.** Open the repo page in a browser: every image and GIF
  loads, every relative link (`docs/…`, `.claude/skills/…`) opens, the install section is
  the first thing a tester needs and is correct for today (no token step now the repo is
  public).
- **No secrets or private paths in tracked files.** `make check` runs gitleaks; also grep
  tracked files for `/Users/` and personal emails.

## 2. Install — the way a tester does it

- **Fresh vault, no token.** Via [`setup-review-md`](../setup-review-md/SKILL.md):
  `setup-check` lists what's missing → `setup-install` (no `--token-name`) → `setup-verify`
  all PASS → `setup-check` all OK.
- **The installed version is `<ver>`**, not a build from our clone.
- **The README's manual path works too**: BRAT → "Add a beta plugin" →
  `omars-lab/review-md` → enable **Review MD**. Walk it by hand once per release, with
  screenshots.
- **No errors in the developer console** on load (`app.plugins` loaded, nothing red).

## 3. Features — one pass per README promise

In the fresh vault, on a new note with a heading, a paragraph, an image, a link and a
mermaid diagram. Screenshot each and read the picture.

- **Comment mode** — toggling it shows in the status bar; clicking an element opens a draft
  card with a preview of that element; nothing is written until **Comment**; a mis-click
  then cancel leaves no sidecar.
- **Every anchor type** — text, heading, image, link, mermaid node, mermaid edge each
  create a thread with the right type badge, and clicking the card flashes the right
  element.
- **The reviewed doc is untouched** — after commenting, `git diff` on the note shows at most
  a `^block-id` on a text-anchored block. The thread text is only in `.<name>.comments.md`.
- **Threads** — reply, ⌘/Ctrl+Enter posts, Markdown renders in the message, **Resolve**
  closes it, delete a message works.
- **Reviewer name** — set in Settings, used on the next message.
- **Share & reply links** — copy a share link, open it: the file opens focused on that
  thread. A `review-md-reply` link posts a reply.
- **Mermaid badges** — commented nodes are recoloured with a count badge; the diagram's
  source is unchanged. **Bake** folds them in only when run.
- **Versions** — commit the note, edit the anchored element, commit again: the thread shows
  **outdated**; the stepper walks back through versions and shows the old content. Editing
  a *different* element doesn't mark it outdated.
- **Triage** — open / hidden / resolved chips count and filter; the Revisions dropdown
  narrows to one version; search matches bodies, authors and anchors; sort by recency, doc
  position, author; a long thread folds behind **Show N earlier**. Replying to one card
  doesn't make the list jump.

## 4. First-time feel

- Could someone who never read our docs find how to start commenting within a minute?
- Does any message, command name or setting use wording only we would understand?
- Is anything in the README wrong for a tester (a step that assumes a clone, a stale
  screenshot, a feature that moved)?
- Light and dark theme both readable.

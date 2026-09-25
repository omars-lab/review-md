---
name: review-as-beta-tester
description: >-
  Review review-md the way an outside beta tester meets it — the public GitHub page, the
  release BRAT installs from, a fresh install, then every feature the README promises —
  and write up what's broken or confusing. Use when asked to "review as a beta tester",
  "beta test review-md", "what would other folks see", "check the release before testers
  get it", "is the public repo ok", or after cutting a 0.1.x beta. Checks live in
  checklist.md next to this file.
---

# review-as-beta-tester — see review-md the way a stranger does

A beta tester has none of our context: no clone, no dev vault, no memory of why things are
the way they are. This skill walks the same path they do, in order, and stops treating
anything as fine until it has been seen from the outside.

**The checks live in [`checklist.md`](checklist.md).** Read it at the start of every run —
it grows as testers report things, and this file doesn't need to change when it does.

## The flow

1. **Public face** (checklist §1). Look at what someone sees before installing: the repo
   page, the README with its images, the latest release, the commit history. Use `gh` and
   `curl` *without* relying on our login where it matters — a tester has no access we have.
2. **Install like a tester** (checklist §2). Fresh vault, BRAT, no token. Use the
   [`setup-review-md`](../setup-review-md/SKILL.md) skill for the mechanics
   (`make setup-check / setup-install / setup-verify`); don't redo its steps by hand.
3. **Walk the features** (checklist §3). One pass per README promise, in the live app,
   in the fresh vault — not in `docs/`, which already has threads and config a tester
   won't have. **Look at a screenshot for each one**; a DOM check has passed on a blank
   panel before.
4. **First-time feel** (checklist §4). Things that aren't bugs but would stop a newcomer:
   unclear wording, a missing hint, a step the README skips.
5. **Write it up** (below).

## Writing it up

One file per run: `docs/beta/<YYYY-MM-DD>-<version>.md`. For each finding:

- **What I did** — the steps, from a fresh vault.
- **What I expected** — quote the README line that promised it, when there is one.
- **What happened** — plus the screenshot path.
- **How bad** — *blocks install* · *breaks a feature* · *confusing* · *polish*.

End with a one-line verdict: ready for testers, or what has to be fixed first. Items that
block install or break a feature go into `docs/backlog.md` under the beta item.

**Filing GitHub issues is public — draft them in the write-up and ask before filing.**

## When a check is blocked

Some `gh` reads (release details, PR state) can be refused by the session's safety check.
Don't route around it: list the exact command in the write-up for Omar to run with the `!`
prefix (e.g. `! gh release view 0.1.0`), and say what to look for in its output.

## Adding checks

A tester reports something the checklist would have caught → add the check to
`checklist.md` in plain words, under the right section, with how to check it. Keep each
check to what a tester would notice; plumbing checks belong in `make check`.

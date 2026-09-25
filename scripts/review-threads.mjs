#!/usr/bin/env node
// Kept so `npm run threads -- <doc.md | folder> [--unresolved] [--text <words>]
// [--vault <name>] [--json]` keeps working: it is `reviews list` under its old name.
// All the logic lives in scripts/reviews.mjs — see `reviews help list`.
process.argv.splice(2, 0, "list");
await import("./reviews.mjs");

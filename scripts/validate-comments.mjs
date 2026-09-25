#!/usr/bin/env node
// validate-comments — schema-check review-md comment sidecars (the metadata store).
//
// review-md keeps every comment thread in a sibling `*.comments.md` sidecar whose
// `review:` YAML frontmatter is the source of truth (see docs/issues/comment-sidecar.md).
// The plugin writes it, but it's hand-editable and travels through git, CLI tools,
// and agent sessions — so a bad edit (a dropped field, a mistyped anchor, or the
// classic "all-digit hash YAML parsed as an integer") can slip in. This validator
// is the gate: it runs as a pre-commit hook over staged sidecars and as `make
// validate` over the whole tree, and fails the commit on any schema violation.
//
// The all-digit-hash trap is worth calling out: a 12-hex `anchorHash`/`bodyHash`
// that happens to be all decimal digits (e.g. 645390782670) is a NUMBER to YAML
// unless quoted. Read back as a number it never equals the string the staleness
// check computes, so the thread reads "outdated" forever. `--fix` re-quotes those.
//
// Usage:
//   node scripts/validate-comments.mjs [files...] [--fix] [--quiet]
//     files...  explicit sidecars to check (what the pre-commit hook passes);
//               non-sidecar paths are ignored. With none, walks every
//               `*.comments.md` git knows about (tracked or untracked-not-ignored).
//     --fix     auto-repair the one deterministic class — string fields YAML
//               parsed as numbers — by re-quoting them; other errors still fail.
//     --quiet   suppress the per-file OK lines (errors always print).
//
// Exit codes: 0 = all valid (after any --fix), 1 = validation errors remain,
//             2 = not a git work tree when scanning with no file args.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const GIT_TIMEOUT_MS = 4000;
const SIDECAR_RE = /(^|\/)\.[^/]+\.comments\.md$/;
const ANCHOR_TYPES = new Set(["text", "mermaidNode", "mermaidEdge", "header", "image", "link"]);
// Per-anchor-type fields that must be present and non-empty strings.
const ANCHOR_REQUIRED = {
  text: ["quote"],
  header: ["quote"],
  mermaidNode: ["node"],
  mermaidEdge: ["from", "to"],
  image: ["src"],
  link: ["href", "quote"],
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const fileArgs = args.filter((a) => !a.startsWith("--"));
const fix = flags.has("--fix");
const quiet = flags.has("--quiet");

/** Run a git command, returning trimmed stdout, or null on any failure. */
function git(argv) {
  try {
    return execFileSync("git", argv, { encoding: "utf8", timeout: GIT_TIMEOUT_MS }).trim();
  } catch {
    return null;
  }
}

/** Split a sidecar into { yaml, body } where body starts at the closing `---`
 *  fence, so a --fix rewrite preserves the generated body verbatim. */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n(---[\s\S]*)$/);
  return m ? { yaml: m[1], body: m[2] } : null;
}

const isStr = (v) => typeof v === "string";
const isNonEmptyStr = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Validate one sidecar. Returns { errors: string[], fixed: number }. When `fix`
 * is on, string fields that parsed as numbers are coerced back to strings and the
 * frontmatter is rewritten in place; those cases don't count as errors.
 */
function validateFile(path) {
  const errors = [];
  const at = (t, i) => `thread[${i}]${t ? ` (${t})` : ""}`;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { errors: [`cannot read: ${err.message}`], fixed: 0 };
  }
  const split = splitFrontmatter(raw);
  if (!split) return { errors: ["no `---` frontmatter block"], fixed: 0 };

  let doc;
  try {
    doc = parseYaml(split.yaml);
  } catch (err) {
    return { errors: [`invalid YAML: ${err.message}`], fixed: 0 };
  }
  const review = doc?.review;
  if (review == null || typeof review !== "object") {
    return { errors: ["missing `review:` mapping"], fixed: 0 };
  }
  if (!isNonEmptyStr(review.uid)) errors.push("review.uid must be a non-empty string");
  const threads = review.threads;
  if (threads !== undefined && !Array.isArray(threads)) {
    return { errors: ["review.threads must be a list"], fixed: 0 };
  }

  let fixed = 0;
  // Coerce a value that should be a string but parsed as a number/boolean back to
  // a string (only under --fix); records the fix and mutates in place for rewrite.
  const coerce = (obj, key, label) => {
    const v = obj[key];
    if (v == null || isStr(v)) return true;
    if (fix && (typeof v === "number" || typeof v === "boolean")) {
      obj[key] = String(v);
      fixed++;
      return true;
    }
    errors.push(`${label} must be a quoted string (got ${typeof v} \`${v}\` — YAML unquoted it)`);
    return false;
  };

  const seen = new Set();
  (threads ?? []).forEach((t, i) => {
    if (t == null || typeof t !== "object") {
      errors.push(`${at("", i)} must be a mapping`);
      return;
    }
    const type = t.anchor?.type;
    const tag = at(type, i);
    coerce(t, "id", `${tag}.id`);
    if (isStr(t.id)) {
      if (!isNonEmptyStr(t.id)) errors.push(`${tag}.id is empty`);
      else if (seen.has(t.id)) errors.push(`${tag}.id "${t.id}" is duplicated`);
      seen.add(t.id);
    }

    const anchor = t.anchor;
    if (anchor == null || typeof anchor !== "object") {
      errors.push(`${tag}.anchor is missing`);
    } else if (!ANCHOR_TYPES.has(anchor.type)) {
      errors.push(`${tag}.anchor.type "${anchor.type}" is not one of ${[...ANCHOR_TYPES].join(", ")}`);
    } else {
      for (const f of ANCHOR_REQUIRED[anchor.type]) {
        if (coerce(anchor, f, `${tag}.anchor.${f}`) && !isNonEmptyStr(anchor[f])) {
          errors.push(`${tag}.anchor.${f} is required for a ${anchor.type} anchor`);
        }
      }
    }

    if (t.resolved !== undefined && typeof t.resolved !== "boolean") {
      errors.push(`${tag}.resolved must be true/false`);
    }

    if (!Array.isArray(t.messages)) {
      errors.push(`${tag}.messages must be a list`);
    } else {
      t.messages.forEach((m, j) => {
        if (m == null || typeof m !== "object") {
          errors.push(`${tag}.messages[${j}] must be a mapping`);
          return;
        }
        coerce(m, "author", `${tag}.messages[${j}].author`);
        coerce(m, "body", `${tag}.messages[${j}].body`);
        if (m.ts !== undefined) coerce(m, "ts", `${tag}.messages[${j}].ts`);
      });
    }

    const rev = t.rev;
    if (rev !== undefined) {
      if (rev == null || typeof rev !== "object") {
        errors.push(`${tag}.rev must be a mapping`);
      } else {
        coerce(rev, "bodyHash", `${tag}.rev.bodyHash`);
        if (rev.anchorHash !== undefined) coerce(rev, "anchorHash", `${tag}.rev.anchorHash`);
        if (rev.ts !== undefined) coerce(rev, "ts", `${tag}.rev.ts`);
        if (rev.git !== undefined) {
          if (rev.git == null || typeof rev.git !== "object") {
            errors.push(`${tag}.rev.git must be a mapping`);
          } else {
            coerce(rev.git, "commit", `${tag}.rev.git.commit`);
            coerce(rev.git, "blob", `${tag}.rev.git.blob`);
          }
        }
      }
    }
  });

  // Persist the deterministic re-quotes even if other (manual-fix) errors remain,
  // so the numeric-hash class is repaired in one pass; the body is preserved verbatim.
  if (fix && fixed > 0) {
    const fm = stringifyYaml({ review }).trimEnd();
    writeFileSync(path, `---\n${fm}\n${split.body}`, "utf8");
  }
  return { errors, fixed };
}

function sidecarsToCheck() {
  const explicit = fileArgs.filter((p) => SIDECAR_RE.test(p));
  if (fileArgs.length) return { paths: explicit, ok: true };
  const listing = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listing == null) return { paths: [], ok: false };
  return { paths: listing.split("\0").filter((p) => p && SIDECAR_RE.test(p)), ok: true };
}

function main() {
  const { paths, ok } = sidecarsToCheck();
  if (!ok) {
    console.error("[validate-comments] not a git work tree — pass sidecar paths explicitly");
    process.exit(2);
  }
  let totalErrors = 0;
  let totalFixed = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const { errors, fixed } = validateFile(path);
    totalFixed += fixed;
    if (fixed && !quiet) console.log(`[validate-comments] ${path}: re-quoted ${fixed} numeric field(s)`);
    if (errors.length) {
      totalErrors += errors.length;
      console.error(`[validate-comments] ${path}: ${errors.length} error(s)`);
      for (const e of errors) console.error(`  - ${e}`);
    } else if (!quiet) {
      console.log(`[validate-comments] ${path}: OK`);
    }
  }
  if (!quiet && paths.length === 0) console.log("[validate-comments] no comment sidecars to check");
  if (totalErrors > 0) {
    console.error(
      `[validate-comments] ${totalErrors} error(s) across ${paths.length} sidecar(s)` +
        (fix ? "" : " — run `make validate-fix` to auto-repair numeric fields, or fix by hand"),
    );
    process.exit(1);
  }
  if (totalFixed > 0 && !quiet) {
    console.log(`[validate-comments] re-quoted ${totalFixed} field(s) — commit the updated sidecar(s)`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[validate-comments] unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
}

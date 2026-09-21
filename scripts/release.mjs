#!/usr/bin/env node
/**
 * Cut a GitHub release BRAT can install from — manually, no GitHub Actions.
 *
 * BRAT (and the community store) resolve a plugin by reading manifest.json from
 * the repo, then downloading main.js + manifest.json (+ styles.css) from the
 * GitHub *release whose tag equals manifest.json's version exactly* (no `v`
 * prefix). This script enforces that contract, then publishes.
 *
 * Run:  npm run build && node scripts/release.mjs            (or: make release)
 *       node scripts/release.mjs --dry-run                   (validate only)
 *       node scripts/release.mjs --notes "what changed"
 *
 * Preconditions: `gh` authenticated (gh auth status), clean working tree.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesIdx = args.indexOf("--notes");
const notes = notesIdx >= 0 ? args[notesIdx + 1] : "";

const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const readJson = (f) => JSON.parse(readFileSync(join(repo, f), "utf8"));
const git = (a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();

// --- 1. Version consistency across the three files BRAT reads. ---
const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const versions = readJson("versions.json");
const version = manifest.version;
if (!version) die("manifest.json has no version");
if (pkg.version !== version)
  die(`package.json version (${pkg.version}) != manifest.json version (${version}) — run \`make version V=${version}\``);
if (!versions[version])
  die(`versions.json has no entry for ${version} — run \`make version V=${version}\``);

// --- 2. Built artifacts present (the release assets). ---
const assets = ["main.js", "manifest.json", "styles.css"];
for (const f of assets) if (!existsSync(join(repo, f))) die(`missing ${f} — run \`npm run build\` first`);

// --- 3. Clean tree + tag/release not already taken. ---
if (git(["status", "--porcelain"])) die("working tree is dirty — commit or stash before releasing");
const tagExists = git(["tag", "--list", version]) === version;
if (tagExists) die(`git tag ${version} already exists — bump the version with \`make version V=<next>\``);
let releaseExists = false;
try {
  execFileSync("gh", ["release", "view", version, "-R", "omars-lab/review-md"], { stdio: "ignore" });
  releaseExists = true;
} catch {
  /* no such release — good */
}
if (releaseExists) die(`a GitHub release tagged ${version} already exists`);

const head = git(["rev-parse", "--short", "HEAD"]);
console.log(`release: review-md ${version} @ ${head}`);
console.log(`  assets: ${assets.join(", ")}`);

if (dryRun) {
  console.log("release: --dry-run OK — everything is consistent and ready to publish");
  process.exit(0);
}

// --- 4. Publish. gh creates the tag at HEAD; title == tag == manifest version. ---
const body =
  (notes ? notes + "\n\n" : "") +
  `Install with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add \`omars-lab/review-md\`.\n`;
execFileSync(
  "gh",
  ["release", "create", version, ...assets, "-R", "omars-lab/review-md", "--title", version, "--notes", body],
  { cwd: repo, stdio: "inherit" },
);

console.log(`\nreleased ${version}. BRAT users: add  omars-lab/review-md  (Command palette → BRAT: Add a beta plugin).`);

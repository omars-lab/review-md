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
import { readFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join, basename } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const CLI_OUT = join(repo, "plugins/review-md/bin/reviews.mjs");
const MCP_OUT = join(repo, "plugins/review-md/bin/reviews-mcp.mjs");
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
// main.js + manifest.json + styles.css are what BRAT and the store download, one by
// one. The zip holds the same three in a review-md/ folder, for a manual install:
// unzip into <vault>/.obsidian/plugins/. reviews.mjs is the standalone CLI;
// reviews-mcp.mjs, kept beside it, serves the same commands as MCP tools.
const pluginFiles = ["main.js", "manifest.json", "styles.css"];
for (const f of pluginFiles) if (!existsSync(join(repo, f))) die(`missing ${f} — run \`npm run build\` first`);
if (!existsSync(CLI_OUT)) die(`missing ${CLI_OUT} — run \`make cli\` first`);

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

// --- 4. The Claude Code plugin ships from the same commit: its version must match. ---
const claudePlugin = readJson("plugins/review-md/.claude-plugin/plugin.json");
if (claudePlugin.version !== version)
  die(`plugins/review-md/.claude-plugin/plugin.json version (${claudePlugin.version}) != ${version} — run \`make version V=${version}\``);
try {
  execFileSync("claude", ["plugin", "validate", repo], { stdio: "ignore" });
} catch (err) {
  if (err.code !== "ENOENT") die("`claude plugin validate .` failed — run it to see why");
  console.log("  (claude not on PATH — skipped plugin validate)");
}

// --- 5. Stage the zip + CLI in dist/ (gitignored). ---
const dist = join(repo, "dist");
const zipName = `review-md-${version}.zip`;
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "review-md"), { recursive: true });
for (const f of pluginFiles) copyFileSync(join(repo, f), join(dist, "review-md", f));
execFileSync("zip", ["-qr", zipName, "review-md"], { cwd: dist });
copyFileSync(CLI_OUT, join(dist, "reviews.mjs"));
copyFileSync(MCP_OUT, join(dist, "reviews-mcp.mjs"));
const assets = [...pluginFiles, join(dist, zipName), join(dist, "reviews.mjs"), join(dist, "reviews-mcp.mjs")];

const head = git(["rev-parse", "--short", "HEAD"]);
console.log(`release: review-md ${version} @ ${head}`);
console.log(`  assets: ${assets.map((a) => basename(a)).join(", ")}`);
console.log(`  claude plugin: review-md ${claudePlugin.version} (installs from main)`);

if (dryRun) {
  console.log("release: --dry-run OK — everything is consistent and ready to publish");
  process.exit(0);
}

// --- 6. Publish. gh creates the tag at HEAD; title == tag == manifest version. ---
const body =
  (notes ? notes + "\n\n" : "") +
  [
    "**Obsidian plugin**",
    `- [BRAT](https://github.com/TfTHacker/obsidian42-brat): add \`omars-lab/review-md\` (auto-updates).`,
    `- Or by hand: unzip \`${zipName}\` into \`<vault>/.obsidian/plugins/\`, then enable Review MD.`,
    "",
    "**Claude Code plugin** (the `reviews` skill + CLI)",
    "```",
    "/plugin marketplace add omars-lab/review-md",
    "/plugin install review-md@review-md",
    "```",
    "",
    "**CLI only**: `reviews.mjs` needs just Node 18+ — `node reviews.mjs help`.",
    "**MCP tools** for any MCP host: `reviews-mcp.mjs` next to `reviews.mjs`, run as `node reviews-mcp.mjs`.",
    "",
  ].join("\n");
execFileSync(
  "gh",
  ["release", "create", version, ...assets, "-R", "omars-lab/review-md", "--title", version, "--notes", body],
  { cwd: repo, stdio: "inherit" },
);

console.log(`\nreleased ${version}. BRAT users: add  omars-lab/review-md  (Command palette → BRAT: Add a beta plugin).`);

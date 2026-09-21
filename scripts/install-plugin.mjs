#!/usr/bin/env node
/**
 * Copy the built plugin into an arbitrary Obsidian vault, for a real (non-dev)
 * install. Unlike install-dev.mjs (which SYMLINKS into the repo's docs/ vault so
 * `npm run dev` rebuilds propagate), this makes real file copies so the target
 * vault keeps working independently of the repo.
 *
 * Run:  npm run build && node scripts/install-plugin.mjs <path-to-vault>
 *   or: make install-vault VAULT=<path-to-vault>
 */
import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const vaultArg = process.argv[2] || process.env.VAULT;

if (!vaultArg) {
  console.error("usage: node scripts/install-plugin.mjs <path-to-vault>   (or: make install-vault VAULT=<path>)");
  process.exit(1);
}

const vault = resolve(vaultArg);
if (!existsSync(vault) || !statSync(vault).isDirectory()) {
  console.error(`not a directory: ${vault}`);
  process.exit(1);
}
if (!existsSync(join(vault, ".obsidian"))) {
  // Not fatal — a folder becomes a vault the first time Obsidian opens it — but
  // usually a wrong path, so warn loudly rather than silently seed a stray dir.
  console.warn(`warning: ${vault} has no .obsidian/ — is this really a vault? Continuing anyway.`);
}

const files = ["main.js", "manifest.json", "styles.css"];
for (const f of files) {
  if (!existsSync(join(repo, f))) {
    console.error(`missing ${f} — run \`npm run build\` first`);
    process.exit(1);
  }
}

const pluginDir = join(vault, ".obsidian", "plugins", "review-md");
mkdirSync(pluginDir, { recursive: true });
for (const f of files) copyFileSync(join(repo, f), join(pluginDir, f));

console.log(`installed review-md → ${pluginDir}`);
console.log("next: Obsidian → Settings → Community plugins → enable 'Review MD'");
console.log("      (turn OFF Restricted Mode first if this is a fresh vault)");

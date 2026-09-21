#!/usr/bin/env node
/**
 * Bump the plugin version across the three files BRAT / Obsidian read, keeping
 * them in lock-step (a mismatch is the classic BRAT footgun — the release tag
 * must equal manifest.json's version exactly, no `v` prefix):
 *   - package.json     "version"
 *   - manifest.json    "version"          (source of truth for BRAT + the store)
 *   - versions.json    { <version>: <minAppVersion> }   (from manifest.minAppVersion)
 *
 * Run:  node scripts/version.mjs <new-version>   (or: make version V=<new-version>)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("usage: node scripts/version.mjs <new-version>   e.g. 1.0.0 or 1.0.0-beta.1");
  process.exit(1);
}

const readJson = (f) => JSON.parse(readFileSync(join(repo, f), "utf8"));
const writeJson = (f, o) => writeFileSync(join(repo, f), JSON.stringify(o, null, 2) + "\n");

const pkg = readJson("package.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");

pkg.version = next;
manifest.version = next;
versions[next] = manifest.minAppVersion;

writeJson("package.json", pkg);
writeJson("manifest.json", manifest);
writeJson("versions.json", versions);

console.log(`version → ${next} (package.json, manifest.json, versions.json[${next}]=${manifest.minAppVersion})`);
console.log("next: commit these, then `make release` to cut the GitHub release BRAT installs from");

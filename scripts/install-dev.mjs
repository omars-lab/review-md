#!/usr/bin/env node
/**
 * Set up a self-contained Obsidian dev vault at ./.dev-vault (gitignored) and
 * install the built plugin into it via symlinks (so `npm run dev` rebuilds
 * propagate without re-copying).
 *
 * Run:  npm run build && npm run install:dev
 * Then: open Obsidian → "Open folder as vault" → <repo>/.dev-vault
 *       Settings → Community plugins → turn OFF Restricted Mode (GUI-only).
 *       "Review MD" is pre-listed as enabled; trust + enable when prompted.
 */
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const vault = join(repo, ".dev-vault");
const pluginDir = join(vault, ".obsidian", "plugins", "review-md");

for (const f of ["main.js", "manifest.json", "styles.css"]) {
  if (!existsSync(join(repo, f))) {
    console.error(`missing ${f} — run \`npm run build\` first`);
    process.exit(1);
  }
}

mkdirSync(pluginDir, { recursive: true });

// Symlink the built artifacts into the vault's plugin folder.
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  const dest = join(pluginDir, f);
  if (existsSync(dest)) rmSync(dest);
  symlinkSync(join(repo, f), dest);
}

// Pre-enable the plugin (still gated by Restricted Mode, which is GUI-only).
writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["review-md"], null, 2) + "\n");

// A sample note exercising the render features we anchor comments to.
const sample = `---
title: Sample review target
review:
  uid: sampleuid01
---

# Radial band colour design

A paragraph to click on and anchor a comment thread. It references a footnote[^why].

## A diagram

\`\`\`mermaid
flowchart LR
  A[write-design] --> B[render]
  B --> C[human comments]
  C --> D[review-design]
  D --> A
\`\`\`

## An image

![a plate](plate.png)

Another paragraph, with a block ref target. ^anchor-me

[^why]: Because footnotes are one of the two render features VS Code preview drops.
`;
writeFileSync(join(vault, "sample.md"), sample);

// A tiny placeholder PNG so the image renders (1x1 transparent).
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
writeFileSync(join(vault, "plate.png"), png);

try { chmodSync(join(vault, "sample.md"), 0o644); } catch {}

console.log("dev vault ready at .dev-vault");
console.log("next:");
console.log("  1. Obsidian → Open folder as vault → " + vault);
console.log("  2. Settings → Community plugins → turn OFF Restricted Mode, trust + enable 'Review MD'");
console.log("  3. Run POC-1: open a terminal and run");
console.log("       open 'obsidian://review-md?vault=.dev-vault&file=sample.md&thread=anchor-me'");
console.log("  4. Run POC-4: Command palette → 'Review MD: POC-4 seed & verify frontmatter threads'");
console.log("     then open .dev-vault/POC-4-report.md to read PASS/FAIL.");

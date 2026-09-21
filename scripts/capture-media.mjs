#!/usr/bin/env node
// capture-media.mjs — drive the review-md plugin in .dev-vault and capture
// screenshots + GIFs for the README / marketing. One subcommand per primitive so
// the `demo-media` skill orchestrates captures with small, stable, allow-listable
// calls (no inline heredocs — the variation is a flag, per the repo conventions).
//
// Two capture paths, both use these same primitives:
//   • manual     — drive the UI with `cmd` (Obsidian command palette IDs) + `eval`.
//   • x-callback — drive it with `open`/`reply` (obsidian://review-md-* deep links).
//
// Subcommands:
//   doctor                               check obsidian-cli, gif tools, built plugin
//   reload                               reload the review-md plugin in the vault
//   cmd     --id <command-id>            run an Obsidian command (manual path)
//   eval    --code <js> | --file <path>  run JS in the renderer, print its result
//   open    --file <f> [--thread <t>]    fire obsidian://review-md-open (x-callback)
//   reply   --file <f> --thread <t> --body <b> [--author <a>]   review-md-reply link
//   shot    --out <png> [--selector <css>] [--pad <n>] [--settle <ms>]
//                                        full-window screenshot, cropped to a
//                                        selector's bounding box when given
//   frames  --dir <d> --name <p> --count <n> [--interval <ms>] [--selector <css>]
//                                        burst of N screenshots (time-lapse frames)
//   gif     --frames <dir|glob> --out <gif> [--fps <n>] [--width <n>] [--quality <n>]
//                                        stitch PNG frames into a GIF via gifski
//
// Common flags: --vault <name> (default .dev-vault), --cli <path>, --quiet.
//
// Examples:
//   node scripts/capture-media.mjs doctor
//   node scripts/capture-media.mjs cmd --id review-md:toggle-comment-mode
//   node scripts/capture-media.mjs open --file design.md --thread d1a2b3
//   node scripts/capture-media.mjs shot --out docs/media/sidebar.png \
//        --selector '.review-md-comments-view' --pad 8 --settle 400
//   node scripts/capture-media.mjs gif --frames docs/media/frames/comment \
//        --out docs/media/comment.gif --fps 12 --width 900

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_CLI = "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli";
const PLUGIN_ID = "review-md";

// ---- arg parsing -----------------------------------------------------------
const argv = process.argv.slice(2);
const sub = argv[0];
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else { flags[key] = next; i++; }
  }
}
const VAULT = flags.vault || ".dev-vault";
const CLI = flags.cli || process.env.OBSIDIAN_CLI || DEFAULT_CLI;
const QUIET = !!flags.quiet;

function log(...m) { if (!QUIET) console.error("[capture-media]", ...m); }
function die(msg, code = 1) { console.error("[capture-media] ERROR:", msg); process.exit(code); }
function need(name) { if (flags[name] === undefined) die(`missing --${name}`); return flags[name]; }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); }
function has(bin) { try { execFileSync("command", ["-v", bin], { shell: "/bin/zsh" }); return true; } catch { return false; } }

// ---- obsidian-cli wrapper --------------------------------------------------
// obsidian-cli takes `<subcommand> key=value ...` positional tokens.
function cli(subcmd, kv = {}, { capture = true } = {}) {
  const args = [subcmd, `vault=${VAULT}`];
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined || v === null || v === false) continue;
    args.push(v === true ? k : `${k}=${v}`);
  }
  try {
    const out = execFileSync(CLI, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return capture ? out : "";
  } catch (e) {
    const stderr = (e.stderr || "").toString().trim();
    die(`obsidian-cli ${subcmd} failed: ${stderr || e.message}`);
  }
}

function reload() { cli("plugin:reload", { id: PLUGIN_ID }); log("reloaded", PLUGIN_ID); }

// Run JS in the renderer. Wrap in an async IIFE so `await` is legal (obsidian-cli
// eval does not wrap for you) and the last expression is returned as a string.
function evalJs(code) {
  const wrapped = `(async () => { return (${code}); })()`;
  return cli("eval", { code: wrapped }).trim();
}

// ---- x-callback (deep-link) primitives -------------------------------------
function xcallback(action, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `obsidian://${action}?${qs}`;
  log("open", url);
  try {
    execFileSync("open", [url]);
  } catch (e) {
    die(`open '${url}' failed: ${e.message}`);
  }
  return url;
}

// ---- screenshot + crop -----------------------------------------------------
function rectFor(selector) {
  const code = `(() => { const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return "null";
    const r = e.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 });
  })()`;
  const out = evalJs(code);
  const m = out.match(/\{[^}]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function ensureDir(p) { mkdirSync(dirname(resolve(p)), { recursive: true }); }

function screenshot(outPath, { selector, pad = 0, settle = 0 } = {}) {
  if (settle) sleepMs(Number(settle));
  ensureDir(outPath);
  const abs = resolve(outPath);
  // Full-window PNG first (dev:screenshot only does the whole window).
  const raw = selector ? join(tmpdir(), `capture-media-${Date.now()}.png`) : abs;
  cli("dev:screenshot", { path: resolve(raw) });
  if (!existsSync(raw)) die(`screenshot not written: ${raw}`);
  if (!selector) { log("shot", outPath); return outPath; }

  const rect = rectFor(selector);
  if (!rect) { die(`selector not found for crop: ${selector}`); }
  const dpr = rect.dpr || 1;
  const p = Number(pad) || 0;
  const x = Math.max(0, Math.round((rect.x - p) * dpr));
  const y = Math.max(0, Math.round((rect.y - p) * dpr));
  const w = Math.round((rect.w + p * 2) * dpr);
  const h = Math.round((rect.h + p * 2) * dpr);
  const cropper = has("magick") ? ["magick", raw] : ["convert", raw];
  try {
    execFileSync(cropper[0], [cropper[1], "-crop", `${w}x${h}+${x}+${y}`, "+repage", abs]);
  } catch (e) {
    die(`crop failed: ${e.message}`);
  } finally {
    try { rmSync(raw); } catch {}
  }
  log("shot", outPath, `(cropped ${w}x${h} @${x},${y})`);
  return outPath;
}

// ---- gif assembly ----------------------------------------------------------
function collectFrames(spec) {
  // spec is a directory (all *.png inside, sorted) or a glob-ish prefix.
  const abs = resolve(spec);
  if (existsSync(abs) && readdirSync(abs, { withFileTypes: true })) {
    try {
      const entries = readdirSync(abs).filter((f) => f.endsWith(".png")).sort();
      if (entries.length) return entries.map((f) => join(abs, f));
    } catch {}
  }
  // treat as <dir>/<prefix> — list matching prefix in parent dir
  const dir = dirname(abs);
  const prefix = abs.slice(dir.length + 1);
  const entries = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".png")).sort();
  return entries.map((f) => join(dir, f));
}

function gifWithGifski(outPath, files, { fps, width, quality }) {
  const args = ["--fps", String(fps), "--quality", String(quality)];
  if (width) args.push("-W", String(width));
  args.push("-o", resolve(outPath), ...files);
  execFileSync("gifski", args, { stdio: QUIET ? "ignore" : "inherit" });
}

// ffmpeg via the concat demuxer (handles arbitrary frame filenames) + a single-pass
// palettegen/paletteuse for clean colours. More robust than gifski, which in some
// brew setups is dynamically linked against a mismatched ffmpeg and aborts.
function gifWithFfmpeg(outPath, files, { fps, width }) {
  const dur = (1 / fps).toFixed(4);
  const list = files.map((f) => `file '${resolve(f)}'\nduration ${dur}`).join("\n")
    + `\nfile '${resolve(files[files.length - 1])}'\n`; // repeat last so its duration applies
  const listPath = join(tmpdir(), `capture-media-frames-${Date.now()}.txt`);
  writeFileSync(listPath, list);
  const scale = width ? `scale=${width}:-1:flags=lanczos,` : "";
  const vf = `${scale}split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`;
  try {
    execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-vf", vf, resolve(outPath)],
      { stdio: QUIET ? "ignore" : "inherit" });
  } finally {
    try { rmSync(listPath); } catch {}
  }
}

function buildGif(outPath, { frames, fps = 12, width, quality = 90 } = {}) {
  const files = collectFrames(frames);
  if (!files.length) die(`no PNG frames found under: ${frames}`);
  ensureDir(outPath);
  const tryOrder = has("gifski") ? ["gifski", "ffmpeg"] : ["ffmpeg"];
  let lastErr;
  for (const tool of tryOrder) {
    try {
      if (tool === "gifski") gifWithGifski(outPath, files, { fps, width, quality });
      else if (has("ffmpeg")) gifWithFfmpeg(outPath, files, { fps, width });
      else continue;
      if (existsSync(outPath)) { log("gif", outPath, `(${files.length} frames @ ${fps}fps via ${tool})`); return outPath; }
    } catch (e) {
      lastErr = e;
      log(`${tool} failed (${String(e.message).split("\n")[0]}) — falling back`);
    }
  }
  die(`gif assembly failed (need a working gifski or ffmpeg): ${lastErr?.message ?? "no encoder"}`);
}

// ---- doctor ----------------------------------------------------------------
function doctor() {
  const rows = [];
  rows.push(["obsidian-cli", existsSync(CLI) ? `ok  ${CLI}` : `MISSING ${CLI}`]);
  // GIF encoder: ffmpeg is the primary path, gifski an optional fast path. Only
  // fail if NEITHER is present (a broken/mismatched gifski falls back to ffmpeg).
  const gifEncoder = has("ffmpeg") || has("gifski");
  rows.push(["gif encoder", gifEncoder ? `ok  (ffmpeg=${has("ffmpeg")} gifski=${has("gifski")})` : "MISSING (brew install ffmpeg)"]);
  rows.push(["magick", has("magick") ? "ok" : "MISSING (needed for --selector crops)"]);
  const pluginMain = join(VAULT, ".obsidian", "plugins", PLUGIN_ID, "main.js");
  rows.push(["built plugin", existsSync(pluginMain) ? `ok  ${pluginMain}` : `MISSING ${pluginMain} (run npm run build && npm run install:dev)`]);
  const rootMain = "main.js";
  rows.push(["main.js bundle", existsSync(rootMain) ? "ok" : "MISSING (run npm run build)"]);
  let ok = true;
  for (const [k, v] of rows) { if (v.startsWith("MISSING")) ok = false; console.log(`  ${k.padEnd(16)} ${v}`); }
  process.exit(ok ? 0 : 1);
}

// ---- dispatch --------------------------------------------------------------
switch (sub) {
  case "doctor": doctor(); break;
  case "reload": reload(); break;
  case "cmd": cli("command", { id: need("id") }); log("cmd", flags.id); break;
  case "eval": {
    const code = flags.file ? readFileSync(resolve(flags.file), "utf8") : need("code");
    console.log(evalJs(code));
    break;
  }
  case "open": xcallback("review-md-open", { vault: VAULT, file: need("file"), thread: flags.thread }); break;
  case "reply": xcallback("review-md-reply", {
    vault: VAULT, file: need("file"), thread: need("thread"), body: need("body"), author: flags.author,
  }); break;
  case "shot": screenshot(need("out"), { selector: flags.selector, pad: flags.pad, settle: flags.settle }); break;
  case "frames": {
    const dir = need("dir"), name = need("name"), count = Number(need("count"));
    const interval = Number(flags.interval || 300);
    mkdirSync(resolve(dir), { recursive: true });
    for (let i = 0; i < count; i++) {
      const out = join(dir, `${name}-${String(i).padStart(3, "0")}.png`);
      screenshot(out, { selector: flags.selector, pad: flags.pad });
      if (i < count - 1) sleepMs(interval);
    }
    break;
  }
  case "gif": buildGif(need("out"), { frames: need("frames"), fps: flags.fps, width: flags.width, quality: flags.quality }); break;
  default:
    console.error(`Usage: node scripts/capture-media.mjs <doctor|reload|cmd|eval|open|reply|shot|frames|gif> [flags]
See the header of this file (or the demo-media skill) for the full flag list.`);
    process.exit(sub ? 1 : 0);
}

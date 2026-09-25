#!/usr/bin/env node
// setup-vault — check / install / verify review-md in an Obsidian vault, the way a user
// gets it: through BRAT, from the published GitHub release (never from our local build).
//
//   node scripts/setup-vault.mjs check   --vault <abs path>  [--user-data-dir <dir>]
//   node scripts/setup-vault.mjs install --vault <abs path>  [--token-name <secret-name>]
//   node scripts/setup-vault.mjs verify  --vault <name>      [--screenshot <png>]
//
// --token-name is for while the repo is private: it stores `gh auth token` in Obsidian's
// secret storage under that name and tells BRAT to use it for review-md.
//
// check    Writes nothing. Prints one row per requirement and exits 1 if any is missing:
//          Obsidian app + version, vault registered, restricted mode off, BRAT installed +
//          enabled, review-md installed + enabled, installed version vs the latest release,
//          and whether BRAT tracks review-md (its data.json `pluginList`).
// install  Idempotent. Puts the latest BRAT release into the vault if missing, turns off
//          restricted mode, enables BRAT, then asks BRAT itself to add omars-lab/review-md
//          (BRAT downloads the release, writes the plugin, records it in pluginList and
//          enables it). Needs the vault open in a running Obsidian with the CLI turned on.
// verify   Runs in the live app and prints PASS/FAIL per check (exit 1 on any FAIL): plugin
//          loaded + version, commands registered, comments view opens, and a round-trip —
//          create a scratch doc, add a thread, confirm the sidecar exists + validates and
//          the thread shows in the panel, then delete both files.
//
// BRAT internals this relies on (BRAT 2.x; re-check when BRAT changes):
//   - app.plugins.plugins["obsidian42-brat"].betaPlugins.addPlugin(repo, updatePluginFiles,
//     seeIfUpdatedOnly, reportIfNotUpdated, specifyVersion, forceReinstall,
//     enableAfterInstall, secretName) — the method its "Add a beta plugin" modal calls.
//     We pass (repo, false, false, false, "", false, true, tokenName): fresh install,
//     latest release, enable, and the optional secret-storage token name.
//   - <vault>/.obsidian/plugins/obsidian42-brat/data.json `pluginList` — the repos BRAT
//     tracks for auto-update; addPlugin appends to it.
// Obsidian internals: app.plugins.isEnabled()/setEnable(true) (restricted mode, stored in
// localStorage `enable-plugin-<appId>`), loadManifests(), enablePluginAndSave(id). Turning
// restricted mode off this way skips the "Trust author" dialog — it only pops at startup
// when plugins exist and the choice was never made.
//
// The CLI talks to whichever Obsidian instance bound ~/.obsidian-cli.sock last, and only
// if Settings → General → Command line interface is on (`"cli": true` in the instance's
// obsidian.json). Every obsidian-cli / osascript call runs under a timeout; logs go to
// stderr as `<utc> pid=<n> ev=<event> key=value`.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "review-md";
const PLUGIN_REPO = "omars-lab/review-md";
const BRAT_ID = "obsidian42-brat";
const BRAT_REPO = "TfTHacker/obsidian42-brat";
const APP = "/Applications/Obsidian.app";
const CLI = process.env.OBSIDIAN_CLI || `${APP}/Contents/MacOS/obsidian-cli`;
const CLI_TIMEOUT_MS = 30_000;
const OSA_TIMEOUT_MS = 10_000;
const NET_TIMEOUT_MS = 30_000;
const SCRATCH_DOC = "review-md-setup-check.md";
const SCRATCH_SIDECAR = ".review-md-setup-check.comments.md";
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

// ---- logging ---------------------------------------------------------------------------

function log(ev, kv = {}) {
  const parts = [new Date().toISOString(), `pid=${process.pid}`, `ev=${ev}`];
  for (const [k, v] of Object.entries(kv)) {
    const s = String(v);
    parts.push(k === "msg" || /\s/.test(s) ? `${k}=${JSON.stringify(s)}` : `${k}=${s}`);
  }
  process.stderr.write(parts.join(" ") + "\n");
}

function die(msg, code = 2) {
  log("error", { msg });
  process.exit(code);
}

// ---- args ------------------------------------------------------------------------------

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) die(`unexpected argument: ${a}`);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[a.slice(2)] = true; // bare flag
    else {
      opts[a.slice(2)] = next;
      i++;
    }
  }
  return { cmd, opts };
}

// ---- process helpers (node-side timeouts: macOS has no `timeout`) ----------------------

function run(file, args, timeoutMs, ev) {
  log(`${ev}_start`, { args: args[0] });
  const r = spawnSync(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM") {
    log(`${ev}_timeout`, { ms: timeoutMs });
    return { ok: false, out: "", err: "timeout" };
  }
  if (r.error) {
    log(`${ev}_fail`, { msg: r.error.message });
    return { ok: false, out: "", err: r.error.message };
  }
  log(`${ev}_end`, { status: r.status });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Run a JS expression in the vault's app context; returns the parsed JSON result.
 *  `code` must be a single expression; it's wrapped in an async IIFE and JSON-encoded. */
function evalJs(vault, code) {
  const wrapped = `(async () => JSON.stringify(await (${code})))()`;
  const r = run(CLI, ["eval", `vault=${vault}`, `code=${wrapped}`], CLI_TIMEOUT_MS, "cli");
  if (!r.ok) throw new Error(`obsidian-cli failed: ${r.err.trim() || r.out.trim()}`);
  // The CLI echoes the app's console lines first; the result is the last `=> ` line.
  const out = r.out.trim();
  const at = out.lastIndexOf("\n=> ");
  const res = out.startsWith("=> ") && at < 0 ? out : at >= 0 ? out.slice(at + 1) : null;
  if (!res) throw new Error(out || "obsidian-cli returned nothing");
  const body = res.slice(3);
  return body === "undefined" ? undefined : JSON.parse(body);
}

function activateObsidian() {
  run("osascript", ["-e", 'tell application "Obsidian" to activate'], OSA_TIMEOUT_MS, "osascript");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Poll `fn` until it returns truthy or `ms` elapses. */
function waitFor(fn, ms, stepMs = 500) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() > end) return null;
    sleepMs(stepMs);
  }
}

// ---- file-side facts -------------------------------------------------------------------

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function appVersion() {
  const r = run("defaults", ["read", `${APP}/Contents/Info.plist`, "CFBundleShortVersionString"], OSA_TIMEOUT_MS, "plist");
  return r.ok ? r.out.trim() : null;
}

/** Latest release of `repo`: `gh` first (sees private repos when authenticated), then the
 *  public API. Returns { tag_name } or null. */
async function latestRelease(repo) {
  const r = run("gh", ["release", "view", "-R", repo, "--json", "tagName"], NET_TIMEOUT_MS, "gh");
  if (r.ok) return { tag_name: JSON.parse(r.out).tagName };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
  log("net_start", { url: `repos/${repo}/releases/latest` });
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      signal: ctl.signal,
      headers: { accept: "application/vnd.github+json" },
    });
    log("net_end", { status: res.status });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    log(ctl.signal.aborted ? "net_timeout" : "net_fail", { msg: e.message });
    return null;
  } finally {
    clearTimeout(t);
  }
}

function pluginFacts(vault, id) {
  const dir = join(vault, ".obsidian", "plugins", id);
  const manifest = readJson(join(dir, "manifest.json"));
  const enabledList = readJson(join(vault, ".obsidian", "community-plugins.json"), []);
  return {
    installed: !!manifest && existsSync(join(dir, "main.js")),
    version: manifest?.version ?? null,
    enabled: Array.isArray(enabledList) && enabledList.includes(id),
    data: readJson(join(dir, "data.json")),
  };
}

function registeredVault(udd, vault) {
  const reg = readJson(join(udd, "obsidian.json"));
  if (!reg) return { registered: false, cli: false };
  const hit = Object.values(reg.vaults ?? {}).find((v) => resolve(v.path) === resolve(vault));
  return { registered: !!hit, cli: reg.cli === true };
}

// ---- check -----------------------------------------------------------------------------

async function cmdCheck(opts) {
  const vault = opts.vault && resolve(opts.vault);
  if (!vault) die("check needs --vault <abs path>");
  if (!existsSync(vault)) die(`vault not found: ${vault}`);
  const udd = opts["user-data-dir"] || join(homedir(), "Library", "Application Support", "obsidian");
  const name = basename(vault);
  const rows = [];
  const row = (item, ok, detail) => rows.push({ item, ok, detail });

  const ver = existsSync(APP) ? appVersion() : null;
  row("Obsidian app", !!ver, ver ? `v${ver}` : `not found at ${APP}`);

  const reg = registeredVault(udd, vault);
  row("vault registered", reg.registered, reg.registered ? `in ${join(udd, "obsidian.json")}` : `not in ${join(udd, "obsidian.json")}`);

  // Restricted mode lives in the app's localStorage, so only the live app can say.
  let restricted = "app not reachable";
  let restrictedOk = false;
  try {
    const on = evalJs(name, "app.plugins.isEnabled()");
    restrictedOk = on === true;
    restricted = on ? "off (community plugins on)" : "ON — community plugins disabled";
  } catch (e) {
    restricted = `unknown: ${e.message.split("\n")[0]}`;
  }
  row("restricted mode off", restrictedOk, restricted);

  const brat = pluginFacts(vault, BRAT_ID);
  row("BRAT installed", brat.installed, brat.version ? `v${brat.version}` : "missing");
  row("BRAT enabled", brat.enabled, brat.enabled ? "in community-plugins.json" : "not enabled");

  const rm = pluginFacts(vault, PLUGIN_ID);
  row("review-md installed", rm.installed, rm.version ? `v${rm.version}` : "missing");
  row("review-md enabled", rm.enabled, rm.enabled ? "in community-plugins.json" : "not enabled");

  const rel = await latestRelease(PLUGIN_REPO);
  const latest = rel?.tag_name ?? null;
  row(
    "review-md is latest",
    !!latest && rm.version === latest,
    latest ? `installed ${rm.version ?? "—"}, latest release ${latest}` : "could not read latest release",
  );

  const tracked = Array.isArray(brat.data?.pluginList) && brat.data.pluginList.includes(PLUGIN_REPO);
  row("BRAT tracks review-md", tracked, tracked ? `${PLUGIN_REPO} in pluginList` : "not in BRAT pluginList");

  const w = Math.max(...rows.map((r) => r.item.length));
  for (const r of rows) console.log(`${r.ok ? "OK     " : "MISSING"}  ${r.item.padEnd(w)}  ${r.detail}`);
  const missing = rows.filter((r) => !r.ok).length;
  log("check_done", { missing });
  process.exit(missing ? 1 : 0);
}

// ---- install ---------------------------------------------------------------------------

async function download(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
  log("net_start", { url });
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "follow" });
    log("net_end", { status: res.status });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    log(ctl.signal.aborted ? "net_timeout" : "net_fail", { msg: e.message });
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function installBratFiles(vault) {
  const dir = join(vault, ".obsidian", "plugins", BRAT_ID);
  mkdirSync(dir, { recursive: true });
  for (const asset of ["main.js", "manifest.json", "styles.css"]) {
    const body = await download(`https://github.com/${BRAT_REPO}/releases/latest/download/${asset}`);
    if (body === null) {
      if (asset === "styles.css") continue; // optional asset
      die(`could not download BRAT ${asset}`);
    }
    writeFileSync(join(dir, asset), body);
  }
  log("brat_files_written", { dir });
}

async function cmdInstall(opts) {
  const vault = opts.vault && resolve(opts.vault);
  if (!vault) die("install needs --vault <abs path>");
  if (!existsSync(join(vault, ".obsidian"))) die(`not an Obsidian vault (no .obsidian/): ${vault}`);
  const name = basename(vault);

  // The live app must answer before we change anything, so a half-install can't happen.
  try {
    evalJs(name, "app.vault.getName()");
  } catch (e) {
    die(
      `Obsidian isn't answering for vault "${name}": ${e.message.split("\n")[0]}\n` +
        "Open the vault in Obsidian and turn on Settings → General → Command line interface, then re-run.",
    );
  }

  if (!pluginFacts(vault, BRAT_ID).installed) await installBratFiles(vault);
  else log("brat_present", { version: pluginFacts(vault, BRAT_ID).version });

  // Restricted mode off → load manifests → enable BRAT (persists to community-plugins.json).
  const bratState = evalJs(
    name,
    `(async () => {
      if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
      await app.plugins.loadManifests();
      if (!app.plugins.enabledPlugins.has("${BRAT_ID}")) await app.plugins.enablePluginAndSave("${BRAT_ID}");
      return { restrictedOff: app.plugins.isEnabled(), bratLoaded: !!app.plugins.plugins["${BRAT_ID}"] };
    })()`,
  );
  log("brat_enabled", { restricted_off: bratState.restrictedOff, loaded: bratState.bratLoaded });
  if (!bratState.bratLoaded) die("BRAT did not load after enabling it");

  // Private repo: hand BRAT a GitHub token through Obsidian's secret storage. The token
  // comes from `gh auth token`, travels via a 0600 temp file (never argv or the log), and
  // BRAT records only the secret's *name* against the repo.
  const tokenName = opts["token-name"] || "";
  if (tokenName) {
    if (!/^[a-z0-9-]+$/.test(tokenName)) die("--token-name must match [a-z0-9-]+");
    const t = run("gh", ["auth", "token"], NET_TIMEOUT_MS, "gh");
    if (!t.ok || !t.out.trim()) die("`gh auth token` gave no token; run `gh auth login` first");
    const tmp = mkdtempSync(join(tmpdir(), "setup-vault-"));
    const file = join(tmp, "token");
    writeFileSync(file, t.out.trim(), { mode: 0o600 });
    try {
      evalJs(
        name,
        `(() => { const fs = require("fs"); app.secretStorage.setSecret("${tokenName}", fs.readFileSync(${JSON.stringify(file)}, "utf8")); return true; })()`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    log("token_stored", { name: tokenName });
  }

  const rm = pluginFacts(vault, PLUGIN_ID);
  const tracked = pluginFacts(vault, BRAT_ID).data?.pluginList?.includes(PLUGIN_REPO);
  if (rm.installed && tracked && rm.enabled) {
    log("review_md_present", { version: rm.version });
  } else {
    // BRAT's own add path: download the release, write files, add to pluginList, enable.
    const ok = evalJs(
      name,
      `app.plugins.plugins["${BRAT_ID}"].betaPlugins.addPlugin("${PLUGIN_REPO}", false, false, false, "", false, true, ${JSON.stringify(tokenName)})`,
    );
    log("brat_add_plugin", { result: ok });
    if (ok === false)
      die(
        `BRAT could not add ${PLUGIN_REPO} (see Obsidian's console). A 404 means GitHub can't see ` +
          "the repo: while it is private, re-run with --token-name <name> (uses `gh auth token`).",
      );
    const loaded = waitFor(() => evalJs(name, `!!app.plugins.plugins["${PLUGIN_ID}"]`), 20_000);
    if (!loaded) die("review-md did not load after BRAT installed it");
    // enableAfterInstall enables for the session; make it stick in community-plugins.json.
    evalJs(name, `app.plugins.enabledPlugins.has("${PLUGIN_ID}") || app.plugins.enablePluginAndSave("${PLUGIN_ID}")`);
  }
  const after = pluginFacts(vault, PLUGIN_ID);
  console.log(`installed review-md v${after.version} via BRAT into ${vault}`);
  log("install_done", { version: after.version });
}

// ---- verify ----------------------------------------------------------------------------

function cmdVerify(opts) {
  const name = opts.vault;
  if (!name) die("verify needs --vault <vault name>");
  const results = [];
  const check = (label, fn) => {
    try {
      const detail = fn();
      results.push({ label, pass: true, detail: detail ?? "" });
    } catch (e) {
      results.push({ label, pass: false, detail: e.message.split("\n")[0] });
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  let vaultPath = null;
  check("plugin loaded", () => {
    const s = evalJs(
      name,
      `({ loaded: !!app.plugins.plugins["${PLUGIN_ID}"], version: app.plugins.manifests["${PLUGIN_ID}"]?.version ?? null, base: app.vault.adapter.basePath })`,
    );
    vaultPath = s.base;
    assert(s.loaded, "review-md is not loaded");
    return `v${s.version}`;
  });

  check("commands registered", () => {
    const ids = evalJs(name, `Object.keys(app.commands.commands).filter((k) => k.startsWith("${PLUGIN_ID}:"))`);
    for (const want of ["open-comments-view", "toggle-comment-mode"])
      assert(ids.includes(`${PLUGIN_ID}:${want}`), `missing command ${PLUGIN_ID}:${want}`);
    return `${ids.length} commands`;
  });

  // Rendering is suspended while the window is in the background.
  activateObsidian();

  check("comments view opens", () => {
    const n = evalJs(
      name,
      `(async () => { await app.commands.executeCommandById("${PLUGIN_ID}:open-comments-view"); await new Promise((r) => setTimeout(r, 500)); return app.workspace.getLeavesOfType("review-md-comments").length; })()`,
    );
    assert(n > 0, "no review-md-comments leaf after running the command");
    return `${n} leaf`;
  });

  let threadId = null;
  check("round-trip: create thread", () => {
    threadId = evalJs(
      name,
      `(async () => {
        const p = app.plugins.plugins["${PLUGIN_ID}"];
        // Start clean: a doc + sidecar left by an earlier --keep run would show old threads.
        for (const p of ["${SCRATCH_DOC}", "${SCRATCH_SIDECAR}"]) if (await app.vault.adapter.exists(p)) await app.vault.adapter.remove(p);
        const f = await app.vault.create("${SCRATCH_DOC}", "# Setup check\\n\\nScratch doc written by setup-vault verify.\\n");
        await app.workspace.getLeaf(false).openFile(f);
        return await p.createThread(f, { type: "header", quote: "Setup check" }, { author: "setup-check", body: "round-trip" });
      })()`,
    );
    assert(typeof threadId === "string" && threadId, "createThread returned no id");
    return `thread ${threadId}`;
  });

  check("round-trip: sidecar validates", () => {
    assert(vaultPath, "vault path unknown");
    const sidecar = join(vaultPath, SCRATCH_SIDECAR);
    assert(waitFor(() => existsSync(sidecar), 5000), `no sidecar at ${SCRATCH_SIDECAR}`);
    const r = run(process.execPath, [join(REPO_ROOT, "scripts", "validate-comments.mjs"), sidecar], CLI_TIMEOUT_MS, "validate");
    assert(r.ok, `validate-comments failed: ${(r.out + r.err).trim().split("\n").pop()}`);
    return SCRATCH_SIDECAR;
  });

  check("round-trip: thread in panel", () => {
    assert(threadId, "no thread id");
    const shown = waitFor(
      () =>
        evalJs(
          name,
          `(async () => { const v = app.workspace.getLeavesOfType("review-md-comments")[0]?.view; if (v?.refresh) await v.refresh(); return !!v?.containerEl.querySelector('.review-md-thread[data-thread-id="${threadId}"]')?.offsetParent; })()`,
        ),
      10_000,
    );
    assert(shown, "thread card not rendered in the comments panel");
    return "card rendered";
  });

  if (opts.screenshot) {
    check("screenshot", () => {
      // Give the window a frame to paint the refreshed panel; an immediate capture can
      // return the pre-refresh frame (seen: an empty panel over a PASSing DOM check).
      sleepMs(1500);
      const r = run(CLI, ["dev:screenshot", `vault=${name}`, `path=${resolve(opts.screenshot)}`], CLI_TIMEOUT_MS, "cli");
      assert(r.ok, r.err.trim() || "dev:screenshot failed");
      return resolve(opts.screenshot);
    });
  }

  if (!opts.keep) check("round-trip: cleanup", () => {
    evalJs(
      name,
      `(async () => {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) if (leaf.view.file?.path === "${SCRATCH_DOC}") leaf.detach();
        const a = app.vault.adapter;
        for (const p of ["${SCRATCH_DOC}", "${SCRATCH_SIDECAR}"]) if (await a.exists(p)) await a.remove(p);
        return true;
      })()`,
    );
    assert(!vaultPath || (!existsSync(join(vaultPath, SCRATCH_DOC)) && !existsSync(join(vaultPath, SCRATCH_SIDECAR))), "scratch files still present");
    return "scratch doc + sidecar removed";
  });

  const w = Math.max(...results.map((r) => r.label.length));
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.label.padEnd(w)}  ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  log("verify_done", { failed });
  process.exit(failed ? 1 : 0);
}

// ---- main ------------------------------------------------------------------------------

const { cmd, opts } = parseArgs(process.argv.slice(2));
if (cmd === "check") await cmdCheck(opts);
else if (cmd === "install") await cmdInstall(opts);
else if (cmd === "verify") cmdVerify(opts);
else die("usage: setup-vault.mjs check|install --vault <abs path> [--user-data-dir <dir>] | verify --vault <name> [--screenshot <png>]");

#!/usr/bin/env node
// reviews-mcp — the `reviews` CLI as MCP tools, for agent hosts without a shell.
//
// A thin shell over reviews.mjs (next to this file): each tool call runs one CLI
// command and returns what it printed, so the CLI stays the one place the logic
// lives. Speaks MCP over stdio (newline-delimited JSON-RPC); no dependencies.
// Relative paths resolve against the directory the host starts the server in.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "reviews.mjs");
const PROTOCOL = "2025-06-18";

let version = "0.0.0";
try {
  version = JSON.parse(readFileSync(join(here, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
} catch {
  // Run from outside the plugin — the version is only informational.
}

const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const DOC = str("Path to the Markdown doc (relative to the working directory, or absolute)");
const ID = str("Thread id, as list/find print it");
const OPEN = bool("Open threads only");
const WAITING = str("Only threads where this name didn't write the last message — what's waiting on them");
const SINCE = str("Only threads with a message since then: an age (30m, 2h, 3d) or a date (2026-09-26)");
const AUTHOR = str('Who the message is from (default "claude")');
const VAULT = str("Obsidian vault name, when it can't be found from a .obsidian/ folder above the doc");

/** Each tool: what the agent sees, and how its arguments become CLI arguments. */
const TOOLS = {
  list: {
    description:
      "List the review threads on a doc, or on every doc under a folder: where each is anchored, open/resolved, OUTDATED when the doc changed since, and every message. Returns JSON.",
    properties: { target: str("A doc or a folder"), open: OPEN, text: str("Only threads mentioning these words"), waiting: WAITING, since: SINCE },
    required: ["target"],
    argv: (a) => ["list", a.target, "--json", ...flags(a, ["open", "text", "waiting", "since"])],
  },
  find: {
    description:
      "Find threads whose messages, authors or anchor mention some words (any case), across a folder. Resolved threads are included unless open is set. Returns JSON.",
    properties: { words: str("What to search for"), folder: str("Where to look (default: the working directory)"), open: OPEN, waiting: WAITING, since: SINCE },
    required: ["words"],
    argv: (a) => ["find", a.words, ...(a.folder ? [a.folder] : []), "--json", ...flags(a, ["open", "waiting", "since"])],
  },
  show: {
    description: "One thread in full, as JSON.",
    properties: { doc: DOC, id: ID },
    required: ["doc", "id"],
    argv: (a) => ["show", a.doc, a.id, "--json"],
  },
  diff: {
    description:
      "The commented passage as the reviewer saw it (from git) next to today's, with state changed / unchanged / gone — to tell whether a comment was already handled.",
    properties: { doc: DOC, id: ID },
    required: ["doc", "id"],
    argv: (a) => ["diff", a.doc, a.id, "--json"],
  },
  stats: {
    description: "Open, resolved and outdated thread counts per doc under a folder.",
    properties: { folder: str("Where to look (default: the working directory)") },
    required: [],
    argv: (a) => ["stats", ...(a.folder ? [a.folder] : []), "--json"],
  },
  reply: {
    description:
      "Reply to a thread. Goes through Obsidian (which must be running with the vault open) and returns once the reply is written; set resolve to close the thread too.",
    properties: { doc: DOC, id: ID, message: str("The reply"), author: AUTHOR, resolve: bool("Resolve the thread once the reply is in"), vault: VAULT },
    required: ["doc", "id", "message"],
    argv: (a) => ["reply", a.doc, a.id, a.message, ...flags(a, ["author", "resolve", "vault"])],
  },
  comment: {
    description:
      "Start a thread on a doc. Say where with exactly one of: quote (words in a passage or heading), node (a mermaid diagram box id), or from + to (a diagram arrow). Goes through Obsidian and returns the new thread's id once it's written.",
    properties: {
      doc: DOC,
      message: str("The comment"),
      quote: str("Words from the passage or heading to comment on"),
      node: str("A mermaid diagram box id"),
      from: str("A diagram arrow's start box id (with to)"),
      to: str("A diagram arrow's end box id (with from)"),
      author: AUTHOR,
      vault: VAULT,
    },
    required: ["doc", "message"],
    argv: (a) => ["comment", a.doc, a.message, ...flags(a, ["quote", "node", "from", "to", "author", "vault"])],
  },
  resolve: {
    description: "Resolve a thread once it's answered or fixed, or reopen it. Goes through Obsidian and returns once the change is written.",
    properties: { doc: DOC, id: ID, reopen: bool("Reopen instead of resolving"), vault: VAULT },
    required: ["doc", "id"],
    argv: (a) => ["resolve", a.doc, a.id, ...flags(a, ["reopen", "vault"])],
  },
};

/** CLI flags for the given argument names: booleans as bare flags, the rest with a value. */
function flags(args, names) {
  const out = [];
  for (const n of names) {
    const v = args[n];
    if (v === undefined || v === null || v === false || v === "") continue;
    out.push(`--${n}`, ...(v === true ? [] : [String(v)]));
  }
  return out;
}

function callTool(name, args = {}) {
  const tool = TOOLS[name];
  if (!tool) return Promise.resolve({ content: [{ type: "text", text: `no tool "${name}"` }], isError: true });
  const missing = tool.required.filter((k) => args[k] === undefined || args[k] === "");
  if (missing.length) return Promise.resolve({ content: [{ type: "text", text: `missing: ${missing.join(", ")}` }], isError: true });
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...tool.argv(args)], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = (err ? [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") || err.message : stdout).trimEnd();
      done({ content: [{ type: "text", text }], isError: !!err });
    });
  });
}

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "reviews", version },
        instructions:
          "Review threads on Markdown docs, left in Obsidian with the review-md plugin. Read with list/find/show/diff/stats; answer with reply, comment and resolve (these need Obsidian running with the vault open).",
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: { type: "object", properties: t.properties, required: t.required, additionalProperties: false },
        })),
      };
    case "tools/call":
      return callTool(msg.params?.name, msg.params?.arguments);
    default:
      throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
  }
}

const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "parse error" } });
  }
  if (msg.id === undefined) return; // A notification (e.g. notifications/initialized): nothing to answer.
  try {
    send({ id: msg.id, result: await handle(msg) });
  } catch (err) {
    send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});

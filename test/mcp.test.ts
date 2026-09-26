// The reviews MCP server, driven over stdio as a host would: handshake, tool list,
// and read-only calls against the repo's own docs/ review threads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

function startServer() {
  const child = spawn(process.execPath, ["plugins/review-md/bin/reviews-mcp.mjs"], { cwd: repo, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let next = 1;
  const call = (method: string, params?: object) =>
    new Promise<any>((done) => {
      const id = next++;
      waiting.set(id, done);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { call, notify, stop: () => child.kill() };
}

test("mcp: handshake, tool list, and read calls return the CLI's JSON", async () => {
  const s = startServer();
  try {
    const init = await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "reviews");
    assert.ok(init.result.capabilities.tools);
    s.notify("notifications/initialized");

    const { result } = await s.call("tools/list");
    const names = result.tools.map((t: any) => t.name);
    assert.deepEqual(names, ["list", "find", "show", "diff", "stats", "reply", "comment", "resolve"]);
    for (const t of result.tools) assert.equal(t.inputSchema.type, "object");

    const stats = await s.call("tools/call", { name: "stats", arguments: { folder: "docs" } });
    assert.equal(stats.result.isError, false);
    const rows = JSON.parse(stats.result.content[0].text);
    assert.ok(rows.some((r: any) => r.file.endsWith("design.md")));

    const list = await s.call("tools/call", { name: "list", arguments: { target: "docs/designs/design.md" } });
    const doc = JSON.parse(list.result.content[0].text);
    assert.ok(doc.threads.length > 0);

    const show = await s.call("tools/call", { name: "show", arguments: { doc: "docs/designs/design.md", id: doc.threads[0].id } });
    assert.equal(JSON.parse(show.result.content[0].text).id, doc.threads[0].id);
  } finally {
    s.stop();
  }
});

test("mcp: CLI failures come back as tool errors, unknown methods as protocol errors", async () => {
  const s = startServer();
  try {
    await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const missingThread = await s.call("tools/call", { name: "show", arguments: { doc: "docs/designs/design.md", id: "nope00" } });
    assert.equal(missingThread.result.isError, true);
    assert.match(missingThread.result.content[0].text, /no thread nope00/);

    const missingArg = await s.call("tools/call", { name: "reply", arguments: { doc: "docs/designs/design.md" } });
    assert.equal(missingArg.result.isError, true);
    assert.match(missingArg.result.content[0].text, /missing: id, message/);

    const bad = await s.call("resources/list");
    assert.equal(bad.error.code, -32601);
  } finally {
    s.stop();
  }
});

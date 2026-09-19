import { Plugin, Notice, TFile, normalizePath } from "obsidian";

/**
 * review-md — scaffold entry point.
 *
 * Minimal on purpose: it stands up the plugin, registers the
 * `obsidian://review-md` protocol handler (POC-1), and ships a self-reporting
 * POC-4 command that exercises processFrontMatter at scale. Both POCs write a
 * report note into the vault so results are verifiable from the file system
 * (no dev console needed). See docs/pocs/.
 */

const POC4_THREADS = 50;

interface ReviewMessage { author: string; ts: string; body: string; }
interface ReviewThread {
  id: string;
  anchor: Record<string, unknown>;
  resolved: boolean;
  messages: ReviewMessage[];
}

const mkId = () => Math.random().toString(36).substring(2, 8);

const POC4_BODIES = [
  "why radial here? seems arbitrary",
  'key: value looking text with "quotes" and a trailing colon:',
  "multi-line\nreply with a second line\n- and a bullet",
  "# looks like a heading and `code` and [a link](https://x.test)",
  "unicode ✓ diacritics ū ḥ ʿ emoji 🎯 keep intact",
];

function makePoc4Thread(i: number): ReviewThread {
  const id = mkId();
  const anchor =
    i % 5 === 0
      ? { type: "image", src: `img/plate-${i}.png` }
      : { type: "text", line: i * 3, blockId: id, quote: `anchored phrase number ${i}` };
  const messages: ReviewMessage[] = Array.from({ length: (i % 4) + 1 }, (_, m) => ({
    author: m % 2 === 0 ? "omar" : "claude",
    ts: new Date(Date.UTC(2026, 8, 19, 10, i % 60, m % 60)).toISOString(),
    body: POC4_BODIES[(i + m) % POC4_BODIES.length],
  }));
  return { id, anchor, resolved: i % 7 === 0, messages };
}

export default class ReviewMdPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log("[review-md] loaded");

    // obsidian://review-md?vault=V&file=path.md&thread=<id>[&action=reply&body=..&x-success=..&x-error=..]
    this.registerObsidianProtocolHandler("review-md", async (params) => {
      try {
        await this.handleUri(params);
        if (params["x-success"]) window.open(String(params["x-success"]));
      } catch (err) {
        console.error("[review-md] protocol error", err);
        if (params["x-error"]) window.open(String(params["x-error"]));
        else new Notice(`review-md: ${String(err)}`);
      }
    });

    this.addCommand({
      id: "poc4-seed-verify-frontmatter",
      name: "POC-4 seed & verify frontmatter threads",
      callback: () => void this.runPoc4(),
    });
  }

  onunload(): void {
    console.log("[review-md] unloaded");
  }

  /** POC-1: resolve + open the target file, jump to a thread's ^blockId, and self-report. */
  private async handleUri(params: Record<string, string>): Promise<void> {
    const filePath = params.file;
    if (!filePath) throw new Error("missing `file` param");

    const af = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(af instanceof TFile)) throw new Error(`file not found: ${filePath}`);

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af);

    if (params.thread) {
      this.app.workspace.openLinkText(`${af.path}#^${params.thread}`, af.path, false);
    }

    const report =
      `# POC-1 report\n\n- **RESULT: PASS** — protocol handler fired and opened the file.\n` +
      `- opened: \`${af.path}\`\n- thread param: \`${params.thread ?? "(none)"}\`\n` +
      `- action: \`${params.action ?? "open"}\`\n- x-success: \`${params["x-success"] ?? "(none)"}\`\n` +
      `- at: ${new Date().toISOString()}\n`;
    await this.writeVaultFile("POC-1-report.md", report);
    new Notice("review-md POC-1: opened " + af.path + " — see POC-1-report.md");
  }

  /** POC-4: write POC4_THREADS threads to the active file's frontmatter, read back, verify. */
  private async runPoc4(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice("POC-4: open a markdown file first"); return; }

    const threads = Array.from({ length: POC4_THREADS }, (_, i) => makePoc4Thread(i));
    const totalMessages = threads.reduce((n, t) => n + t.messages.length, 0);

    const t0 = performance.now();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.review = { ...(fm.review ?? {}), uid: (fm.review?.uid as string) ?? mkId() + mkId(), threads };
    });
    const writeMs = performance.now() - t0;

    // Read back through a no-op processFrontMatter (authoritative, not the cache).
    let readBack: ReviewThread[] = [];
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      readBack = (fm.review?.threads as ReviewThread[]) ?? [];
    });

    const countOk = readBack.length === POC4_THREADS;
    const sampleIn = threads.find((t) => t.messages.some((m) => m.body.includes("ū")));
    const sampleOut = readBack.find((t) => t.id === sampleIn?.id);
    const bodyOk =
      !!sampleIn && !!sampleOut &&
      sampleIn.messages.map((m) => m.body).join("|") === sampleOut.messages.map((m) => m.body).join("|");

    const size = (await this.app.vault.read(file)).length;
    const pass = countOk && bodyOk;

    const report =
      `# POC-4 report\n\n- **RESULT: ${pass ? "PASS" : "FAIL"}**\n` +
      `- target file: \`${file.path}\`\n` +
      `- threads written / read back: ${POC4_THREADS} / ${readBack.length} ${countOk ? "✓" : "✗"}\n` +
      `- total messages: ${totalMessages}\n` +
      `- unicode+newline body round-trip: ${bodyOk ? "OK ✓" : "DIVERGED ✗"}\n` +
      `- processFrontMatter write time: ${writeMs.toFixed(1)} ms\n` +
      `- resulting file size: ${size} bytes\n` +
      `- at: ${new Date().toISOString()}\n\n` +
      `> Also check by eye: does the Properties panel stay usable with ${POC4_THREADS} threads?\n` +
      `> Record that observation in docs/pocs/poc-4-frontmatter.md.\n`;
    await this.writeVaultFile("POC-4-report.md", report);
    new Notice(`review-md POC-4: ${pass ? "PASS" : "FAIL"} — see POC-4-report.md`);
  }

  private async writeVaultFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }
}

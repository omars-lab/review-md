import { Plugin, Notice, TFile, normalizePath } from "obsidian";

/**
 * review-md — scaffold entry point.
 *
 * This is intentionally minimal: it stands up the plugin, registers the
 * `obsidian://review-md` protocol handler, and proves the open-file path.
 * POC-1 (docs/pocs) validates the protocol + block-scroll + x-success loop
 * against this handler before the full comment/thread UI is built.
 */
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
  }

  onunload(): void {
    console.log("[review-md] unloaded");
  }

  /** Resolve the target file (by path for now; uid resolution comes with the data layer). */
  private async handleUri(params: Record<string, string>): Promise<void> {
    const filePath = params.file;
    if (!filePath) throw new Error("missing `file` param");

    const af = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(af instanceof TFile)) throw new Error(`file not found: ${filePath}`);

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af);

    // Block-scroll fallback: if a thread id is given, jump to its ^blockId anchor.
    if (params.thread) {
      this.app.workspace.openLinkText(`${af.path}#^${params.thread}`, af.path, false);
    }
  }
}

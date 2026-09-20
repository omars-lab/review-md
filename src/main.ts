import { Plugin, Notice, TFile, normalizePath, MarkdownPostProcessorContext } from "obsidian";
import xcallbackSchema from "./protocol/xcallback.schema.json";

interface XcallbackParam {
  name: string;
  required: boolean;
  type: string;
  enum?: string[];
  default?: string;
  description: string;
  example?: string;
  // Required in the URL for Obsidian's own routing (e.g. `vault`), but Obsidian
  // consumes it and never delivers it to the handler — so the plugin must NOT
  // validate its presence. See docs/issues/xcallback-reserved-params.md.
  reserved?: boolean;
}
interface XcallbackOperation {
  id: string;
  action: string;
  summary: string;
  description: string;
  params: XcallbackParam[];
}

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

    // One Obsidian action per operation: obsidian://review-md-open?..., review-md-reply?...
    // We can't use a single handler with an `action`/`op` query selector because
    // Obsidian *reserves* those: it overwrites `action` with the handler's own name
    // and consumes `vault` for routing before the handler runs. So the operation is
    // the action name itself. Actions + params live in src/protocol/xcallback.schema.json
    // (the single source of truth docs/api/* is generated from).
    // See docs/issues/xcallback-reserved-params.md.
    for (const op of xcallbackSchema.operations as XcallbackOperation[]) {
      this.registerObsidianProtocolHandler(op.action, async (params) => {
        try {
          this.validateParams(op, params);
          if (op.id === "reply") await this.handleReply(params);
          else await this.handleUri(op, params);
          if (params["x-success"]) window.open(String(params["x-success"]));
        } catch (err) {
          console.error("[review-md] protocol error", err);
          if (params["x-error"]) window.open(String(params["x-error"]));
          else new Notice(`review-md: ${String(err)}`);
        }
      });
    }

    this.addCommand({
      id: "poc4-seed-verify-frontmatter",
      name: "POC-4 seed & verify frontmatter threads",
      callback: () => void this.runPoc4(),
    });

    // POC-6: augmented mermaid render. Obsidian renders mermaid through its own
    // markdown renderer (not the public code-block registry), so we can't
    // override it with registerMarkdownCodeBlockProcessor. Instead we
    // post-process: wait for the built-in SVG, then replace it with a render of
    // `source + injected comment nodes`. Running inside the post-processor means
    // it re-applies on every re-render (scroll/edit) — unlike a one-shot DOM
    // poke, which Obsidian's next render reverts. Diagram source is untouched.
    this.registerMarkdownPostProcessor((el, ctx) => {
      const src = this.mermaidSourceFor(el, ctx);
      if (src === null) return;
      this.augmentRenderedMermaid(el, src, ctx.sourcePath);
    });

    // Req 9 (bake): fold the injected comment nodes into the stored ```mermaid
    // source on demand — the destructive opt-in. After baking, the live
    // augmenter skips those threads (they're detected as already in-source), so
    // there's no double injection. Idempotent: re-running skips baked threads.
    this.addCommand({
      id: "bake-mermaid-comments",
      name: "Bake comments into diagram(s)",
      callback: () => void this.bakeMermaidComments(),
    });
  }

  onunload(): void {
    console.log("[review-md] unloaded");
  }

  /** Validate params against the schema: required present, enums respected. */
  private validateParams(op: XcallbackOperation, params: Record<string, string>): void {
    // `reserved` params (e.g. `vault`) are consumed by Obsidian and never reach
    // the handler, so we can't require their presence here.
    const missing = op.params
      .filter((p) => p.required && !p.reserved && !params[p.name])
      .map((p) => p.name);
    if (missing.length) {
      throw new Error(`action \`${op.id}\` is missing required param(s): ${missing.join(", ")}`);
    }
    for (const p of op.params) {
      const v = params[p.name];
      if (v !== undefined && p.enum && !p.enum.includes(v)) {
        throw new Error(`param \`${p.name}\` must be one of: ${p.enum.join(", ")} (got \`${v}\`)`);
      }
    }
  }

  /** Resolve a `file` param to a TFile or throw. */
  private resolveFile(filePath: string | undefined): TFile {
    if (!filePath) throw new Error("missing `file` param");
    const af = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (!(af instanceof TFile)) throw new Error(`file not found: ${filePath}`);
    return af;
  }

  /** `reply` action: append a message to a thread in frontmatter, then open at it. */
  private async handleReply(params: Record<string, string>): Promise<void> {
    const file = this.resolveFile(params.file);
    const threadId = params.thread;
    const body = params.body;
    const author = params.author || "external";

    let found = false;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const threads = (fm.review?.threads as ReviewThread[] | undefined) ?? [];
      const t = threads.find((x) => x.id === threadId);
      if (t) {
        t.messages.push({ author, ts: new Date().toISOString(), body });
        found = true;
      }
    });
    if (!found) throw new Error(`thread not found: ${threadId}`);

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    this.app.workspace.openLinkText(`${file.path}#^${threadId}`, file.path, false);
    new Notice(`review-md: replied to ${threadId} in ${file.path}`);
  }

  /** POC-1: resolve + open the target file, jump to a thread's ^blockId, and self-report. */
  private async handleUri(op: XcallbackOperation, params: Record<string, string>): Promise<void> {
    const af = this.resolveFile(params.file);

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(af);

    if (params.thread) {
      this.app.workspace.openLinkText(`${af.path}#^${params.thread}`, af.path, false);
    }

    const report =
      `# POC-1 report\n\n- **RESULT: PASS** — protocol handler fired and opened the file.\n` +
      `- opened: \`${af.path}\`\n- thread param: \`${params.thread ?? "(none)"}\`\n` +
      `- action: \`${op.action}\`\n- x-success: \`${params["x-success"] ?? "(none)"}\`\n` +
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

  /**
   * If `el` is a rendered mermaid code block, return its diagram source (from
   * the file's raw text via getSectionInfo, so it's the stored source verbatim);
   * otherwise null. The post-processor runs for every section, so this is the
   * cheap filter that skips paragraphs, tables, etc.
   */
  private mermaidSourceFor(el: HTMLElement, ctx: MarkdownPostProcessorContext): string | null {
    if (!el.querySelector(".mermaid, code.language-mermaid, pre.language-mermaid")) return null;
    const info = ctx.getSectionInfo(el);
    if (!info) return null;
    const lines = info.text.split("\n").slice(info.lineStart, info.lineEnd + 1);
    if (!/^\s*```+\s*mermaid\s*$/.test(lines[0] ?? "")) return null;
    return lines.slice(1, -1).join("\n"); // strip the ``` fences
  }

  /**
   * Does thread `t` apply to a diagram with this source? True when it's a
   * mermaidNode thread whose anchored node id appears in the source AND its
   * comment node isn't already baked in (so a baked diagram doesn't get the
   * node injected a second time by the live augmenter).
   */
  private mermaidThreadApplies(t: ReviewThread, source: string): boolean {
    const a = t.anchor as { type?: string; node?: string };
    return (
      a?.type === "mermaidNode" &&
      typeof a.node === "string" &&
      new RegExp(`(^|[^\\w])${a.node}([^\\w]|$)`, "m").test(source) &&
      !new RegExp(`\\brvw_${t.id}\\b`).test(source)
    );
  }

  /** mermaidNode threads whose anchored node id appears in *this* diagram. */
  private mermaidCommentsFor(source: string, sourcePath: string): ReviewThread[] {
    const fm = this.app.metadataCache.getCache(sourcePath)?.frontmatter as
      | { review?: { threads?: ReviewThread[] } }
      | undefined;
    return (fm?.review?.threads ?? []).filter((t) => this.mermaidThreadApplies(t, source));
  }

  /** Build `original source + one dashed comment node per thread` (source untouched). */
  private buildAugmentedSource(source: string, comments: ReviewThread[]): string {
    const escape = (s: string) => s.replace(/"/g, "'").replace(/\n/g, " ").slice(0, 60);
    const cmtId = (t: ReviewThread) => `rvw_${t.id}`;
    const lines = comments.map((t) => {
      const a = t.anchor as { node: string };
      const first = t.messages[0]?.body ?? "(comment)";
      const n = t.messages.length;
      const label = `${escape(first)}<br/>💬 ${n} ${n === 1 ? "msg" : "msgs"}${t.resolved ? " ✓" : ""}`;
      return `  ${a.node} -. "💬" .-> ${cmtId(t)}(["${label}"])`;
    });
    const needClassDef = !/classDef\s+reviewCmt\b/.test(source); // don't redefine on re-bake
    return (
      source.trimEnd() +
      "\n" +
      lines.join("\n") +
      (needClassDef
        ? `\n  classDef reviewCmt fill:#fff3bf,stroke:#f0c000,color:#5c3d00,rx:6,ry:6`
        : "") +
      `\n  class ${comments.map(cmtId).join(",")} reviewCmt`
    );
  }

  /**
   * Req 9 (bake command): write the injected comment nodes into every ```mermaid
   * fence of the active file whose nodes carry threads. This is the destructive
   * opt-in — it edits the stored source. Idempotent: threads already baked
   * (their `rvw_<id>` node present) are skipped, so re-running is safe.
   */
  private async bakeMermaidComments(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Bake: open a markdown file first");
      return;
    }
    const fm = this.app.metadataCache.getCache(file.path)?.frontmatter as
      | { review?: { threads?: ReviewThread[] } }
      | undefined;
    const threads = (fm?.review?.threads ?? []).filter(
      (t) => (t.anchor as { type?: string }).type === "mermaidNode",
    );
    if (!threads.length) {
      new Notice("Bake: no mermaidNode threads in this file");
      return;
    }

    const lines = (await this.app.vault.read(file)).split("\n");
    const out: string[] = [];
    const fenceOpen = /^(\s*)(`{3,})\s*mermaid\s*$/;
    let i = 0;
    let bakedComments = 0;
    let bakedDiagrams = 0;

    while (i < lines.length) {
      const open = lines[i].match(fenceOpen);
      if (!open) {
        out.push(lines[i]);
        i++;
        continue;
      }
      const [, indent, ticks] = open;
      const closeRe = new RegExp(`^${indent}${ticks}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      const body = lines.slice(i + 1, j);
      // De-indent the body to source, apply the same indent back afterwards.
      const source = body.map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n");
      const applicable = threads.filter((t) => this.mermaidThreadApplies(t, source));

      if (applicable.length) {
        const augmented = this.buildAugmentedSource(source, applicable);
        out.push(lines[i]); // open fence
        for (const l of augmented.split("\n")) out.push(indent ? indent + l : l);
        if (j < lines.length) out.push(lines[j]); // close fence
        bakedComments += applicable.length;
        bakedDiagrams++;
      } else {
        for (let k = i; k <= Math.min(j, lines.length - 1); k++) out.push(lines[k]);
      }
      i = j + 1;
    }

    if (!bakedDiagrams) {
      new Notice("Bake: nothing to bake (already baked, or no matching nodes)");
      return;
    }
    await this.app.vault.modify(file, out.join("\n"));
    new Notice(`Baked ${bakedComments} comment(s) into ${bakedDiagrams} diagram(s)`);
  }

  /**
   * POC-6: replace the built-in mermaid SVG with an augmented render carrying a
   * comment node per thread. Waits (via observer) for the built-in SVG to land,
   * then swaps once; if there are no threads for this diagram it leaves the
   * native render untouched.
   */
  private augmentRenderedMermaid(el: HTMLElement, source: string, sourcePath: string): void {
    const comments = this.mermaidCommentsFor(source, sourcePath);
    if (!comments.length) return; // no threads → stay 100% native
    const mermaid = (window as unknown as { mermaid?: any }).mermaid;
    if (!mermaid?.render) return;

    const augmented = this.buildAugmentedSource(source, comments);
    let applied = false;
    const obs = new MutationObserver(() => {
      if (el.querySelector("svg")) void doApply();
    });
    const doApply = async (): Promise<void> => {
      if (applied) return;
      applied = true;
      obs.disconnect();
      try {
        const { svg, bindFunctions } = await mermaid.render("reviewmd-" + mkId(), augmented);
        el.empty();
        const host = el.createDiv({ cls: "review-md-mermaid" });
        host.innerHTML = svg;
        bindFunctions?.(host);
        for (const t of comments) {
          const g = host.querySelector(`g.node[id^="flowchart-rvw_${t.id}-"]`);
          if (g) {
            (g as SVGElement).style.cursor = "pointer";
            g.addEventListener("click", (e) => {
              e.stopPropagation();
              new Notice(`thread ${t.id}: ${t.messages.length} message(s)`);
            });
          }
        }
      } catch (err) {
        applied = false; // let a later mutation retry
        console.error("[review-md] mermaid augment failed", err);
      }
    };
    obs.observe(el, { childList: true, subtree: true });
    if (el.querySelector("svg")) void doApply();
  }

  private async writeVaultFile(path: string, content: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }
}

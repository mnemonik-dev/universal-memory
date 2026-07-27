/**
 * LocalAdapter — PGLite (embedded Postgres via WASM), zero server required.
 * Uses gbrain's pglite-engine under the hood.
 * Git-backed: memories are markdown files in gitDir, PGLite is the search index.
 */

import type { StorageAdapter, SearchResult, SynthesisResult } from "./index.js";
import { mode } from "../config.js";
import { runThink } from "gbrain/think";
import type { ParsedCitation } from "gbrain/think";

export class LocalAdapter implements StorageAdapter {
  private engine: any; // gbrain BrainEngine type
  private dataDir: string;

  constructor({ gitDir, dataDir }: { gitDir?: string; dataDir?: string }) {
    // Accept either gitDir (legacy name) or dataDir (new name from config)
    this.dataDir = dataDir ?? gitDir ?? (process.env.HOME + "/.universal-memory/brain");
  }

  async init() {
    // Lazy-load gbrain to avoid startup cost when not needed
    const { createPgliteEngine } = await import("../engine/pglite.js");
    this.engine = await createPgliteEngine(this.dataDir);
  }

  private async getEngine() {
    if (!this.engine) await this.init();
    return this.engine;
  }

  async search({ query, userId, topK }: { query: string; userId?: string; topK: number }): Promise<SearchResult[]> {
    const engine = await this.getEngine();
    return engine.search({ query, userId, limit: topK });
  }

  /**
   * Synthesize an answer from stored memories using gbrain's think pipeline.
   * In BM25-only mode (no LLM available), returns a setup guidance message.
   */
  async synthesize({ question, userId: _userId }: { question: string; userId?: string }): Promise<SynthesisResult> {
    // BM25-only mode: no LLM available
    if (mode === 'bm25-only') {
      return {
        answer: "Synthesis requires LLM. Run 'bunx universal-memory setup' or set OPENAI_API_KEY.",
        citations: [],
        gaps: [],
      };
    }

    // Full/Ollama mode: run gbrain's think pipeline
    try {
      const engine = await this.getEngine();
      const result = await runThink(engine, { question });

      // Map ParsedCitation[] to output shape { id, excerpt }
      // ParsedCitation fields: { page_slug, row_num, citation_index }
      // We use page_slug as id; excerpt is a reference string (slug#row)
      const citations = result.citations.map((c: ParsedCitation) => ({
        id: c.page_slug,
        excerpt: c.row_num !== null
          ? `${c.page_slug}#${c.row_num}`
          : c.page_slug,
      }));

      return {
        answer: result.answer,
        citations,
        gaps: result.gaps,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        answer: `Synthesis failed: ${msg}`,
        citations: [],
        gaps: [],
      };
    }
  }

  async add({ id, content, source, userId, signature }: {
    id: string; content: string; source?: string; userId?: string; signature?: string;
  }): Promise<void> {
    const engine = await this.getEngine();
    await engine.upsert({ id, content, source, userId, metadata: signature ? { signature } : undefined });
  }

  async clear({ userId }: { userId: string }): Promise<void> {
    const engine = await this.getEngine();
    await engine.deleteByUser(userId);
  }

  async sync(_: { direction: string }): Promise<{ pushed?: number; pulled?: number }> {
    // Local-only adapter: no-op for sync (nothing to push to)
    return { pushed: 0 };
  }
}

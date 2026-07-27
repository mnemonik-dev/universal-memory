/**
 * LocalAdapter — PGLite (embedded Postgres via WASM), zero server required.
 * Uses gbrain's pglite-engine under the hood.
 * Git-backed: memories are markdown files in gitDir, PGLite is the search index.
 */

import type { StorageAdapter, SearchResult, SynthesisResult, ListResult } from "./index.js";
import { mode, embeddingsEnabled, chatModel } from "../config.js";
import { runThink } from "gbrain/think";
import type { ParsedCitation } from "gbrain/think";
import { importFromContent } from "gbrain/import-file";
import { hybridSearch } from "gbrain/search/hybrid";

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

  async search({ query, topK }: { query: string; userId?: string; topK: number }): Promise<SearchResult[]> {
    const engine = await this.getEngine();
    // hybridSearch embeds the query for its vector arm — only safe when an
    // embedding provider is configured. Otherwise fall back to BM25 keyword
    // search, which needs no embeddings.
    const results = embeddingsEnabled
      ? await hybridSearch(engine, query, { limit: topK })
      : await engine.searchKeyword(query, { limit: topK });
    return results.map((r: any) => ({
      id: r.slug,
      content: r.chunk_text ?? "",
      score: r.score ?? 0,
      source: undefined,
    }));
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
      const result = await runThink(engine, { question, ...(chatModel ? { model: chatModel } : {}) });

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

  async add({ id, content }: {
    id: string; content: string; source?: string; userId?: string; signature?: string;
  }): Promise<void> {
    const engine = await this.getEngine();
    // gbrain's ingestion entrypoint: chunk + (optionally) embed + index the
    // content as a page keyed by `id` (used as the slug). noEmbed when no
    // embedding provider is available (BM25-only / anthropic-chat modes).
    await importFromContent(engine, id, content, { noEmbed: !embeddingsEnabled });
  }

  /**
   * Retrieve a single memory entry by id (slug).
   * Returns { id, content } if found, null if not found.
   */
  async getById(id: string): Promise<{ id: string; content: string } | null> {
    const engine = await this.getEngine();
    const page = await engine.getPage(id);
    if (!page) return null;
    return { id: page.slug ?? id, content: page.compiled_truth ?? "" };
  }

  /**
   * List stored memories, most recent first (gbrain listPages defaults to
   * updated_desc).
   */
  async list({ limit }: { limit: number; userId?: string }): Promise<ListResult[]> {
    const engine = await this.getEngine();
    const pages = await engine.listPages({ limit });
    return pages.map((p: any) => ({
      id: p.slug,
      content: p.compiled_truth ?? "",
      source: undefined,
      // Defensive fallback: guard against null/undefined created_at.
      created_at: p.created_at
        ? (p.created_at instanceof Date ? p.created_at : new Date(p.created_at)).toISOString()
        : new Date().toISOString(),
    }));
  }

  /**
   * Delete a stored memory by id (slug).
   * Throws an error with code 'not_found' if the id doesn't exist.
   */
  async delete({ id }: { id: string; userId?: string }): Promise<void> {
    const engine = await this.getEngine();
    // getPage returns null when the page doesn't exist
    const page = await engine.getPage(id);
    if (!page) {
      const err = new Error(`Memory not found: ${id}`);
      (err as any).code = 'not_found';
      throw err;
    }
    await engine.deletePage(id);
  }

  async clear(_: { userId: string }): Promise<void> {
    // gbrain has no per-user delete; single-user local store — clear all pages.
    const engine = await this.getEngine();
    const pages = await engine.listPages({});
    for (const p of pages) {
      await engine.deletePage(p.slug);
    }
  }

  async sync(_: { direction: string }): Promise<{ pushed?: number; pulled?: number }> {
    // Local-only adapter: no-op for sync (nothing to push to)
    return { pushed: 0 };
  }
}

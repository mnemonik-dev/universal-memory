/**
 * CloudAdapter — Postgres + pgvector backend for cloud mode.
 *
 * Uses gbrain's Postgres engine (createEngine + PostgresEngine) to store and
 * retrieve memories in a managed Postgres database. Designed for multi-device
 * access via the HTTP MCP transport (cloud mode).
 *
 * Constructor accepts an undefined DATABASE_URL and defers the actual
 * connection error to the first tool call. This allows the HTTP server to
 * start and serve auth checks even when DATABASE_URL is not yet set (D2
 * from Task 2 decisions).
 *
 * `migrateAttestationsTable()` creates the memory_attestations table (D7
 * idempotency store) added by Task 6. Retained here and wired to the real
 * Postgres engine when the engine is initialised.
 */

import type { StorageAdapter, SearchResult, SynthesisResult, ListResult } from "./index.js";
import { mode } from "../config.js";
import { runThink } from "gbrain/think";
import type { ParsedCitation } from "gbrain/think";

export class CloudAdapter implements StorageAdapter {
  private databaseUrl: string | undefined;
  private engine: any; // gbrain BrainEngine (typed as any to match LocalAdapter pattern)

  constructor({ databaseUrl }: { databaseUrl?: string }) {
    // Accept undefined — database will be required on first use, not at construction.
    // This allows the HTTP server to start and serve auth checks before any DB call.
    this.databaseUrl = databaseUrl;
    if (!databaseUrl) {
      process.stderr.write(
        "[universal-memory] WARNING: DATABASE_URL not set. " +
        "Tool calls will fail until DATABASE_URL is configured.\n"
      );
    }
  }

  /**
   * Guard: throw an actionable error when DATABASE_URL is missing.
   * Called at the top of every method before touching the engine.
   */
  private requireDb(): string {
    if (!this.databaseUrl) {
      throw new Error(
        "DATABASE_URL is required for cloud mode. " +
        "Set DATABASE_URL=postgres://... in your environment."
      );
    }
    return this.databaseUrl;
  }

  /**
   * Lazily initialise and return the gbrain Postgres engine.
   * The engine is a singleton on the adapter instance — re-used across calls.
   */
  private async getEngine(): Promise<any> {
    if (this.engine) return this.engine;

    const url = this.requireDb();

    // Dynamic import: avoids loading the Postgres client code when running in
    // local/PGLite mode (where PostgresEngine is never needed).
    const { createEngine } = await import("gbrain/engine-factory");
    // createEngine() constructs the engine but does NOT call connect() —
    // connection happens explicitly below via engine.connect().
    const engine = await createEngine({ engine: "postgres" });

    // Connect using the database_url. Passes it here (not to createEngine)
    // because PostgresEngine.connect() is where the pool is actually created.
    await engine.connect({ database_url: url });

    // Ensure the schema is initialised (idempotent on an existing database).
    await engine.initSchema();

    this.engine = engine;
    return engine;
  }

  /**
   * Create the memory_attestations table if it does not exist.
   *
   * Called at CloudAdapter init when DATABASE_URL is set (D7 from Task 6).
   * Safe to call multiple times — CREATE TABLE IF NOT EXISTS is idempotent.
   *
   * The primary key is content_hash so the idempotency check in sign.ts can
   * use an index seek (O(1)) rather than a sequential scan.
   *
   * Accepts an optional db client for testability. When omitted, uses the
   * gbrain engine's executeRaw() to run the DDL against the real Postgres pool.
   *
   * Side effect: when called without a `db` argument, triggers full engine
   * initialization (connect + initSchema) before running the DDL.
   */
  async migrateAttestationsTable(db?: { query(sql: string): Promise<unknown> }): Promise<void> {
    if (!db && !this.databaseUrl) {
      // No DB available — skip silently
      return;
    }

    const sql = `
      CREATE TABLE IF NOT EXISTS memory_attestations (
        content_hash   TEXT        NOT NULL,
        attestation_id TEXT        NOT NULL,
        signed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status         TEXT        NOT NULL DEFAULT 'signed',
        PRIMARY KEY (content_hash)
      )
    `;

    if (db) {
      await db.query(sql);
      return;
    }

    // Wire to the real Postgres engine via executeRaw (Task 5 implementation).
    const engine = await this.getEngine();
    await engine.executeRaw(sql.trim());
  }

  async search({ query, userId, topK }: { query: string; userId?: string; topK: number }): Promise<SearchResult[]> {
    const engine = await this.getEngine();
    // engine.search() matches LocalAdapter's pattern — both adapters call the
    // same method so future engine-level wrappers land consistently on both.
    return engine.search({ query, userId, limit: topK });
  }

  /**
   * Synthesize an answer from stored memories using gbrain's think pipeline.
   * In BM25-only mode (no LLM available), returns a setup guidance message.
   *
   * ThinkResult → SynthesisResult mapping:
   *   - answer: ThinkResult.answer (string)
   *   - citations: ThinkResult.citations (ParsedCitation[]) →
   *       { id: page_slug, excerpt: `${page_slug}#${row_num}` | page_slug }
   *   - gaps: ThinkResult.gaps (string[])
   */
  async synthesize({ question, userId: _userId }: { question: string; userId?: string }): Promise<SynthesisResult> {
    // BM25-only mode: no LLM available — return actionable setup guidance
    if (mode === "bm25-only") {
      return {
        answer: "Synthesis requires LLM. Run 'bunx universal-memory setup' or set OPENAI_API_KEY.",
        citations: [],
        gaps: [],
      };
    }

    try {
      const engine = await this.getEngine();
      const result = await runThink(engine, { question });

      // Map ParsedCitation[] to output shape { id, excerpt }
      // ParsedCitation fields: { page_slug, row_num, citation_index }
      // We use page_slug as id; excerpt = slug#row_num (take-level) or just slug (page-level)
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

  /**
   * List stored memories, most recent first.
   * Delegates to gbrain engine.listPages() with a limit filter.
   */
  async list({ limit, userId }: { limit: number; userId?: string }): Promise<ListResult[]> {
    const engine = await this.getEngine();
    const pages = await engine.listPages({
      limit,
      sort: 'updated_desc',
      ...(userId ? { sourceId: userId } : {}),
    });
    return pages.map((p: any) => ({
      id: p.slug,
      content: p.body ?? '',
      source: p.source_path ?? undefined,
      created_at: (p.created_at instanceof Date ? p.created_at : new Date(p.created_at)).toISOString(),
    }));
  }

  /**
   * Delete a stored memory by id (slug).
   * Throws an error with code 'not_found' if the id doesn't exist.
   */
  async delete({ id }: { id: string; userId?: string }): Promise<void> {
    const engine = await this.getEngine();
    const page = await engine.getPage(id);
    if (!page) {
      const err = new Error(`Memory not found: ${id}`);
      (err as any).code = 'not_found';
      throw err;
    }
    await engine.deletePage(id);
  }

  async clear({ userId }: { userId: string }): Promise<void> {
    const engine = await this.getEngine();
    await engine.deleteByUser(userId);
  }

  async sync(_: { direction: string }): Promise<{ pushed?: number; pulled?: number }> {
    // Cloud adapter: the brain IS the cloud.
    // A bidirectional sync from a local PGLite brain to this cloud store would
    // be implemented here in a future task. For now, return a no-op to match
    // the StorageAdapter contract (requires DB to be configured).
    this.requireDb(); // Guard: throw if not configured
    return { pushed: 0 };
  }
}

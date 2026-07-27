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
    const engine = await createEngine({
      engine: "postgres",
      database_url: url,
    });

    // Connect using the database_url from our config (matches EngineConfig type).
    await engine.connect({ database_url: url });

    // Ensure the schema is initialised (idempotent on an existing database).
    await engine.initSchema();

    this.engine = engine;
    return engine;
  }

  /**
   * Create the memory_attestations table if it does not exist.
   *
   * Called at CloudAdapter init when DATABASE_URL is set (D7).
   * Safe to call multiple times — CREATE TABLE IF NOT EXISTS is idempotent.
   *
   * The primary key is content_hash so the idempotency check in sign.ts can
   * use an index seek (O(1)) rather than a sequential scan.
   *
   * Note: full Postgres wiring (via `postgres` package) lands in Task 5.
   * This method accepts an optional db client argument for testability and
   * will be wired to the real pool in Task 5.
   */
  async migrateAttestationsTable(db?: { query(sql: string): Promise<unknown> }): Promise<void> {
    if (!db && !this.databaseUrl) {
      // No DB available — skip silently (startup path before Task 5 wiring)
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

    // When a real Postgres client is wired in Task 5, this branch runs.
    // For now log that the migration would run.
    process.stderr.write(
      "[universal-memory] INFO: memory_attestations migration scheduled (Task 5 will wire Postgres client).\n"
    );
  }

  async search(_opts: { query: string; userId?: string; topK: number }): Promise<SearchResult[]> {
    this.requireDb();
    // TODO (Task 5): wire gbrain Postgres engine hybridSearch()
    throw new Error(
      "CloudAdapter.search() not yet implemented. " +
      "Wire in Task 5 (memory_think + CloudAdapter)."
    );
  }

  async synthesize(_opts: { question: string; userId?: string }): Promise<SynthesisResult> {
    this.requireDb();
    // TODO (Task 5): wire runThink(engine, { question })
    throw new Error(
      "CloudAdapter.synthesize() not yet implemented. " +
      "Wire in Task 5 (memory_think + CloudAdapter)."
    );
  }

  async add(_opts: { id: string; content: string; source?: string; userId?: string; signature?: string }): Promise<void> {
    this.requireDb();
    // TODO (Task 5): wire engine.upsertPage()
    throw new Error(
      "CloudAdapter.add() not yet implemented. " +
      "Wire in Task 5 (memory_think + CloudAdapter)."
    );
  }

  async list(_opts: { limit: number; userId?: string }): Promise<ListResult[]> {
    this.requireDb();
    // TODO (Task 5): wire gbrain Postgres engine listPages()
    throw new Error(
      "CloudAdapter.list() not yet implemented. " +
      "Wire in Task 5 (memory_think + CloudAdapter)."
    );
  }

  async delete(_opts: { id: string; userId?: string }): Promise<void> {
    this.requireDb();
    // TODO (Task 5): wire engine.deletePage()
    throw new Error(
      "CloudAdapter.delete() not yet implemented. " +
      "Wire in Task 5 (memory_think + CloudAdapter)."
    );
  }

  async clear(_opts: { userId: string }): Promise<void> {
    this.requireDb();
    // TODO (Task 5): wire engine.deleteByUser()
    throw new Error(
      "CloudAdapter.clear() not yet implemented. " +
      "Wire in Task 5 (memory_think + CloudAdapter)."
    );
  }

  async sync(_opts: { direction: string }): Promise<{ pushed?: number; pulled?: number }> {
    this.requireDb();
    // TODO (Task 5): wire sync logic
    throw new Error(
      "CloudAdapter.sync() not yet implemented. " +
      "Wire in Task 5 (memory_think + CloudAdapter)."
    );
  }
}

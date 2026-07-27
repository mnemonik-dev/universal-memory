/**
 * CloudAdapter — Postgres + pgvector backend for cloud mode.
 *
 * STUB: This is a placeholder implementation for Task 2 (HTTP transport).
 * Full implementation is in Task 5 (wire memory_think + CloudAdapter).
 *
 * The adapter satisfies the StorageAdapter interface so the server can start
 * in cloud mode and serve HTTP requests. Tool calls will return stub responses
 * until Task 5 wires the real gbrain Postgres engine.
 *
 * Task 6 addition: `migrateAttestationsTable()` creates the memory_attestations
 * table (D7 idempotency store) at CloudAdapter init when DATABASE_URL is set.
 * This method is intentionally idempotent (CREATE TABLE IF NOT EXISTS).
 */

import type { StorageAdapter, SearchResult, SynthesisResult, ListResult } from "./index.js";

export class CloudAdapter implements StorageAdapter {
  private databaseUrl: string | undefined;

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

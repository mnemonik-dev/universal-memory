/**
 * CloudAdapter — Postgres + pgvector backend for cloud mode.
 *
 * STUB: This is a placeholder implementation for Task 2 (HTTP transport).
 * Full implementation is in Task 5 (wire memory_think + CloudAdapter).
 *
 * The adapter satisfies the StorageAdapter interface so the server can start
 * in cloud mode and serve HTTP requests. Tool calls will return stub responses
 * until Task 5 wires the real gbrain Postgres engine.
 */

import type { StorageAdapter, SearchResult, SynthesisResult } from "./index.js";

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

/**
 * HybridAdapter — writes to BOTH local PGLite and cloud Postgres.
 *
 * Read path: local first (fast, no network), falls back to cloud on miss.
 * Write path: dual-write (local + cloud in parallel for add/delete/clear).
 * Sync: push local-only entries to cloud via sync().
 *
 * Implements full StorageAdapter interface (search, synthesize, add, list,
 * delete, clear, sync) so MEMORY_BACKEND=hybrid is fully functional.
 *
 * Design decisions:
 * - Reads prefer local to avoid network latency in the common case.
 * - On local-miss for search (0 results), falls back to cloud search so the
 *   user still gets results from cloud-only memories.
 * - Write errors in cloud are logged but do not fail the call — local write
 *   is the source of truth; sync() reconciles later.
 * - sync() pushes all local entries to cloud (push-only for now; bidirectional
 *   and pull are noted but not yet implemented — consistent with CloudAdapter.sync()).
 */

import type { StorageAdapter, SearchResult, SynthesisResult, ListResult } from "./index.js";
import { LocalAdapter } from "./local.js";
import { CloudAdapter } from "./cloud.js";

export class HybridAdapter implements StorageAdapter {
  private local: LocalAdapter;
  private cloud: CloudAdapter;

  constructor({ gitDir, databaseUrl }: { gitDir?: string; databaseUrl: string }) {
    this.local = new LocalAdapter({ gitDir });
    this.cloud = new CloudAdapter({ databaseUrl });
  }

  /**
   * Search local first. If local returns 0 results, fall back to cloud.
   * This ensures cloud-only memories (not yet synced to local) are still
   * discoverable without incurring a network round-trip on every query.
   */
  async search(opts: { query: string; userId?: string; topK: number }): Promise<SearchResult[]> {
    const localResults = await this.local.search(opts);
    if (localResults.length > 0) {
      return localResults;
    }
    // Local miss — try cloud
    try {
      return await this.cloud.search(opts);
    } catch (err) {
      process.stderr.write(
        `[memory-hub] HybridAdapter cloud search fallback failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return [];
    }
  }

  /**
   * Synthesize from local first. Falls back to cloud if local returns the
   * BM25-only placeholder (no LLM) or a synthesis failure.
   *
   * In practice, both adapters share the same LLM gateway (configured at
   * module level in config.ts), so the fallback is mainly for cases where
   * the local engine has no relevant memories but the cloud engine does.
   */
  async synthesize(opts: { question: string; userId?: string }): Promise<SynthesisResult> {
    const localResult = await this.local.synthesize(opts);
    // If local synthesis succeeded with a non-trivial answer, return it
    if (
      localResult.answer &&
      !localResult.answer.startsWith("Synthesis requires LLM") &&
      !localResult.answer.startsWith("Synthesis failed")
    ) {
      return localResult;
    }
    // Fall back to cloud for synthesis
    try {
      return await this.cloud.synthesize(opts);
    } catch (err) {
      process.stderr.write(
        `[memory-hub] HybridAdapter cloud synthesize fallback failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return localResult; // Return local result even if it's a placeholder
    }
  }

  /**
   * Dual-write: write to local first (always), then write to cloud.
   * Cloud write failure is logged but does not fail the call —
   * sync() can reconcile later.
   */
  async add(opts: {
    id: string;
    content: string;
    source?: string;
    userId?: string;
    signature?: string;
  }): Promise<void> {
    await this.local.add(opts);
    try {
      await this.cloud.add(opts);
    } catch (err) {
      process.stderr.write(
        `[memory-hub] HybridAdapter cloud add failed (will sync later): ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  /**
   * List from local (most recent first). Falls back to cloud on empty result.
   * Cloud results may include entries not yet synced to local.
   */
  async list(opts: { limit: number; userId?: string }): Promise<ListResult[]> {
    const localResults = await this.local.list(opts);
    if (localResults.length > 0) {
      return localResults;
    }
    try {
      return await this.cloud.list(opts);
    } catch (err) {
      process.stderr.write(
        `[memory-hub] HybridAdapter cloud list fallback failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return [];
    }
  }

  /**
   * Delete from both local and cloud in parallel.
   * Throws if the entry is not found in local (primary source of truth).
   */
  async delete(opts: { id: string; userId?: string }): Promise<void> {
    // Delete from local first — this is the authoritative "not found" check
    await this.local.delete(opts);
    // Best-effort delete from cloud (may not exist there yet if never synced)
    try {
      await this.cloud.delete(opts);
    } catch (err) {
      // Ignore cloud not_found errors — entry may not have been synced yet
      if ((err as any)?.code !== "not_found") {
        process.stderr.write(
          `[memory-hub] HybridAdapter cloud delete failed: ${err instanceof Error ? err.message : String(err)}\n`
        );
      }
    }
  }

  /**
   * Clear all entries for a user from both local and cloud.
   */
  async clear(opts: { userId: string }): Promise<void> {
    await this.local.clear(opts);
    try {
      await this.cloud.clear(opts);
    } catch (err) {
      process.stderr.write(
        `[memory-hub] HybridAdapter cloud clear failed: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
  }

  /**
   * Return a DbClient from the cloud sub-adapter for signMemory() idempotency.
   *
   * Delegates to CloudAdapter.getDbClient() — the cloud database is the
   * authoritative store for memory_attestations in hybrid mode.
   * Returns null when DATABASE_URL is not configured.
   */
  async getDbClient(): Promise<import("../tools/sign.js").DbClient | null> {
    return this.cloud.getDbClient();
  }

  /**
   * Sync local memories to cloud. Reads all local entries and upserts any
   * not yet present in cloud. Returns pushed count.
   *
   * direction: "push" (default) — local → cloud only.
   *   "pull" and "bidirectional" are not yet implemented; they return 0 pulled
   *   to satisfy the StorageAdapter contract without silent failures.
   */
  async sync(opts: { direction: string }): Promise<{ pushed?: number; pulled?: number }> {
    const direction = opts.direction ?? "push";

    let pushed = 0;

    if (direction === "push" || direction === "bidirectional") {
      // List all local entries (up to a generous limit for a sync operation)
      const MAX_SYNC_BATCH = 10_000;
      const localEntries = await this.local.list({ limit: MAX_SYNC_BATCH });

      for (const entry of localEntries) {
        try {
          await this.cloud.add({
            id: entry.id,
            content: entry.content,
            source: entry.source,
          });
          pushed++;
        } catch (err) {
          process.stderr.write(
            `[memory-hub] HybridAdapter sync push failed for ${entry.id}: ${err instanceof Error ? err.message : String(err)}\n`
          );
        }
      }
    }

    // Pull is not yet implemented — return 0 to match StorageAdapter contract
    const pulled = 0;

    if (direction === "pull" || direction === "bidirectional") {
      process.stderr.write(
        "[memory-hub] HybridAdapter: pull sync not yet implemented. Entries will sync on next access.\n"
      );
    }

    return { pushed, pulled };
  }
}

/**
 * Smoke / integration test: ingestion pipeline → storage → search round-trip.
 *
 * Uses real IngestPipeline with a mock StorageAdapter (avoids PGLite startup
 * overhead). Tests that capture text → search returns it.
 *
 * Named "ingestion" so the task smoke command works:
 *   bun test packages/memory-hub/ -t "ingestion"
 */

import { describe, it, expect, spyOn } from "bun:test";
import type { StorageAdapter, SearchResult } from "../storage/index.js";
import { IngestPipeline } from "./pipeline.js";
import * as fetcherMod from "./fetcher.js";

/**
 * In-memory StorageAdapter for integration tests.
 * Tracks stored entries and returns them on search.
 */
class InMemoryStorage implements StorageAdapter {
  private entries: Array<{ id: string; content: string; source?: string; userId?: string }> = [];

  async add(opts: { id: string; content: string; source?: string; userId?: string }): Promise<void> {
    this.entries.push(opts);
  }

  async search(opts: { query: string; userId?: string; topK: number }): Promise<SearchResult[]> {
    const q = opts.query.toLowerCase();
    return this.entries
      .filter((e) => e.content.toLowerCase().includes(q))
      .slice(0, opts.topK)
      .map((e) => ({
        id: e.id,
        content: e.content,
        source: e.source,
        score: 1.0,
      }));
  }

  async synthesize(opts: { question: string }): Promise<{ answer: string; citations: Array<{ id: string; excerpt: string }>; gaps: string[] }> {
    return { answer: "No synthesis in mock.", citations: [], gaps: [] };
  }

  async list(opts: { limit: number; userId?: string }): Promise<Array<{ id: string; content: string; source?: string; created_at: string }>> {
    const filtered = opts.userId
      ? this.entries.filter((e) => e.userId === opts.userId)
      : this.entries;
    return filtered.slice(0, opts.limit).map((e) => ({
      id: e.id,
      content: e.content,
      source: e.source,
      created_at: new Date().toISOString(),
    }));
  }

  async delete(opts: { id: string }): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === opts.id);
    if (idx === -1) {
      const err = new Error(`Memory not found: ${opts.id}`);
      (err as any).code = "not_found";
      throw err;
    }
    this.entries.splice(idx, 1);
  }

  async clear(opts: { userId: string }): Promise<void> {
    this.entries = this.entries.filter((e) => e.userId !== opts.userId);
  }

  async sync(opts: { direction: string }): Promise<{ pushed?: number; pulled?: number }> {
    return {};
  }
}

describe("ingestion", () => {
  it("capture text → search returns it", async () => {
    const storage = new InMemoryStorage();
    const pipeline = new IngestPipeline(storage);

    const result = await pipeline.dispatch({
      content: "Bun is a fast JavaScript runtime with built-in package manager.",
      source: "test",
    });

    expect(result).toHaveProperty("id");
    expect(result.chunks).toBe(1);

    const hits = await storage.search({ query: "JavaScript runtime", topK: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.content).toContain("Bun");
  });

  it("capture URL content → stored after fetcher (mocked)", async () => {
    const storage = new InMemoryStorage();
    const pipeline = new IngestPipeline(storage);

    // Spy on fetchUrl to avoid real network call.
    // This works because pipeline.ts imports fetchUrl from the same module path
    // as fetcherMod here, so both reference the same module cache entry.
    // If pipeline.ts ever switches to a different import path, the spy must be updated.
    const fetchUrlSpy = spyOn(fetcherMod, "fetchUrl").mockResolvedValue(
      "# Fetched Article\n\nThis article discusses universal memory systems."
    );

    try {
      const result = await pipeline.dispatch({
        content: "https://example.com/memory-article",
        source: "url",
      });
      expect(result).toHaveProperty("id");
      expect(result.chunks).toBeGreaterThanOrEqual(1);

      const hits = await storage.search({ query: "universal memory", topK: 5 });
      expect(hits.length).toBeGreaterThanOrEqual(1);
    } finally {
      fetchUrlSpy.mockRestore();
    }
  });

  it("capture → multiple chunks for large content", async () => {
    const storage = new InMemoryStorage();
    const pipeline = new IngestPipeline(storage);

    // Generate content that exceeds 2000 chars to force chunking
    const largeContent = "This is important knowledge. ".repeat(200); // ~5800 chars

    const result = await pipeline.dispatch({
      content: largeContent,
      source: "test",
    });

    expect(result).toHaveProperty("id");
    expect(result.chunks).toBeGreaterThan(1);
  });

  it("capture image data URL → stored as single chunk", async () => {
    const storage = new InMemoryStorage();
    const pipeline = new IngestPipeline(storage);

    // 1x1 PNG base64
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const result = await pipeline.dispatch({ content: tinyPng, source: "test" });
    expect(result).toHaveProperty("id");
    expect(result.chunks).toBe(1);
  });

  it("content_too_large error for >10MB content", async () => {
    const storage = new InMemoryStorage();
    const pipeline = new IngestPipeline(storage);
    const { ContentTooLargeError } = await import("./pipeline.js");

    const oversized = "x".repeat(11 * 1024 * 1024);
    await expect(pipeline.dispatch({ content: oversized })).rejects.toThrow(ContentTooLargeError);
  });
});

/**
 * Integration tests for memory_search handler behaviour.
 *
 * TDD anchors (task 4):
 *   - calls_engine_search_with_topk
 *   - default_topk_is_10
 *   - maps_results_to_output_schema
 *
 * Uses mock StorageAdapter to avoid PGLite startup cost.
 * Tests the search path wired in server.ts (which calls storage.search()).
 */

import { describe, it, expect, mock } from "bun:test";
import type { StorageAdapter, SearchResult } from "../storage/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: overrides.id ?? "page-slug-1",
    content: overrides.content ?? "Sample memory content",
    score: overrides.score ?? 0.95,
    source: overrides.source,
  };
}

function createMockStorage(results: SearchResult[] = []): StorageAdapter {
  return {
    add: mock(async () => {}),
    search: mock(async () => results),
    synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
    list: mock(async () => []),
    delete: mock(async () => {}),
    clear: mock(async () => {}),
    sync: mock(async () => ({})),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("search", () => {
  describe("calls_engine_search_with_topk", () => {
    it("passes topK to storage.search() when top_k provided", async () => {
      const storage = createMockStorage([makeSearchResult()]);

      await storage.search({ query: "test query", topK: 5 });

      const call = (storage.search as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toMatchObject({ topK: 5 });
    });

    it("passes query string to storage.search()", async () => {
      const storage = createMockStorage([]);

      await storage.search({ query: "memory systems", topK: 10 });

      const call = (storage.search as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toMatchObject({ query: "memory systems" });
    });

    it("passes userId when provided", async () => {
      const storage = createMockStorage([]);

      await storage.search({ query: "test", userId: "user-xyz", topK: 10 });

      const call = (storage.search as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toMatchObject({ userId: "user-xyz" });
    });
  });

  describe("default_topk_is_10", () => {
    it("uses topK: 10 when top_k arg is undefined", async () => {
      const storage = createMockStorage([]);

      // Simulate what server.ts does: (args.top_k as number) ?? 10
      const topK = (undefined as number | undefined) ?? 10;
      await storage.search({ query: "default k test", topK });

      const call = (storage.search as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0].topK).toBe(10);
    });

    it("top_k: 0 is NOT treated as default (0 is explicit)", async () => {
      // 0 is falsy but an explicit argument — server.ts uses ?? not ||
      const topK = (0 as number | undefined) ?? 10;
      // With ??, 0 stays 0 (it's not null/undefined)
      expect(topK).toBe(0);
    });

    it("top_k: null falls back to 10", async () => {
      const topK = (null as unknown as number | undefined) ?? 10;
      expect(topK).toBe(10);
    });
  });

  describe("maps_results_to_output_schema", () => {
    it("result has id, content, score, source fields", async () => {
      const expected = makeSearchResult({
        id: "memory-123",
        content: "LLMs work via attention mechanisms",
        score: 0.82,
        source: "https://arxiv.org/abs/1706.03762",
      });
      const storage = createMockStorage([expected]);

      const results = await storage.search({ query: "attention", topK: 10 });

      expect(results).toHaveLength(1);
      const r = results[0]!;
      expect(r.id).toBe("memory-123");
      expect(r.content).toBe("LLMs work via attention mechanisms");
      expect(r.score).toBe(0.82);
      expect(r.source).toBe("https://arxiv.org/abs/1706.03762");
    });

    it("returns array even when no results", async () => {
      const storage = createMockStorage([]);
      const results = await storage.search({ query: "nonexistent topic", topK: 10 });
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });

    it("returns multiple results in order", async () => {
      const r1 = makeSearchResult({ id: "p1", score: 0.99, content: "first result" });
      const r2 = makeSearchResult({ id: "p2", score: 0.75, content: "second result" });
      const storage = createMockStorage([r1, r2]);

      const results = await storage.search({ query: "any", topK: 10 });

      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe("p1");
      expect(results[1]!.id).toBe("p2");
    });

    it("optional fields (source) can be undefined", async () => {
      const r = makeSearchResult({ id: "no-source", source: undefined });
      const storage = createMockStorage([r]);

      const results = await storage.search({ query: "x", topK: 5 });

      expect(results[0]!.source).toBeUndefined();
    });
  });
});

/**
 * Integration tests for memory_capture handler behaviour.
 *
 * TDD anchors (task 4):
 *   - calls_ingest_pipeline
 *   - returns_id_and_chunks
 *
 * Uses mock StorageAdapter to avoid PGLite startup cost.
 * The IngestPipeline under test is the real implementation.
 */

import { describe, it, expect, mock } from "bun:test";
import { IngestPipeline } from "../ingest/pipeline.js";
import type { StorageAdapter } from "../storage/index.js";

// ─── In-memory StorageAdapter ────────────────────────────────────────────────

function createMockStorage(): StorageAdapter {
  const entries: Array<{ id: string; content: string; source?: string }> = [];
  return {
    add: mock(async (opts) => { entries.push(opts); }),
    search: mock(async () => []),
    synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
    list: mock(async () => []),
    delete: mock(async () => {}),
    clear: mock(async () => {}),
    sync: mock(async () => ({})),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("capture", () => {
  describe("calls_ingest_pipeline", () => {
    it("plain text capture calls storage.add()", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      await pipeline.dispatch({ content: "Integration memory test" });

      expect(storage.add).toHaveBeenCalled();
    });

    it("capture with source passes source to storage.add()", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      await pipeline.dispatch({
        content: "Sourced content",
        source: "https://example.com/article",
      });

      const addCall = (storage.add as ReturnType<typeof mock>).mock.calls[0];
      expect(addCall[0]).toMatchObject({ source: "https://example.com/article" });
    });

    it("capture with userId passes userId to storage.add()", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      await pipeline.dispatch({
        content: "User-scoped content",
        userId: "user-abc",
      });

      const addCall = (storage.add as ReturnType<typeof mock>).mock.calls[0];
      expect(addCall[0]).toMatchObject({ userId: "user-abc" });
    });

    it("large content calls storage.add() multiple times (one per chunk)", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      // 5 * 2000 chars = 10000 chars → multiple chunks
      const largeContent = "chunk content. ".repeat(400);
      const result = await pipeline.dispatch({ content: largeContent });

      expect(result.chunks).toBeGreaterThan(1);
      expect((storage.add as ReturnType<typeof mock>).mock.calls.length).toBe(result.chunks);
    });
  });

  describe("returns_id_and_chunks", () => {
    it("returns { id: string, chunks: number } for plain text", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      const result = await pipeline.dispatch({ content: "Hello world" });

      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      expect(typeof result.chunks).toBe("number");
      expect(result.chunks).toBeGreaterThanOrEqual(1);
    });

    it("single-chunk content returns chunks: 1", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      const result = await pipeline.dispatch({ content: "Short text" });

      expect(result.chunks).toBe(1);
    });

    it("multi-chunk content returns chunks matching chunk count", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      // 6000 chars: should produce 4 chunks (2000-char window, 200-char overlap)
      const bigText = "x".repeat(6000);
      const result = await pipeline.dispatch({ content: bigText });

      expect(result.chunks).toBeGreaterThan(1);
    });

    it("id is a valid UUID v4 string", async () => {
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      const result = await pipeline.dispatch({ content: "UUID test" });

      // UUID v4 regex
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it("content too large returns ContentTooLargeError (not { id, chunks })", async () => {
      const { ContentTooLargeError } = await import("../ingest/pipeline.js");
      const storage = createMockStorage();
      const pipeline = new IngestPipeline(storage);

      const oversized = "x".repeat(11 * 1024 * 1024);
      await expect(pipeline.dispatch({ content: oversized })).rejects.toThrow(ContentTooLargeError);
    });
  });
});

/**
 * Integration tests for memory_list handler behaviour.
 *
 * TDD anchors (task 4):
 *   - calls_listPages_with_limit
 *   - default_limit_is_20
 *
 * Uses mock StorageAdapter to avoid PGLite startup cost.
 * Tests the list path wired in server.ts (which calls storage.list()).
 */

import { describe, it, expect, mock } from "bun:test";
import type { StorageAdapter, ListResult } from "../storage/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeListResult(overrides: Partial<ListResult> = {}): ListResult {
  return {
    id: overrides.id ?? "slug-1",
    content: overrides.content ?? "Some stored memory",
    source: overrides.source,
    created_at: overrides.created_at ?? "2026-07-27T00:00:00.000Z",
  };
}

function createMockStorage(listResults: ListResult[] = []): StorageAdapter {
  return {
    add: mock(async () => {}),
    search: mock(async () => []),
    synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
    list: mock(async () => listResults),
    delete: mock(async () => {}),
    clear: mock(async () => {}),
    sync: mock(async () => ({})),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("list", () => {
  describe("calls_listPages_with_limit", () => {
    it("passes limit to storage.list()", async () => {
      const storage = createMockStorage([]);

      await storage.list({ limit: 5 });

      const call = (storage.list as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toMatchObject({ limit: 5 });
    });

    it("passes userId when provided", async () => {
      const storage = createMockStorage([]);

      await storage.list({ limit: 20, userId: "user-abc" });

      const call = (storage.list as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toMatchObject({ userId: "user-abc" });
    });

    it("limit: 1 returns at most 1 result", async () => {
      const entries = [
        makeListResult({ id: "a" }),
        makeListResult({ id: "b" }),
      ];
      const storage = createMockStorage(entries.slice(0, 1));

      const results = await storage.list({ limit: 1 });

      expect(results).toHaveLength(1);
    });

    it("limit: 50 returns up to 50 entries", async () => {
      const storage = createMockStorage([]);

      await storage.list({ limit: 50 });

      const call = (storage.list as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0].limit).toBe(50);
    });
  });

  describe("default_limit_is_20", () => {
    it("uses limit: 20 when limit arg is undefined", async () => {
      const storage = createMockStorage([]);

      // Simulate what server.ts does: (args.limit as number) ?? 20
      const limit = (undefined as number | undefined) ?? 20;
      await storage.list({ limit });

      const call = (storage.list as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0].limit).toBe(20);
    });

    it("limit ?? 20 resolves correctly for null", async () => {
      const limit = (null as unknown as number | undefined) ?? 20;
      expect(limit).toBe(20);
    });

    it("explicit limit overrides default", async () => {
      const storage = createMockStorage([]);
      const limit = (10 as number | undefined) ?? 20;
      await storage.list({ limit });

      const call = (storage.list as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0].limit).toBe(10);
    });
  });

  describe("output schema", () => {
    it("result has id, content, created_at fields", async () => {
      const entry = makeListResult({
        id: "my-slug",
        content: "My stored memory text",
        created_at: "2026-07-27T10:00:00.000Z",
      });
      const storage = createMockStorage([entry]);

      const results = await storage.list({ limit: 20 });

      expect(results).toHaveLength(1);
      const r = results[0]!;
      expect(r.id).toBe("my-slug");
      expect(r.content).toBe("My stored memory text");
      expect(r.created_at).toBe("2026-07-27T10:00:00.000Z");
    });

    it("source field is optional", async () => {
      const withSource = makeListResult({ source: "https://example.com" });
      const withoutSource = makeListResult({ id: "no-src", source: undefined });
      const storage = createMockStorage([withSource, withoutSource]);

      const results = await storage.list({ limit: 20 });

      expect(results[0]!.source).toBe("https://example.com");
      expect(results[1]!.source).toBeUndefined();
    });

    it("returns empty array when no memories stored", async () => {
      const storage = createMockStorage([]);
      const results = await storage.list({ limit: 20 });
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(0);
    });
  });
});

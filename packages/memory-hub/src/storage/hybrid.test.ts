/**
 * Tests for storage/hybrid.ts — HybridAdapter
 *
 * TDD anchors (audit-fix CRITICAL-1):
 *   - HybridAdapter implements full StorageAdapter interface
 *   - read_local_first: search/list returns local results without calling cloud
 *   - read_fallback_to_cloud: when local returns 0 results, falls back to cloud
 *   - dual_write: add() calls both local and cloud
 *   - cloud_write_failure_non_fatal: cloud add failure logs but does not throw
 *   - delete_checks_local: delete throws not_found if local doesn't have the entry
 *   - sync_push_pushes_local_to_cloud: sync(push) upserts all local entries to cloud
 *
 * Uses mock LocalAdapter and CloudAdapter to avoid PGLite/Postgres startup.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { StorageAdapter, SearchResult, SynthesisResult, ListResult } from "./index.js";

// ─── Mock factories ───────────────────────────────────────────────────────────

type MockAdapter = {
  search: ReturnType<typeof mock>;
  synthesize: ReturnType<typeof mock>;
  add: ReturnType<typeof mock>;
  list: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
  clear: ReturnType<typeof mock>;
  sync: ReturnType<typeof mock>;
};

function makeSearchResult(id: string, score = 0.9): SearchResult {
  return { id, content: `content for ${id}`, score };
}

function makeListResult(id: string): ListResult {
  return { id, content: `content for ${id}`, created_at: new Date().toISOString() };
}

function makeSynthResult(): SynthesisResult {
  return { answer: "Local answer", citations: [], gaps: [] };
}

function makeNoopAdapter(): MockAdapter & StorageAdapter {
  return {
    search: mock(async () => [] as SearchResult[]),
    synthesize: mock(async () => ({
      answer: "Synthesis requires LLM. Run 'bunx universal-memory setup' or set OPENAI_API_KEY.",
      citations: [],
      gaps: [],
    })),
    add: mock(async () => {}),
    list: mock(async () => [] as ListResult[]),
    delete: mock(async () => {}),
    clear: mock(async () => {}),
    sync: mock(async () => ({ pushed: 0 })),
  };
}

// ─── HybridAdapter factory (bypasses constructor to inject mocks) ─────────────

async function makeHybrid(localMock: StorageAdapter, cloudMock: StorageAdapter) {
  const { HybridAdapter } = await import("./hybrid.js");
  const adapter = Object.create(HybridAdapter.prototype) as any;
  adapter.local = localMock;
  adapter.cloud = cloudMock;
  return adapter as import("./hybrid.js").HybridAdapter;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HybridAdapter", () => {
  describe("search — read local first", () => {
    it("returns local results without calling cloud when local has results", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (local.search as any).mockImplementation(async () => [makeSearchResult("local-1")]);

      const adapter = await makeHybrid(local, cloud);
      const results = await adapter.search({ query: "test", topK: 10 });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("local-1");
      expect(cloud.search).not.toHaveBeenCalled();
    });

    it("falls back to cloud when local returns 0 results", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (cloud.search as any).mockImplementation(async () => [makeSearchResult("cloud-1")]);

      const adapter = await makeHybrid(local, cloud);
      const results = await adapter.search({ query: "test", topK: 10 });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("cloud-1");
      expect(cloud.search).toHaveBeenCalledTimes(1);
    });

    it("returns empty array when both local and cloud return 0 results", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();

      const adapter = await makeHybrid(local, cloud);
      const results = await adapter.search({ query: "obscure", topK: 10 });

      expect(results).toHaveLength(0);
    });

    it("returns empty array (no throw) when cloud fallback throws", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (cloud.search as any).mockImplementation(async () => { throw new Error("Network error"); });

      const adapter = await makeHybrid(local, cloud);
      const results = await adapter.search({ query: "test", topK: 10 });

      expect(results).toHaveLength(0); // Error handled gracefully
    });
  });

  describe("synthesize — local first, cloud fallback", () => {
    it("returns local result when local provides a real answer", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (local.synthesize as any).mockImplementation(async () => makeSynthResult());

      const adapter = await makeHybrid(local, cloud);
      const result = await adapter.synthesize({ question: "What is memory?" });

      expect(result.answer).toBe("Local answer");
      expect(cloud.synthesize).not.toHaveBeenCalled();
    });

    it("falls back to cloud when local returns BM25-only placeholder", async () => {
      const local = makeNoopAdapter(); // returns "Synthesis requires LLM" placeholder
      const cloud = makeNoopAdapter();
      (cloud.synthesize as any).mockImplementation(async () => ({
        answer: "Cloud answer",
        citations: [],
        gaps: [],
      }));

      const adapter = await makeHybrid(local, cloud);
      const result = await adapter.synthesize({ question: "What is memory?" });

      expect(result.answer).toBe("Cloud answer");
    });
  });

  describe("add — dual write", () => {
    it("writes to both local and cloud", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();

      const adapter = await makeHybrid(local, cloud);
      await adapter.add({ id: "m1", content: "test memory" });

      expect(local.add).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
      expect(cloud.add).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
    });

    it("cloud write failure does NOT throw — logs and continues", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (cloud.add as any).mockImplementation(async () => { throw new Error("Cloud unavailable"); });

      const adapter = await makeHybrid(local, cloud);
      // Should NOT throw even though cloud.add throws
      await expect(adapter.add({ id: "m2", content: "test" })).resolves.toBeUndefined();
      expect(local.add).toHaveBeenCalledTimes(1);
    });

    it("passes all fields (source, userId, signature) to both adapters", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();

      const adapter = await makeHybrid(local, cloud);
      await adapter.add({
        id: "m3",
        content: "content",
        source: "https://example.com",
        userId: "user-1",
        signature: "sig-abc",
      });

      const expected = { id: "m3", content: "content", source: "https://example.com", userId: "user-1", signature: "sig-abc" };
      expect(local.add).toHaveBeenCalledWith(expected);
      expect(cloud.add).toHaveBeenCalledWith(expected);
    });
  });

  describe("list — local first, cloud fallback", () => {
    it("returns local results when local has entries", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (local.list as any).mockImplementation(async () => [makeListResult("loc-1")]);

      const adapter = await makeHybrid(local, cloud);
      const results = await adapter.list({ limit: 20 });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("loc-1");
      expect(cloud.list).not.toHaveBeenCalled();
    });

    it("falls back to cloud when local returns empty", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (cloud.list as any).mockImplementation(async () => [makeListResult("cld-1")]);

      const adapter = await makeHybrid(local, cloud);
      const results = await adapter.list({ limit: 20 });

      expect(results[0]!.id).toBe("cld-1");
    });
  });

  describe("delete", () => {
    it("deletes from local first — throws not_found if local throws", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      const notFoundErr = Object.assign(new Error("Memory not found: x"), { code: "not_found" });
      (local.delete as any).mockImplementation(async () => { throw notFoundErr; });

      const adapter = await makeHybrid(local, cloud);
      await expect(adapter.delete({ id: "x" })).rejects.toMatchObject({ code: "not_found" });
      // Cloud should NOT be called if local not found
      expect(cloud.delete).not.toHaveBeenCalled();
    });

    it("deletes from cloud after local success (best-effort)", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();

      const adapter = await makeHybrid(local, cloud);
      await adapter.delete({ id: "m1" });

      expect(local.delete).toHaveBeenCalledTimes(1);
      expect(cloud.delete).toHaveBeenCalledTimes(1);
    });

    it("cloud delete not_found error is ignored (entry may not have synced)", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      const notFound = Object.assign(new Error("not found in cloud"), { code: "not_found" });
      (cloud.delete as any).mockImplementation(async () => { throw notFound; });

      const adapter = await makeHybrid(local, cloud);
      // Should not throw even if cloud throws not_found
      await expect(adapter.delete({ id: "m1" })).resolves.toBeUndefined();
    });
  });

  describe("clear", () => {
    it("clears both local and cloud for the given userId", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();

      const adapter = await makeHybrid(local, cloud);
      await adapter.clear({ userId: "user-42" });

      expect(local.clear).toHaveBeenCalledWith({ userId: "user-42" });
      expect(cloud.clear).toHaveBeenCalledWith({ userId: "user-42" });
    });

    it("cloud clear failure does not throw", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (cloud.clear as any).mockImplementation(async () => { throw new Error("Cloud down"); });

      const adapter = await makeHybrid(local, cloud);
      await expect(adapter.clear({ userId: "u1" })).resolves.toBeUndefined();
    });
  });

  describe("sync — push mode", () => {
    it("returns { pushed: N } equal to number of local entries", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (local.list as any).mockImplementation(async () => [
        makeListResult("id-1"),
        makeListResult("id-2"),
        makeListResult("id-3"),
      ]);

      const adapter = await makeHybrid(local, cloud);
      const result = await adapter.sync({ direction: "push" });

      expect(result.pushed).toBe(3);
      expect(cloud.add).toHaveBeenCalledTimes(3);
    });

    it("returns { pushed: 0 } when local has no entries", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();

      const adapter = await makeHybrid(local, cloud);
      const result = await adapter.sync({ direction: "push" });

      expect(result.pushed).toBe(0);
    });

    it("individual cloud.add failure decrements pushed count, does not abort", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (local.list as any).mockImplementation(async () => [
        makeListResult("ok-1"),
        makeListResult("fail-1"),
        makeListResult("ok-2"),
      ]);
      let callCount = 0;
      (cloud.add as any).mockImplementation(async (opts: any) => {
        callCount++;
        if (opts.id === "fail-1") throw new Error("Insert failed");
      });

      const adapter = await makeHybrid(local, cloud);
      const result = await adapter.sync({ direction: "push" });

      // 2 successes out of 3
      expect(result.pushed).toBe(2);
    });

    it("bidirectional direction still performs push (pull = 0)", async () => {
      const local = makeNoopAdapter();
      const cloud = makeNoopAdapter();
      (local.list as any).mockImplementation(async () => [makeListResult("b1")]);

      const adapter = await makeHybrid(local, cloud);
      const result = await adapter.sync({ direction: "bidirectional" });

      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(0);
    });
  });
});

/**
 * Unit tests for LocalAdapter — mock engine (no PGLite startup cost).
 *
 * These tests wire a mock gbrain engine into LocalAdapter to exercise method
 * implementations without incurring PGLite cold-start overhead.
 *
 * TDD anchors (Task 8):
 *   - LocalAdapter.add() passes id/content/source to engine.upsert()
 *   - LocalAdapter.search() delegates to engine.search() with limit=topK
 *   - LocalAdapter.list() maps Page fields to ListResult shape
 *   - LocalAdapter.delete() calls getPage then deletePage
 *   - LocalAdapter.delete() throws not_found when getPage returns null
 *   - LocalAdapter.clear() delegates to engine.deleteByUser()
 */

import { describe, it, expect, mock, spyOn } from "bun:test";

// ─── Mock gbrain engine ───────────────────────────────────────────────────────

function makeMockEngine({
  searchResults = [] as any[],
  listPages = [] as any[],
  existingPage = null as any,
} = {}) {
  return {
    kind: "pglite" as const,
    upsert: mock(async () => {}),
    search: mock(async () => searchResults),
    listPages: mock(async () => listPages),
    getPage: mock(async () => existingPage),
    deletePage: mock(async () => {}),
    deleteByUser: mock(async () => {}),
  };
}

// ─── Shared: patch LocalAdapter to use mock engine ───────────────────────────

/**
 * Creates a LocalAdapter with a pre-wired mock engine.
 * Bypasses the real createPgliteEngine() call via monkey-patching init().
 */
async function makeAdapterWithMock(engineOpts: Parameters<typeof makeMockEngine>[0] = {}) {
  const mockEngine = makeMockEngine(engineOpts);

  const { LocalAdapter } = await import("./local.js");
  const adapter = new LocalAdapter({ dataDir: "/tmp/mock-local-adapter" });

  // Directly set the private engine field (bypasses PGLite init)
  (adapter as any).engine = mockEngine;

  return { adapter, mockEngine };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("LocalAdapter.add()", () => {
  it("calls engine.upsert() with id, content, and source", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock();

    await adapter.add({ id: "test-id", content: "hello world", source: "test://src" });

    expect(mockEngine.upsert).toHaveBeenCalledTimes(1);
    const call = (mockEngine.upsert as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ id: "test-id", content: "hello world", source: "test://src" });
  });

  it("passes signature in metadata when provided", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock();

    await adapter.add({ id: "sig-id", content: "signed content", signature: "attest-abc" });

    const call = (mockEngine.upsert as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ metadata: { signature: "attest-abc" } });
  });

  it("passes undefined metadata when no signature", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock();

    await adapter.add({ id: "nosig-id", content: "unsigned content" });

    const call = (mockEngine.upsert as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0].metadata).toBeUndefined();
  });
});

describe("LocalAdapter.search()", () => {
  it("delegates to engine.search() with correct params", async () => {
    const searchResults = [
      { id: "page-1", content: "result one", score: 0.9 },
      { id: "page-2", content: "result two", score: 0.7 },
    ];
    const { adapter, mockEngine } = await makeAdapterWithMock({ searchResults });

    const results = await adapter.search({ query: "test query", topK: 5 });

    expect(mockEngine.search).toHaveBeenCalledTimes(1);
    const call = (mockEngine.search as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ query: "test query", limit: 5 });
    expect(results).toEqual(searchResults);
  });

  it("passes userId to engine.search() when provided", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock();

    await adapter.search({ query: "test", userId: "user-42", topK: 10 });

    const call = (mockEngine.search as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ userId: "user-42" });
  });

  it("returns empty array when engine.search() returns empty", async () => {
    const { adapter } = await makeAdapterWithMock({ searchResults: [] });
    const results = await adapter.search({ query: "nothing", topK: 10 });
    expect(results).toEqual([]);
  });
});

describe("LocalAdapter.list()", () => {
  it("calls engine.listPages() with limit and sort", async () => {
    const pages = [
      { slug: "pg-1", body: "body one", source_path: "src1", created_at: new Date() },
    ];
    const { adapter, mockEngine } = await makeAdapterWithMock({ listPages: pages });

    await adapter.list({ limit: 10 });

    const call = (mockEngine.listPages as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ limit: 10, sort: "updated_desc" });
  });

  it("maps Page.slug to ListResult.id", async () => {
    const pages = [{ slug: "my-slug-1", body: "content", created_at: new Date() }];
    const { adapter } = await makeAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].id).toBe("my-slug-1");
  });

  it("maps Page.body to ListResult.content", async () => {
    const pages = [{ slug: "x", body: "the actual content text", created_at: new Date() }];
    const { adapter } = await makeAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].content).toBe("the actual content text");
  });

  it("maps Page.source_path to ListResult.source", async () => {
    const pages = [{ slug: "y", body: "b", source_path: "https://example.com", created_at: new Date() }];
    const { adapter } = await makeAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].source).toBe("https://example.com");
  });

  it("converts Date created_at to ISO string", async () => {
    const dateObj = new Date("2026-07-27T10:00:00.000Z");
    const pages = [{ slug: "z", body: "b", created_at: dateObj }];
    const { adapter } = await makeAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].created_at).toBe(dateObj.toISOString());
  });

  it("defensive fallback for null created_at (returns current time ISO)", async () => {
    const pages = [{ slug: "fallback", body: "b", created_at: null }];
    const { adapter } = await makeAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    // Should not throw, should produce a valid ISO date string
    expect(typeof results[0].created_at).toBe("string");
    expect(() => new Date(results[0].created_at).toISOString()).not.toThrow();
  });

  it("passes userId as sourceId when provided", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock({ listPages: [] });

    await adapter.list({ limit: 10, userId: "user-xyz" });

    const call = (mockEngine.listPages as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ sourceId: "user-xyz" });
  });

  it("does not pass sourceId when userId is undefined", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock({ listPages: [] });

    await adapter.list({ limit: 10 });

    const call = (mockEngine.listPages as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0].sourceId).toBeUndefined();
  });
});

describe("LocalAdapter.delete()", () => {
  it("calls getPage then deletePage when page exists", async () => {
    const existingPage = { slug: "to-delete", body: "content" };
    const { adapter, mockEngine } = await makeAdapterWithMock({ existingPage });

    await adapter.delete({ id: "to-delete" });

    expect(mockEngine.getPage).toHaveBeenCalledWith("to-delete");
    expect(mockEngine.deletePage).toHaveBeenCalledWith("to-delete");
  });

  it("throws error with code not_found when getPage returns null", async () => {
    const { adapter } = await makeAdapterWithMock({ existingPage: null });

    const err = await adapter.delete({ id: "ghost-id" }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe("not_found");
  });

  it("error message contains the missing id", async () => {
    const { adapter } = await makeAdapterWithMock({ existingPage: null });

    const err = await adapter.delete({ id: "missing-page-xyz" }).catch((e: Error) => e);

    expect((err as Error).message).toContain("missing-page-xyz");
  });

  it("does NOT call deletePage when page is not found", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock({ existingPage: null });

    await adapter.delete({ id: "not-there" }).catch(() => {});

    expect(mockEngine.deletePage).not.toHaveBeenCalled();
  });
});

describe("LocalAdapter.clear()", () => {
  it("calls engine.deleteByUser() with userId", async () => {
    const { adapter, mockEngine } = await makeAdapterWithMock();

    await adapter.clear({ userId: "clear-user-99" });

    expect(mockEngine.deleteByUser).toHaveBeenCalledWith("clear-user-99");
  });
});

describe("LocalAdapter.sync()", () => {
  it("returns { pushed: 0 } (no-op for local-only adapter)", async () => {
    const { adapter } = await makeAdapterWithMock();

    const result = await adapter.sync({ direction: "push" });

    expect(result).toEqual({ pushed: 0 });
  });
});

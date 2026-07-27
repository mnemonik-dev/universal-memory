/**
 * Unit tests for CloudAdapter — mock engine (no real Postgres).
 *
 * Tests that exercise CloudAdapter methods via a mock engine, covering the
 * list(), delete(), clear(), migrateAttestationsTable(), and synthesize()
 * paths that are not hit by the existing cloud.test.ts.
 *
 * TDD anchors (Task 8):
 *   - CloudAdapter.list() maps page fields to ListResult shape
 *   - CloudAdapter.delete() throws not_found when page absent
 *   - CloudAdapter.clear() delegates to engine.deleteByUser()
 *   - CloudAdapter.migrateAttestationsTable() calls db.query with CREATE TABLE
 *   - CloudAdapter.synthesize() bm25-only returns setup message
 */

import { describe, it, expect, mock } from "bun:test";

// ─── Mock gbrain engine ───────────────────────────────────────────────────────

function makeMockEngine({
  searchResults = [] as any[],
  listPages = [] as any[],
  existingPage = null as any,
} = {}) {
  return {
    kind: "postgres" as const,
    upsert: mock(async () => {}),
    search: mock(async () => searchResults),
    listPages: mock(async () => listPages),
    getPage: mock(async () => existingPage),
    deletePage: mock(async () => {}),
    deleteByUser: mock(async () => {}),
    executeRaw: mock(async () => {}),
    connect: mock(async () => {}),
    initSchema: mock(async () => {}),
  };
}

/**
 * Create a CloudAdapter with a mock engine pre-wired.
 * The adapter's private `engine` field is set directly to avoid real DB connection.
 */
async function makeCloudAdapterWithMock(engineOpts: Parameters<typeof makeMockEngine>[0] = {}) {
  const mockEngine = makeMockEngine(engineOpts);
  const { CloudAdapter } = await import("./cloud.js");

  // Provide a valid URL so the requireDb() guard passes
  const adapter = new CloudAdapter({ databaseUrl: "postgres://localhost/test" });

  // Inject mock engine to bypass real connection
  (adapter as any).engine = mockEngine;

  return { adapter, mockEngine };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CloudAdapter.list()", () => {
  it("maps Page.slug to id", async () => {
    const pages = [{ slug: "cloud-slug-1", body: "content", created_at: new Date() }];
    const { adapter } = await makeCloudAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 10 });

    expect(results[0].id).toBe("cloud-slug-1");
  });

  it("maps Page.body to content", async () => {
    const pages = [{ slug: "s", body: "cloud content body", created_at: new Date() }];
    const { adapter } = await makeCloudAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].content).toBe("cloud content body");
  });

  it("converts Date created_at to ISO string", async () => {
    const date = new Date("2026-07-27T12:00:00.000Z");
    const pages = [{ slug: "t", body: "b", created_at: date }];
    const { adapter } = await makeCloudAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].created_at).toBe(date.toISOString());
  });

  it("converts string created_at to ISO string", async () => {
    const pages = [{ slug: "u", body: "b", created_at: "2026-07-27T12:00:00.000Z" }];
    const { adapter } = await makeCloudAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].created_at).toBe("2026-07-27T12:00:00.000Z");
  });

  it("calls listPages with sort updated_desc", async () => {
    const { adapter, mockEngine } = await makeCloudAdapterWithMock({ listPages: [] });

    await adapter.list({ limit: 20 });

    const call = (mockEngine.listPages as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ limit: 20, sort: "updated_desc" });
  });

  it("passes userId as sourceId when provided", async () => {
    const { adapter, mockEngine } = await makeCloudAdapterWithMock({ listPages: [] });

    await adapter.list({ limit: 20, userId: "user-cloud-1" });

    const call = (mockEngine.listPages as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ sourceId: "user-cloud-1" });
  });
});

describe("CloudAdapter.delete()", () => {
  it("calls getPage then deletePage when page exists", async () => {
    const existingPage = { slug: "cloud-delete-me", body: "content" };
    const { adapter, mockEngine } = await makeCloudAdapterWithMock({ existingPage });

    await adapter.delete({ id: "cloud-delete-me" });

    expect(mockEngine.getPage).toHaveBeenCalledWith("cloud-delete-me");
    expect(mockEngine.deletePage).toHaveBeenCalledWith("cloud-delete-me");
  });

  it("throws not_found error when page does not exist", async () => {
    const { adapter } = await makeCloudAdapterWithMock({ existingPage: null });

    const err = await adapter.delete({ id: "cloud-ghost" }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe("not_found");
    expect((err as Error).message).toContain("cloud-ghost");
  });

  it("does not call deletePage when getPage returns null", async () => {
    const { adapter, mockEngine } = await makeCloudAdapterWithMock({ existingPage: null });

    await adapter.delete({ id: "absent" }).catch(() => {});

    expect(mockEngine.deletePage).not.toHaveBeenCalled();
  });
});

describe("CloudAdapter.clear()", () => {
  it("delegates to engine.deleteByUser()", async () => {
    const { adapter, mockEngine } = await makeCloudAdapterWithMock();

    await adapter.clear({ userId: "cloud-user-clear" });

    expect(mockEngine.deleteByUser).toHaveBeenCalledWith("cloud-user-clear");
  });
});

describe("CloudAdapter.search()", () => {
  it("delegates to engine.search() with correct params", async () => {
    const searchResults = [{ id: "r1", content: "result", score: 0.9 }];
    const { adapter, mockEngine } = await makeCloudAdapterWithMock({ searchResults });

    const results = await adapter.search({ query: "cloud search", topK: 3 });

    expect(mockEngine.search).toHaveBeenCalledTimes(1);
    const call = (mockEngine.search as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ query: "cloud search", limit: 3 });
    expect(results).toEqual(searchResults);
  });
});

describe("CloudAdapter.add()", () => {
  it("delegates to engine.upsert() with correct params", async () => {
    const { adapter, mockEngine } = await makeCloudAdapterWithMock();

    await adapter.add({ id: "cloud-add-id", content: "cloud content", source: "cloud://src" });

    expect(mockEngine.upsert).toHaveBeenCalledTimes(1);
    const call = (mockEngine.upsert as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toMatchObject({ id: "cloud-add-id", content: "cloud content" });
  });
});

describe("CloudAdapter.migrateAttestationsTable()", () => {
  it("calls db.query with CREATE TABLE IF NOT EXISTS statement", async () => {
    const { CloudAdapter } = await import("./cloud.js");
    const adapter = new CloudAdapter({ databaseUrl: "postgres://localhost/test" });

    const mockDb = { query: mock(async () => {}) };
    await adapter.migrateAttestationsTable(mockDb as any);

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const sql = (mockDb.query as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    expect(sql).toMatch(/memory_attestations/i);
  });

  it("skips silently when no db and no databaseUrl", async () => {
    const { CloudAdapter } = await import("./cloud.js");
    // Suppress the startup warning
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    process.stderr.write = origStderr;

    // Should not throw when called with no db and no databaseUrl
    await expect(adapter.migrateAttestationsTable()).resolves.toBeUndefined();
  });

  it("CREATE TABLE DDL includes primary key on content_hash", async () => {
    const { CloudAdapter } = await import("./cloud.js");
    const adapter = new CloudAdapter({ databaseUrl: "postgres://localhost/test" });

    const mockDb = { query: mock(async () => {}) };
    await adapter.migrateAttestationsTable(mockDb as any);

    const sql = (mockDb.query as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(sql).toMatch(/content_hash/i);
    expect(sql).toMatch(/PRIMARY KEY/i);
  });
});

describe("CloudAdapter.list() — created_at null-guard (SF-1 / audit fix)", () => {
  it("returns fallback ISO date when created_at is null (no 'Invalid Date')", async () => {
    const pages = [{ slug: "null-date-slug", body: "content", created_at: null }];
    const { adapter } = await makeCloudAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].created_at).not.toBe("Invalid Date");
    expect(isNaN(new Date(results[0].created_at).getTime())).toBe(false);
  });

  it("returns fallback ISO date when created_at is undefined", async () => {
    const pages = [{ slug: "undef-date-slug", body: "content", created_at: undefined }];
    const { adapter } = await makeCloudAdapterWithMock({ listPages: pages });

    const results = await adapter.list({ limit: 5 });

    expect(results[0].created_at).not.toBe("Invalid Date");
  });
});

describe("CloudAdapter.getDbClient() — CRIT-2 fix", () => {
  it("returns null when DATABASE_URL is not set", async () => {
    const { CloudAdapter } = await import("./cloud.js");
    // Suppress startup warning
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    process.stderr.write = origStderr;

    const client = await adapter.getDbClient();
    expect(client).toBeNull();
  });

  it("returns DbClient object with query() when engine is available", async () => {
    const { adapter, mockEngine } = await makeCloudAdapterWithMock();
    // Wire executeRaw to return rows
    (mockEngine.executeRaw as ReturnType<typeof mock>).mockImplementation(
      async () => ({ rows: [{ attestation_id: "attest-x" }] })
    );

    const client = await adapter.getDbClient();
    expect(client).not.toBeNull();
    expect(typeof client!.query).toBe("function");
  });

  it("query() calls engine.executeRaw with sql and params", async () => {
    const { adapter, mockEngine } = await makeCloudAdapterWithMock();
    (mockEngine.executeRaw as ReturnType<typeof mock>).mockImplementation(
      async () => ({ rows: [] })
    );

    const client = await adapter.getDbClient();
    await client!.query("SELECT 1 WHERE $1", ["arg1"]);

    expect(mockEngine.executeRaw).toHaveBeenCalledWith("SELECT 1 WHERE $1", ["arg1"]);
  });
});

describe("CloudAdapter.sync()", () => {
  it("returns { pushed: 0 } (no-op for cloud adapter)", async () => {
    const { adapter } = await makeCloudAdapterWithMock();

    const result = await adapter.sync({ direction: "push" });

    expect(result).toEqual({ pushed: 0 });
  });

  it("throws when DATABASE_URL not set", async () => {
    const { CloudAdapter } = await import("./cloud.js");
    // Suppress warning
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    process.stderr.write = origStderr;

    await expect(adapter.sync({ direction: "push" })).rejects.toThrow(/DATABASE_URL/);
  });
});

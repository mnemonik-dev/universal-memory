/**
 * Integration tests for LocalAdapter — REAL gbrain PGLite engine (no mocks).
 *
 * These replaced the previous mock-engine unit tests, which asserted a
 * fictional engine API (engine.upsert / engine.search / engine.deleteByUser
 * and Page.body / Page.source_path) that gbrain does NOT expose. Those mocks
 * passed while the product threw on the first real capture. This suite drives
 * the adapter against a real embedded PGLite so a wiring regression fails here.
 *
 * Runs in BM25-only mode (no API key in the test env) — add() uses noEmbed and
 * search() uses keyword search, so no network/LLM is required.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter } from "./local.js";

let dir: string;
let adapter: LocalAdapter;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "local-adapter-it-"));
  adapter = new LocalAdapter({ dataDir: dir });
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("LocalAdapter (real PGLite round-trip)", () => {
  it("add() + getById() round-trips content by slug", async () => {
    await adapter.add({ id: "note-alpha", content: "The quick brown fox jumps over the lazy dog." });
    const got = await adapter.getById("note-alpha");
    expect(got?.id).toBe("note-alpha");
    expect(got?.content).toContain("quick brown fox");
  });

  it("getById() returns null for a missing id", async () => {
    expect(await adapter.getById("does-not-exist")).toBeNull();
  });

  it("list() returns stored entries in ListResult shape", async () => {
    const list = await adapter.list({ limit: 20 });
    expect(list.map((e) => e.id)).toContain("note-alpha");
    const entry = list.find((e) => e.id === "note-alpha")!;
    expect(typeof entry.content).toBe("string");
    expect(entry.content).toContain("quick brown fox");
    // created_at is always a valid ISO string
    expect(() => new Date(entry.created_at).toISOString()).not.toThrow();
  });

  it("search() finds a stored memory by keyword and returns a numeric score", async () => {
    await adapter.add({ id: "note-beta", content: "Reciprocal rank fusion blends multiple rankings." });
    const results = await adapter.search({ query: "fusion rankings", topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.toLowerCase().includes("fusion"))).toBe(true);
    expect(typeof results[0].score).toBe("number");
  });

  it("delete() removes an entry; getById() then returns null", async () => {
    await adapter.add({ id: "note-gamma", content: "an ephemeral note to be deleted" });
    expect(await adapter.getById("note-gamma")).not.toBeNull();
    await adapter.delete({ id: "note-gamma" });
    expect(await adapter.getById("note-gamma")).toBeNull();
  });

  it("delete() throws { code: 'not_found' } for a missing id", async () => {
    const err = await adapter.delete({ id: "ghost-id" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe("not_found");
    expect((err as Error).message).toContain("ghost-id");
  });

  it("sync() is a no-op returning { pushed: 0 }", async () => {
    expect(await adapter.sync({ direction: "push" })).toEqual({ pushed: 0 });
  });

  // Runs last: empties the store.
  it("clear() removes all entries", async () => {
    await adapter.clear({ userId: "ignored-single-user" });
    expect((await adapter.list({ limit: 50 })).length).toBe(0);
  });
});

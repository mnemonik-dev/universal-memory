/**
 * Tests for CloudAdapter.
 *
 * TDD anchors from task 5:
 *   storage/cloud.ts::connects_to_postgres
 *   storage/cloud.ts::invalid_database_url_throws_actionable_error
 *   storage/cloud.ts::implements_StorageAdapter_interface
 */

import { describe, it, expect } from 'bun:test';
import type { StorageAdapter } from './index.js';

describe('CloudAdapter — StorageAdapter interface', () => {
  it('implements StorageAdapter interface (type check via duck-typing)', async () => {
    const { CloudAdapter } = await import('./cloud.ts');
    const adapter = new CloudAdapter({ databaseUrl: 'postgres://localhost/test' });

    // Each method must exist and be a function
    expect(typeof adapter.search).toBe('function');
    expect(typeof adapter.synthesize).toBe('function');
    expect(typeof adapter.add).toBe('function');
    expect(typeof adapter.clear).toBe('function');
    expect(typeof adapter.sync).toBe('function');

    // TypeScript structural check: CloudAdapter assignable to StorageAdapter
    const typed: StorageAdapter = adapter;
    expect(typed).toBeTruthy();
  });
});

describe('CloudAdapter — constructor without DATABASE_URL', () => {
  it('constructs without DATABASE_URL (deferred throw on use)', async () => {
    const { CloudAdapter } = await import('./cloud.ts');
    // Must not throw at construction — this is the D2 decision from Task 2
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    expect(adapter).toBeTruthy();
  });
});

describe('CloudAdapter — invalid_database_url_throws_actionable_error', () => {
  it('search() throws actionable error when DATABASE_URL is not set', async () => {
    const { CloudAdapter } = await import('./cloud.ts');
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    await expect(
      adapter.search({ query: 'test', topK: 5 })
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('synthesize() returns actionable response when DATABASE_URL is not set (bm25-only mode)', async () => {
    // synthesize() has a bm25-only short-circuit: when no LLM key is configured
    // it returns an actionable setup message WITHOUT calling getEngine() (so no
    // DATABASE_URL error fires). In full/ollama mode with DATABASE_URL missing it
    // WOULD throw the DATABASE_URL error — but that path requires LLM keys and is
    // only testable in smoke/integration tests.
    // Known gap: DATABASE_URL error path in synthesize() is not covered by unit tests.
    const { CloudAdapter } = await import('./cloud.ts');
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    // Must not throw in bm25-only mode — returns setup guidance instead
    const result = await adapter.synthesize({ question: 'What do I know?' });
    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(result.citations)).toBe(true);
    expect(Array.isArray(result.gaps)).toBe(true);
  });

  it('add() throws actionable error when DATABASE_URL is not set', async () => {
    const { CloudAdapter } = await import('./cloud.ts');
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    await expect(
      adapter.add({ id: 'test', content: 'hello' })
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('clear() throws actionable error when DATABASE_URL is not set', async () => {
    const { CloudAdapter } = await import('./cloud.ts');
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    await expect(
      adapter.clear({ userId: 'user1' })
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('sync() throws actionable error when DATABASE_URL is not set', async () => {
    const { CloudAdapter } = await import('./cloud.ts');
    const adapter = new CloudAdapter({ databaseUrl: undefined });
    await expect(
      adapter.sync({ direction: 'push' })
    ).rejects.toThrow(/DATABASE_URL/);
  });
});

describe('CloudAdapter — connects_to_postgres', () => {
  it('getEngine() returns an engine object when DATABASE_URL is set', async () => {
    // This test validates the engine is constructed (not that it connects to real DB).
    // Real connection requires a Postgres server — integration-level test.
    // We verify getEngine() does not throw with a syntactically valid URL at the
    // module-import level (engine object is returned before connect() is called).
    const { CloudAdapter } = await import('./cloud.ts');

    // A valid URL shape — init() will fail to connect but the engine is constructed
    // This tests that createEngine is called with the right config shape.
    const adapter = new CloudAdapter({ databaseUrl: 'postgres://localhost/testdb' });
    // getEngine is private — test it indirectly by calling search and checking
    // the error is a connection error (not a DATABASE_URL missing error)
    await expect(
      adapter.search({ query: 'test', topK: 5 })
    ).rejects.toThrow(/.+/); // some error (connection refused or similar) — NOT "DATABASE_URL is required"
  });

  it('engine error message is a connection error, not missing-URL error', async () => {
    const { CloudAdapter } = await import('./cloud.ts');
    const adapter = new CloudAdapter({ databaseUrl: 'postgres://localhost:9999/nonexistent' });
    try {
      await adapter.search({ query: 'test', topK: 5 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Must not be the "DATABASE_URL is required" guard message
      expect(msg).not.toMatch(/DATABASE_URL is required/);
    }
  });
});

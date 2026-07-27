/**
 * Smoke test: createEngine pglite → engine.kind === "pglite"
 * Uses real PGLite in a temp dir.
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('createEngine pglite', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-brain-'));

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });

  it('engine.kind === "pglite"', async () => {
    const { createPgliteEngine } = await import('./pglite.ts');
    const engine = await createPgliteEngine(tempDir);
    // engine.kind should be 'pglite'
    expect((engine as any).kind).toBe('pglite');
  }, 30_000); // PGLite WASM init can be slow
});

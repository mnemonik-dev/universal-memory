/**
 * PGLite engine initializer for Universal Memory Hub.
 *
 * Wraps gbrain's createEngine() factory to create a ready-to-use PGLite
 * engine from a data directory path. Ensures the data directory exists
 * before passing it to createEngine.
 */

import { createEngine } from 'gbrain/engine-factory';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Create a connected and schema-initialized PGLite brain engine.
 *
 * @param dataDir - Directory where PGLite stores its data. Created if absent.
 * @returns A connected BrainEngine instance ready for use.
 */
export async function createPgliteEngine(dataDir: string): Promise<ReturnType<typeof createEngine> extends Promise<infer T> ? T : never> {
  // Ensure data directory exists. PGLite may fail silently without it.
  const pgliteDir = join(dataDir, '.pglite');
  mkdirSync(pgliteDir, { recursive: true });

  // createEngine uses database_path for the PGLite data dir
  const engine = await createEngine({
    engine: 'pglite',
    database_path: pgliteDir,
  });

  await engine.connect({});
  await engine.initSchema();

  return engine as any;
}

/**
 * LocalAdapter — PGLite (embedded Postgres via WASM), zero server required.
 * Uses gbrain's pglite-engine under the hood.
 * Git-backed: memories are markdown files in gitDir, PGLite is the search index.
 */

import type { StorageAdapter, SearchResult } from "./index.js";

export class LocalAdapter implements StorageAdapter {
  private engine: any; // gbrain Engine type
  private gitDir: string;

  constructor({ gitDir }: { gitDir?: string }) {
    this.gitDir = gitDir ?? process.env.HOME + "/.universal-memory/brain";
  }

  async init() {
    // Lazy-load gbrain to avoid startup cost when not needed
    const { createPgliteEngine } = await import("gbrain/pglite-engine");
    this.engine = await createPgliteEngine({ dataDir: this.gitDir + "/.pglite" });
  }

  private async getEngine() {
    if (!this.engine) await this.init();
    return this.engine;
  }

  async search({ query, userId, topK }: { query: string; userId?: string; topK: number }): Promise<SearchResult[]> {
    const engine = await this.getEngine();
    return engine.search({ query, userId, limit: topK });
  }

  async synthesize({ question, userId }: { question: string; userId?: string }): Promise<string> {
    const engine = await this.getEngine();
    return engine.synthesize({ question, userId });
  }

  async add({ id, content, source, userId, signature }: {
    id: string; content: string; source?: string; userId?: string; signature?: string;
  }): Promise<void> {
    const engine = await this.getEngine();
    await engine.upsert({ id, content, source, userId, metadata: signature ? { signature } : undefined });
  }

  async clear({ userId }: { userId: string }): Promise<void> {
    const engine = await this.getEngine();
    await engine.deleteByUser(userId);
  }

  async sync(_: { direction: string }): Promise<{ pushed?: number; pulled?: number }> {
    // Local-only adapter: no-op for sync (nothing to push to)
    return { pushed: 0 };
  }
}

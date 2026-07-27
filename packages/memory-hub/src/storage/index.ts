/**
 * Storage abstraction — same interface for local PGLite and cloud Postgres.
 * Delegates to gbrain's engine-factory for the actual implementation.
 */

export interface SearchResult {
  id: string;
  content: string;
  source?: string;
  score: number;
  signature?: string;
}

/** Output shape for the memory_think MCP tool. */
export interface SynthesisResult {
  answer: string;
  citations: Array<{ id: string; excerpt: string }>;
  gaps: string[];
}

export interface StorageAdapter {
  search(opts: { query: string; userId?: string; topK: number }): Promise<SearchResult[]>;
  synthesize(opts: { question: string; userId?: string }): Promise<SynthesisResult>;
  add(opts: { id: string; content: string; source?: string; userId?: string; signature?: string }): Promise<void>;
  clear(opts: { userId: string }): Promise<void>;
  sync(opts: { direction: string }): Promise<{ pushed?: number; pulled?: number }>;
}

export interface StorageConfig {
  backend: "local" | "cloud" | "hybrid";
  gitDir?: string;
  databaseUrl?: string;
}

export class StorageFactory {
  static async create(config: StorageConfig): Promise<StorageAdapter> {
    switch (config.backend) {
      case "local":
        const { LocalAdapter } = await import("./local.js");
        return new LocalAdapter({ gitDir: config.gitDir });
      case "cloud":
        const { CloudAdapter } = await import("./cloud.js");
        return new CloudAdapter({ databaseUrl: config.databaseUrl! });
      case "hybrid":
        const { HybridAdapter } = await import("./hybrid.js");
        return new HybridAdapter({
          gitDir: config.gitDir,
          databaseUrl: config.databaseUrl!,
        });
      default:
        throw new Error(`Unknown storage backend: ${config.backend}`);
    }
  }
}

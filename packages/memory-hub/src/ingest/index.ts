/**
 * IngestPipeline — multi-source content ingestion.
 * Chunks, embeds, and routes content to the storage adapter.
 * Sources: text, URL, file, conversation transcript, research result.
 */

import crypto from "node:crypto";
import type { StorageAdapter } from "../storage/index.js";

interface IngestOpts {
  content: string;
  source?: string;
  userId?: string;
}

interface IngestResult {
  id: string;
  chunks: number;
}

export class IngestPipeline {
  constructor(private storage: StorageAdapter) {}

  async add(opts: IngestOpts): Promise<IngestResult> {
    const id = crypto.randomUUID();
    const chunks = this.chunk(opts.content);

    for (let i = 0; i < chunks.length; i++) {
      await this.storage.add({
        id: chunks.length === 1 ? id : `${id}-${i}`,
        content: chunks[i],
        source: opts.source,
        userId: opts.userId,
      });
    }

    return { id, chunks: chunks.length };
  }

  // Simple sliding-window chunker — replace with gbrain's chunker once integrated
  private chunk(text: string, maxChars = 2000, overlap = 200): string[] {
    if (text.length <= maxChars) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      chunks.push(text.slice(start, start + maxChars));
      start += maxChars - overlap;
    }
    return chunks;
  }
}

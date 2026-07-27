/**
 * ingest/pipeline.ts — Multi-content-type ingestion dispatcher
 *
 * Detects input content type and routes to the appropriate handler:
 * - Plain text → direct storage
 * - http/https URL → fetcher (Readability → markdown)
 * - Local file path (absolute or ~/) → file reader (PDF/md/code/image)
 * - base64 data URL (data:image/*;base64,...) → image handler
 *
 * Enforces content size limits (D8):
 * - Text content: 10MB max
 * - Image data URLs: 5MB max (base64-encoded payload)
 *
 * Uses StorageAdapter.add() to persist chunks.
 */

import crypto from "node:crypto";
import type { StorageAdapter } from "../storage/index.js";
import { fetchUrl } from "./fetcher.js";
import { readFile } from "./file.js";

/** Maximum text content size in bytes (D8). */
const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB

/** Maximum image data URL payload in bytes (D8 — 5MB for images). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

/** Sliding-window chunk size and overlap. */
const CHUNK_MAX_CHARS = 2000;
const CHUNK_OVERLAP = 200;

/**
 * Thrown when ingested content exceeds the allowed size limit (D8).
 */
export class ContentTooLargeError extends Error {
  readonly code = "content_too_large";
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number, contentType?: string) {
    const typeLabel = contentType ? ` (${contentType})` : "";
    super(
      `Content too large${typeLabel}: ${actualBytes} bytes exceeds limit of ${maxBytes} bytes`
    );
    this.name = "ContentTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export interface DispatchOpts {
  content: string;
  source?: string;
  userId?: string;
}

export interface DispatchResult {
  id: string;
  chunks: number;
}

/**
 * Detect the content type of the input string.
 */
type ContentType = "url" | "file" | "image" | "text";

function detectContentType(content: string): ContentType {
  // base64 data URL: data:image/*;base64,...
  if (/^data:image\/[a-z+]+;base64,/i.test(content)) {
    return "image";
  }

  // HTTP/HTTPS URL
  if (/^https?:\/\//i.test(content)) {
    return "url";
  }

  // Absolute file path or ~/... path
  if (content.startsWith("/") || content.startsWith("~/") || content.startsWith("~\\")) {
    return "file";
  }

  return "text";
}

/**
 * Chunk text into overlapping windows for storage.
 */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_MAX_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + CHUNK_MAX_CHARS));
    start += CHUNK_MAX_CHARS - CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * Enforce the content size limit and throw ContentTooLargeError if exceeded.
 */
function assertSizeLimit(
  content: string,
  maxBytes: number,
  contentType?: string
): void {
  const byteLength = Buffer.byteLength(content, "utf-8");
  if (byteLength > maxBytes) {
    throw new ContentTooLargeError(byteLength, maxBytes, contentType);
  }
}

/**
 * IngestPipeline — dispatch content by type, chunk, and store.
 *
 * Constructor accepts a StorageAdapter. Call dispatch() for each ingestion.
 */
export class IngestPipeline {
  constructor(private storage: StorageAdapter) {}

  /**
   * Alias for dispatch() — used by server.ts MCP handler for memory_capture.
   * The name `add` reflects the MCP tool's intent: add content to memory.
   */
  async add(opts: DispatchOpts): Promise<DispatchResult> {
    return this.dispatch(opts);
  }

  /**
   * Dispatch content to the appropriate handler, chunk it, and store it.
   * Returns { id, chunks } on success.
   * Throws ContentTooLargeError if content exceeds size limits.
   */
  async dispatch(opts: DispatchOpts): Promise<DispatchResult> {
    const { source, userId } = opts;
    let content = opts.content;

    const contentType = detectContentType(content);

    // ── Image data URL ──────────────────────────────────────────────────────────
    if (contentType === "image") {
      // Size check on the base64 string length (this is what gets stored and
      // represents the storage cost; checking raw base64 chars avoids undercount
      // from the 3/4 decode ratio).
      const base64Part = content.split(",")[1] ?? "";
      if (base64Part.length > MAX_IMAGE_BYTES) {
        throw new ContentTooLargeError(base64Part.length, MAX_IMAGE_BYTES, "image");
      }

      // Store the data URL as-is (storage adapter + gbrain handles embedding)
      const id = crypto.randomUUID();
      await this.storage.add({
        id,
        content,
        source: source ?? "image",
        userId,
        signature: undefined,
      });
      return { id, chunks: 1 };
    }

    // ── URL → fetch → text ─────────────────────────────────────────────────────
    if (contentType === "url") {
      // fetchUrl throws SsrfBlockedError for blocked URLs; callers handle it
      content = await fetchUrl(content);
    }

    // ── File path → read → text ────────────────────────────────────────────────
    if (contentType === "file") {
      const result = await readFile(content);
      // Image files read as data URLs: apply image size limit
      if (result.content.startsWith("data:image/")) {
        const base64Part = result.content.split(",")[1] ?? "";
        if (base64Part.length > MAX_IMAGE_BYTES) {
          throw new ContentTooLargeError(base64Part.length, MAX_IMAGE_BYTES, "image");
        }
        const id = crypto.randomUUID();
        await this.storage.add({
          id,
          content: result.content,
          source: source ?? "file",
          userId,
          signature: undefined,
        });
        return { id, chunks: 1 };
      }
      content = result.content;
    }

    // ── Size guard for text content (text + fetched URLs + read files) ──────────
    assertSizeLimit(content, MAX_CONTENT_BYTES, "text");

    // ── Chunk and store ─────────────────────────────────────────────────────────
    const id = crypto.randomUUID();
    const chunks = chunkText(content);

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = chunks.length === 1 ? id : `${id}-${i}`;
      await this.storage.add({
        id: chunkId,
        content: chunks[i]!,
        source,
        userId,
        signature: undefined,
      });
    }

    return { id, chunks: chunks.length };
  }
}

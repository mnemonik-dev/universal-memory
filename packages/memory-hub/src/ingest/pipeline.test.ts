/**
 * Tests for ingest/pipeline.ts — dispatch() routing logic
 *
 * TDD anchors from task 3:
 *   - plain_text_routes_direct
 *   - http_url_calls_fetcher
 *   - file_path_calls_file_reader
 *   - base64_image_routes_to_image_handler
 *   - oversized_content_throws_content_too_large (>10MB)
 */

import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import type { StorageAdapter } from "../storage/index.js";

// --- Mock StorageAdapter ---
function createMockStorage(): StorageAdapter {
  return {
    add: mock(async () => {}),
    search: mock(async () => []),
    synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
    clear: mock(async () => {}),
    sync: mock(async () => ({})),
  };
}

describe("ingest/pipeline.ts", () => {
  describe("plain_text_routes_direct", () => {
    it("stores plain text directly without fetching", async () => {
      const storage = createMockStorage();
      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      const result = await pipeline.dispatch({ content: "hello world" });
      expect(result).toHaveProperty("id");
      expect(result.chunks).toBeGreaterThanOrEqual(1);
      expect(storage.add).toHaveBeenCalled();
    });

    it("returns { id, chunks } shape for plain text", async () => {
      const storage = createMockStorage();
      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      const result = await pipeline.dispatch({ content: "simple text content" });
      expect(typeof result.id).toBe("string");
      expect(typeof result.chunks).toBe("number");
      expect(result.id.length).toBeGreaterThan(0);
    });

    it("text that is not a URL or file path routes direct", async () => {
      const storage = createMockStorage();
      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      // Multi-line text
      const text = "This is a long paragraph.\n\nWith multiple lines.";
      const result = await pipeline.dispatch({ content: text });
      expect(result.chunks).toBeGreaterThanOrEqual(1);
    });
  });

  describe("http_url_calls_fetcher", () => {
    it("recognizes http:// URLs and calls fetcher (mocked)", async () => {
      const storage = createMockStorage();

      // Mock the fetcher module
      const fetcherMod = await import("./fetcher.js");
      const fetchUrlSpy = spyOn(fetcherMod, "fetchUrl").mockResolvedValue(
        "# Fetched Content\n\nThis is the article text."
      );

      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      const result = await pipeline.dispatch({
        content: "https://example.com/article",
      });

      expect(fetchUrlSpy).toHaveBeenCalledWith("https://example.com/article");
      expect(result).toHaveProperty("id");
      expect(result.chunks).toBeGreaterThanOrEqual(1);
      fetchUrlSpy.mockRestore();
    });

    it("recognizes https:// URLs and calls fetcher (mocked)", async () => {
      const storage = createMockStorage();

      const fetcherMod = await import("./fetcher.js");
      const fetchUrlSpy = spyOn(fetcherMod, "fetchUrl").mockResolvedValue(
        "Fetched markdown content"
      );

      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      await pipeline.dispatch({ content: "https://example.com" });
      expect(fetchUrlSpy).toHaveBeenCalled();
      fetchUrlSpy.mockRestore();
    });
  });

  describe("file_path_calls_file_reader", () => {
    it("recognizes absolute file paths and calls file reader (mocked)", async () => {
      const storage = createMockStorage();

      const fileMod = await import("./file.js");
      const readFileSpy = spyOn(fileMod, "readFile").mockResolvedValue({
        content: "# File Content\n\nMarkdown from file.",
        mimeType: "text/markdown",
      });

      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      const result = await pipeline.dispatch({ content: "/home/user/notes.md" });

      expect(readFileSpy).toHaveBeenCalledWith("/home/user/notes.md");
      expect(result).toHaveProperty("id");
      readFileSpy.mockRestore();
    });

    it("recognizes ~/ paths as file paths", async () => {
      const storage = createMockStorage();

      const fileMod = await import("./file.js");
      const readFileSpy = spyOn(fileMod, "readFile").mockResolvedValue({
        content: "File content from home",
        mimeType: "text/plain",
      });

      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      await pipeline.dispatch({ content: "~/documents/note.md" });
      expect(readFileSpy).toHaveBeenCalled();
      readFileSpy.mockRestore();
    });
  });

  describe("base64_image_routes_to_image_handler", () => {
    it("recognizes data:image/png;base64 prefix and routes to image handler", async () => {
      const storage = createMockStorage();
      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      // Small valid-ish base64 image string (1x1 PNG)
      const tinyPng =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const result = await pipeline.dispatch({ content: tinyPng });
      expect(result).toHaveProperty("id");
      expect(result.chunks).toBeGreaterThanOrEqual(1);
      expect(storage.add).toHaveBeenCalled();
    });

    it("recognizes data:image/jpeg;base64 prefix", async () => {
      const storage = createMockStorage();
      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      const fakeJpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA==";
      const result = await pipeline.dispatch({ content: fakeJpeg });
      expect(result).toHaveProperty("id");
    });
  });

  describe("oversized_content_throws_content_too_large", () => {
    it("throws content_too_large error for text > 10MB", async () => {
      const storage = createMockStorage();
      const { IngestPipeline, ContentTooLargeError } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      // Generate 11MB of text
      const oversized = "x".repeat(11 * 1024 * 1024);

      await expect(pipeline.dispatch({ content: oversized })).rejects.toThrow(
        ContentTooLargeError
      );
    });

    it("ContentTooLargeError has error field = 'content_too_large'", async () => {
      const storage = createMockStorage();
      const { IngestPipeline, ContentTooLargeError } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      const oversized = "x".repeat(11 * 1024 * 1024);

      try {
        await pipeline.dispatch({ content: oversized });
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ContentTooLargeError);
        expect((e as ContentTooLargeError).code).toBe("content_too_large");
      }
    });

    it("does not throw for content exactly at 10MB limit", async () => {
      const storage = createMockStorage();
      const { IngestPipeline } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      // Exactly 10MB (should be allowed)
      const atLimit = "x".repeat(10 * 1024 * 1024);
      const result = await pipeline.dispatch({ content: atLimit });
      expect(result).toHaveProperty("id");
    });

    it("image > 5MB throws content_too_large", async () => {
      const storage = createMockStorage();
      const { IngestPipeline, ContentTooLargeError } = await import("./pipeline.js");
      const pipeline = new IngestPipeline(storage);

      // 6MB base64 image
      const bigImage = "data:image/png;base64," + "A".repeat(6 * 1024 * 1024);

      await expect(pipeline.dispatch({ content: bigImage })).rejects.toThrow(
        ContentTooLargeError
      );
    });
  });
});

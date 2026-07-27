/**
 * Additional tests for ingest/pipeline.ts — covering gaps from pipeline.test.ts.
 *
 * TDD anchors (Task 8):
 *   - IngestPipeline.add() alias delegates to dispatch()
 *   - image > 5MB via file path throws ContentTooLargeError
 *   - file returning image data URL routes to image handler
 */

import { describe, it, expect, mock, spyOn } from "bun:test";
import type { StorageAdapter } from "../storage/index.js";

function createMockStorage(): StorageAdapter {
  return {
    add: mock(async () => {}),
    search: mock(async () => []),
    synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
    list: mock(async () => []),
    delete: mock(async () => {}),
    clear: mock(async () => {}),
    sync: mock(async () => ({})),
  };
}

describe("IngestPipeline.add() alias", () => {
  it("add() produces same result as dispatch() for plain text", async () => {
    const storage = createMockStorage();
    const { IngestPipeline } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    // Call via add() alias
    const result = await pipeline.add({ content: "test content via add alias" });

    expect(result).toHaveProperty("id");
    expect(typeof result.id).toBe("string");
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    expect(storage.add).toHaveBeenCalled();
  });

  it("add() alias calls storage.add() for each chunk", async () => {
    const storage = createMockStorage();
    const { IngestPipeline } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    const result = await pipeline.add({ content: "short text" });

    expect(result.chunks).toBe(1);
    expect((storage.add as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  it("add() alias passes source to storage.add()", async () => {
    const storage = createMockStorage();
    const { IngestPipeline } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    await pipeline.add({ content: "content with source", source: "https://source.example.com" });

    const addCall = (storage.add as ReturnType<typeof mock>).mock.calls[0];
    expect(addCall[0]).toMatchObject({ source: "https://source.example.com" });
  });

  it("add() alias returns UUID for id", async () => {
    const storage = createMockStorage();
    const { IngestPipeline } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    const result = await pipeline.add({ content: "UUID via add" });

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});

describe("IngestPipeline — file image size limit", () => {
  it("file path returning image data URL > 5MB throws ContentTooLargeError", async () => {
    const storage = createMockStorage();

    // Mock file reader to return an oversized image data URL
    const fileMod = await import("./file.js");
    const bigBase64 = "A".repeat(6 * 1024 * 1024); // 6MB base64 (> 5MB limit)
    const readFileSpy = spyOn(fileMod, "readFile").mockResolvedValue({
      content: `data:image/png;base64,${bigBase64}`,
      mimeType: "image/png",
    });

    const { IngestPipeline, ContentTooLargeError } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    await expect(
      pipeline.dispatch({ content: "/home/user/big-image.png" })
    ).rejects.toThrow(ContentTooLargeError);

    readFileSpy.mockRestore();
  });

  it("file path returning image data URL <= 5MB succeeds", async () => {
    const storage = createMockStorage();

    // Mock file reader to return a small image data URL
    const fileMod = await import("./file.js");
    const smallBase64 = "A".repeat(100); // tiny
    const readFileSpy = spyOn(fileMod, "readFile").mockResolvedValue({
      content: `data:image/png;base64,${smallBase64}`,
      mimeType: "image/png",
    });

    const { IngestPipeline } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    const result = await pipeline.dispatch({ content: "/home/user/small-image.png" });

    expect(result.chunks).toBe(1);
    expect(storage.add).toHaveBeenCalled();
    readFileSpy.mockRestore();
  });
});

describe("IngestPipeline — URL fetch error propagation", () => {
  it("fetchUrl error propagates from dispatch()", async () => {
    const storage = createMockStorage();

    const fetcherMod = await import("./fetcher.js");
    const { SsrfBlockedError } = fetcherMod;
    const readUrlSpy = spyOn(fetcherMod, "fetchUrl").mockRejectedValue(
      new SsrfBlockedError("Blocked private IP")
    );

    const { IngestPipeline } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    await expect(
      pipeline.dispatch({ content: "http://192.168.1.1/data" })
    ).rejects.toThrow(SsrfBlockedError);

    readUrlSpy.mockRestore();
  });
});

describe("IngestPipeline — ContentTooLargeError properties", () => {
  it("ContentTooLargeError.maxBytes contains the limit value", async () => {
    const storage = createMockStorage();
    const { IngestPipeline, ContentTooLargeError } = await import("./pipeline.js");
    const pipeline = new IngestPipeline(storage);

    const oversized = "x".repeat(11 * 1024 * 1024);
    try {
      await pipeline.dispatch({ content: oversized });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ContentTooLargeError);
      const err = e as InstanceType<typeof ContentTooLargeError>;
      expect(err.maxBytes).toBe(10 * 1024 * 1024);
    }
  });

  it("ContentTooLargeError.name is ContentTooLargeError", async () => {
    const { ContentTooLargeError } = await import("./pipeline.js");
    const err = new ContentTooLargeError(11_000_000, 10_000_000, "text");
    expect(err.name).toBe("ContentTooLargeError");
  });

  it("ContentTooLargeError.code is content_too_large", async () => {
    const { ContentTooLargeError } = await import("./pipeline.js");
    const err = new ContentTooLargeError(11_000_000, 10_000_000);
    expect(err.code).toBe("content_too_large");
  });
});

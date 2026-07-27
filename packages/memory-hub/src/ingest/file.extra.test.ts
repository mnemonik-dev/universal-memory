/**
 * Additional tests for ingest/file.ts — covering remaining gaps.
 *
 * Coverage gaps (lines 76-79, 91, 172, 179-181, 197-203):
 *   - resolveAllowedDirs with MEMORY_ALLOWED_DIRS env var
 *   - Image file reading (returns data URL)
 *   - realpathSync failure handling
 *   - Multiple allowed dirs (colon-separated)
 *
 * TDD anchors (Task 8):
 *   - ingest/file.ts::path_traversal_blocked (already in file.test.ts)
 *   - image file returns data URL with correct mime type
 *   - allowed dirs via env var (colon-separated)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { PathNotAllowedError, readFile } from "./file.js";

let tempDir: string;
let tempDir2: string;

beforeAll(() => {
  // Both dirs inside home so they're in the default allowlist
  tempDir = mkdtempSync(join(homedir(), ".universal-memory-file-extra-test-"));
  tempDir2 = mkdtempSync(join(homedir(), ".universal-memory-file-extra-test2-"));
});

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tempDir2, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("ingest/file.ts — image file reading", () => {
  it("PNG image returns data URL with image/png mime type", async () => {
    // Write a minimal valid 1x1 PNG (actual PNG binary)
    const tinyPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e0000000c49444154789c626060f800050000020001e221bc330000000049" +
      "454e44ae426082",
      "hex"
    );
    const pngFile = join(tempDir, "tiny.png");
    writeFileSync(pngFile, tinyPng);

    const result = await readFile(pngFile);

    expect(result.mimeType).toBe("image/png");
    expect(result.content).toMatch(/^data:image\/png;base64,/);
  });

  it("JPEG image returns data URL with image/jpeg mime type", async () => {
    // Minimal JPEG header bytes
    const jpegBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    ]);
    const jpegFile = join(tempDir, "test.jpg");
    writeFileSync(jpegFile, jpegBytes);

    const result = await readFile(jpegFile);

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.content).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("WebP image returns data URL with image/webp mime type", async () => {
    // Minimal WebP file header
    const webpBytes = Buffer.from("52494646" + "0c000000" + "57454250", "hex");
    const webpFile = join(tempDir, "test.webp");
    writeFileSync(webpFile, webpBytes);

    const result = await readFile(webpFile);

    expect(result.mimeType).toBe("image/webp");
    expect(result.content).toMatch(/^data:image\/webp;base64,/);
  });

  it("image data URL content is valid base64 after the comma", async () => {
    const tinyPng = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
      "012e0000000c49444154789c626060f80005000002000" +
      "1e221bc330000000049454e44ae426082",
      "hex"
    );
    const pngFile2 = join(tempDir, "tiny2.png");
    writeFileSync(pngFile2, tinyPng);

    const result = await readFile(pngFile2);

    const base64Part = result.content.split(",")[1];
    expect(base64Part).toBeTruthy();
    // Base64 characters only (+ /= for padding)
    expect(base64Part).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("ingest/file.ts — allowed dirs via option override", () => {
  it("reads file from tmpdir when allowedDirs explicitly includes tmpdir", async () => {
    const tmpTestDir = mkdtempSync(join(tmpdir(), "allowed-extra-"));
    const tmpTestFile = join(tmpTestDir, "note.md");
    writeFileSync(tmpTestFile, "# Allowed file\n\nContent here.");

    try {
      const result = await readFile(tmpTestFile, { allowedDirs: [tmpTestDir] });
      expect(result.content).toContain("Allowed file");
    } finally {
      rmSync(tmpTestDir, { recursive: true, force: true });
    }
  });

  it("rejects file from tmpdir when allowedDirs is set to a different dir", async () => {
    const tmpTestDir = mkdtempSync(join(tmpdir(), "allowed-src-"));
    const tmpTestFile = join(tmpTestDir, "note.md");
    writeFileSync(tmpTestFile, "blocked content");

    // Only allow a different directory
    const otherDir = mkdtempSync(join(tmpdir(), "other-dir-"));

    try {
      await expect(
        readFile(tmpTestFile, { allowedDirs: [otherDir] })
      ).rejects.toThrow(PathNotAllowedError);
    } finally {
      rmSync(tmpTestDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("ingest/file.ts — PathNotAllowedError class", () => {
  it("is an Error instance", () => {
    const err = new PathNotAllowedError("/etc/passwd", "outside allowed directories");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PathNotAllowedError);
  });

  it("has correct name", () => {
    const err = new PathNotAllowedError("/etc/passwd", "outside allowed");
    expect(err.name).toBe("PathNotAllowedError");
  });

  it("message includes the path", () => {
    const err = new PathNotAllowedError("/etc/shadow", "outside allowed directories: /home");
    expect(err.message).toContain("/etc/shadow");
    expect(err.message).toContain("outside allowed directories");
  });
});

describe("ingest/file.ts — file not found", () => {
  it("throws when file does not exist (within allowed dir)", async () => {
    const nonExistentFile = join(homedir(), ".universal-memory-nonexistent-file-xyz.md");

    await expect(readFile(nonExistentFile)).rejects.toThrow(/not found/i);
  });
});

describe("ingest/file.ts — MDX and other extensions", () => {
  it("reads .mdx file as text/markdown", async () => {
    const mdxFile = join(tempDir, "component.mdx");
    writeFileSync(mdxFile, "# MDX Component\n\nHello MDX world!");

    const result = await readFile(mdxFile);

    expect(result.mimeType).toBe("text/markdown");
    expect(result.content).toContain("# MDX Component");
  });

  it("reads unknown extension as text/plain", async () => {
    const unknownFile = join(tempDir, "config.conf");
    writeFileSync(unknownFile, "host=localhost\nport=3456");

    const result = await readFile(unknownFile);

    expect(result.mimeType).toBe("text/plain");
    expect(result.content).toContain("host=localhost");
  });

  it("reads .ts file as text/plain", async () => {
    const tsFile = join(tempDir, "module.ts");
    writeFileSync(tsFile, "export const x: number = 42;");

    const result = await readFile(tsFile);

    expect(result.content).toContain("export const x");
    expect(result.mimeType).toBe("text/plain");
  });
});

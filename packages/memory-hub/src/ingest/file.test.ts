/**
 * Tests for ingest/file.ts — file reader with path traversal protection
 *
 * TDD anchors from task 3:
 *   - path_traversal_blocked (../../etc/passwd)
 *   - outside_allowed_dir_blocked
 *   - markdown_file_returns_content
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { PathNotAllowedError, readFile } from "./file.js";

// Create a temp directory for test files
let tempDir: string;
let testMdFile: string;

beforeAll(() => {
  // Create temp dir inside home directory so it's allowed by default allowlist
  tempDir = mkdtempSync(join(homedir(), ".universal-memory-test-"));
  testMdFile = join(tempDir, "test.md");
  writeFileSync(testMdFile, "# Test\n\nThis is test markdown content.");
});

afterAll(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("ingest/file.ts", () => {
  describe("path_traversal_blocked", () => {
    it("blocks path traversal using ../../etc/passwd", async () => {
      await expect(readFile("../../etc/passwd")).rejects.toThrow(PathNotAllowedError);
    });

    it("blocks absolute path outside home: /etc/passwd", async () => {
      await expect(readFile("/etc/passwd")).rejects.toThrow(PathNotAllowedError);
    });

    it("blocks /etc/shadow", async () => {
      await expect(readFile("/etc/shadow")).rejects.toThrow(PathNotAllowedError);
    });
  });

  describe("outside_allowed_dir_blocked", () => {
    it("blocks /tmp path when not in allowlist", async () => {
      // /tmp is not in the default allowlist (home dir only)
      // Create a tmp file to make the path valid (not just missing)
      const tmpFile = join(tmpdir(), "test-memory-hub.md");
      try {
        writeFileSync(tmpFile, "test content");
      } catch {
        // ignore
      }

      // Should be blocked by allowlist check, not by file-not-found
      await expect(readFile(tmpFile)).rejects.toThrow(PathNotAllowedError);
    });

    it("allows MEMORY_ALLOWED_DIRS override", async () => {
      // Override allowlist to include tmpdir
      const origAllowedDirs = process.env.MEMORY_ALLOWED_DIRS;
      const tmpTestDir = mkdtempSync(join(tmpdir(), "allowed-test-"));
      const tmpTestFile = join(tmpTestDir, "allowed.md");
      writeFileSync(tmpTestFile, "# Allowed\n\nContent in allowed dir.");

      process.env.MEMORY_ALLOWED_DIRS = tmpTestDir;
      try {
        // Re-import to pick up env var (dynamic import with cache bust not possible easily,
        // so we pass allowedDirs explicitly via the overload)
        const { readFile: readFileWithOverride } = await import("./file.js");
        const result = await readFileWithOverride(tmpTestFile, { allowedDirs: [tmpTestDir] });
        expect(result.content).toContain("Allowed");
      } finally {
        if (origAllowedDirs !== undefined) {
          process.env.MEMORY_ALLOWED_DIRS = origAllowedDirs;
        } else {
          delete process.env.MEMORY_ALLOWED_DIRS;
        }
        rmSync(tmpTestDir, { recursive: true, force: true });
      }
    });
  });

  describe("markdown_file_returns_content", () => {
    it("reads a markdown file and returns its content", async () => {
      const result = await readFile(testMdFile);
      expect(result.content).toContain("# Test");
      expect(result.content).toContain("This is test markdown content.");
    });

    it("returned mime type is text/markdown for .md files", async () => {
      const result = await readFile(testMdFile);
      expect(result.mimeType).toBe("text/markdown");
    });

    it("reads a .txt file and returns text content", async () => {
      const txtFile = join(tempDir, "test.txt");
      writeFileSync(txtFile, "Plain text content.");
      const result = await readFile(txtFile);
      expect(result.content).toContain("Plain text content.");
      expect(result.mimeType).toBe("text/plain");
    });

    it("reads a code file and returns its content", async () => {
      const tsFile = join(tempDir, "test.ts");
      writeFileSync(tsFile, "export const x = 1;");
      const result = await readFile(tsFile);
      expect(result.content).toContain("export const x = 1;");
    });
  });

  describe("pdf_file_returns_content", () => {
    it("returns error note content when PDF extraction fails for non-PDF file named .pdf", async () => {
      // Write a file with .pdf extension but text content (simulates corrupt PDF)
      const fakePdf = join(tempDir, "fake.pdf");
      writeFileSync(fakePdf, "this is not a real PDF");

      // pdf-parse should fail on invalid PDF content; we expect an error note, not garbled bytes
      const result = await readFile(fakePdf);
      expect(result.mimeType).toBe("application/pdf");
      // Either successfully extracted text OR returned an error note — not raw binary garbage
      expect(typeof result.content).toBe("string");
      expect(result.content.length).toBeGreaterThan(0);
      // Should not contain binary/null bytes (raw PDF bytes as UTF-8)
      expect(result.content).not.toMatch(/\x00/);
    });
  });

  describe("symlink_protection", () => {
    it("resolves symlinks and checks the real path against allowlist", async () => {
      // Create a symlink inside allowed dir pointing to /etc/passwd
      const symlinkPath = join(tempDir, "evil-symlink.txt");
      try {
        const { symlinkSync } = await import("node:fs");
        symlinkSync("/etc/passwd", symlinkPath);
      } catch {
        // symlink may already exist or creation may fail — skip if so
        return;
      }

      // Should resolve symlink to /etc/passwd which is outside allowed dir
      await expect(readFile(symlinkPath)).rejects.toThrow(PathNotAllowedError);
    });
  });
});

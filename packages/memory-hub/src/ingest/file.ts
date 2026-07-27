/**
 * ingest/file.ts — Local file reader with path traversal protection
 *
 * Security decisions (D11):
 * - Resolves symlinks via realpath() before any read
 * - Validates resolved path is within MEMORY_ALLOWED_DIRS allowlist
 *   (defaults to user home directory only)
 * - Expands ~ in path arguments before resolving
 *
 * Supported formats:
 * - Markdown / plain text / code: read as UTF-8 text
 * - PDF: extracted via pdf-parse
 * - Images: read as base64 data URL (mime type preserved)
 */

import { readFileSync, realpathSync, existsSync } from "node:fs";
import { extname, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

/**
 * Thrown when a file path is rejected by the allowlist policy.
 */
export class PathNotAllowedError extends Error {
  constructor(path: string, reason: string) {
    super(`Path not allowed: ${path} — ${reason}`);
    this.name = "PathNotAllowedError";
  }
}

/** Image extensions handled as base64 data URLs. */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".avif",
]);

/** MIME type map for image extensions. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
};

/** MIME types for text-based formats. */
const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};

/**
 * Resolve the effective allowlist of directories.
 * Uses MEMORY_ALLOWED_DIRS env var if set (colon-separated paths on Unix,
 * semicolon-separated on Windows), otherwise defaults to user home directory.
 */
function resolveAllowedDirs(override?: string[]): string[] {
  if (override && override.length > 0) {
    return override.map((d) => expandTilde(d));
  }

  const envDirs = process.env.MEMORY_ALLOWED_DIRS;
  if (envDirs) {
    // Support both colon and semicolon separators
    const dirs = envDirs.split(/[:;]/).filter(Boolean);
    if (dirs.length > 0) {
      return dirs.map((d) => expandTilde(d));
    }
  }

  return [homedir()];
}

/**
 * Expand a leading tilde to the user's home directory.
 */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return homedir() + p.slice(1);
  }
  return p;
}

/**
 * Resolve an input path to an absolute path, expanding ~ if present.
 */
function resolveInputPath(input: string): string {
  const expanded = expandTilde(input);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/**
 * Check that a resolved absolute path is within at least one allowed directory.
 * The check is prefix-based: resolved must start with the allowed dir + path separator.
 */
function assertPathAllowed(resolvedPath: string, allowedDirs: string[]): void {
  const normalizedResolved = resolvedPath.replace(/\\/g, "/");
  for (const dir of allowedDirs) {
    const normalizedDir = dir.replace(/\\/g, "/").replace(/\/$/, "");
    if (
      normalizedResolved === normalizedDir ||
      normalizedResolved.startsWith(normalizedDir + "/")
    ) {
      return; // allowed
    }
  }
  throw new PathNotAllowedError(
    resolvedPath,
    `outside allowed directories: ${allowedDirs.join(", ")}`
  );
}

export interface ReadFileResult {
  /** Text content (for text/markdown/code/PDF) or data URL (for images). */
  content: string;
  /** MIME type of the detected format. */
  mimeType: string;
}

/**
 * Options for readFile().
 */
export interface ReadFileOptions {
  /**
   * Override the allowlist for testing. If provided, ignores MEMORY_ALLOWED_DIRS.
   */
  allowedDirs?: string[];
}

/**
 * Read a local file and return its text content with MIME type.
 *
 * Security:
 * 1. Expands ~ in path
 * 2. Resolves to absolute path
 * 3. Resolves symlinks via realpathSync
 * 4. Validates resolved path is within MEMORY_ALLOWED_DIRS (default: ~/))
 *
 * @param filePath - Path to read (may be relative, absolute, or ~/...)
 * @param opts - Options (allowedDirs override for tests)
 */
export async function readFile(
  filePath: string,
  opts: ReadFileOptions = {}
): Promise<ReadFileResult> {
  const allowedDirs = resolveAllowedDirs(opts.allowedDirs);

  // Step 1: Resolve to absolute (expand ~ first)
  const absolutePath = resolveInputPath(filePath);

  // Step 2: Pre-check allowlist on unresolved path before existsSync.
  // This prevents path-existence oracle: a caller outside the allowlist should
  // not be able to distinguish "file not found" from "path not allowed" for
  // paths like /etc/passwd (which reveals whether the file exists).
  // NOTE: This check is defense-in-depth; the security-effective check is
  // step 4 (post-realpath). Both checks are needed — see step 4 rationale.
  assertPathAllowed(absolutePath, allowedDirs);

  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  // Step 3: Resolve symlinks — this is the canonical real path
  let realPath: string;
  try {
    realPath = realpathSync(absolutePath);
  } catch (e) {
    throw new Error(
      `Cannot resolve path: ${absolutePath} — ${(e as Error).message}`
    );
  }

  // Step 4: Validate REAL path (after symlink resolution) against allowlist.
  // This is the security-effective check. Without it, a symlink INSIDE the
  // allowed dir pointing OUTSIDE (e.g. ~/notes/evil → /etc/passwd) would
  // bypass the step-2 check (~/notes/evil passes the pre-check, but after
  // realpath it resolves to /etc/passwd which is outside ~/). Both checks
  // are required: step 2 for the path-oracle defense, step 4 for symlink safety.
  assertPathAllowed(realPath, allowedDirs);

  const ext = extname(realPath).toLowerCase();

  // ── Image: return as base64 data URL ────────────────────────────────────────
  if (IMAGE_EXTENSIONS.has(ext)) {
    const buf = readFileSync(realPath);
    const mime = IMAGE_MIME[ext] ?? "application/octet-stream";
    const b64 = buf.toString("base64");
    return {
      content: `data:${mime};base64,${b64}`,
      mimeType: mime,
    };
  }

  // ── PDF: extract text via pdf-parse ─────────────────────────────────────────
  if (ext === ".pdf") {
    try {
      // pdf-parse v2 exports a PDFParse class (not a default function).
      // Use PDFParse directly: new PDFParse(buffer) → instance with .render() method.
      const { PDFParse } = await import("pdf-parse") as any;
      if (typeof PDFParse !== "function") {
        throw new Error("pdf-parse module did not export PDFParse");
      }
      const buf = readFileSync(realPath);
      // PDFParse v2 API: pass { data: Uint8Array } in the constructor options,
      // then call .getText() with no arguments to extract all page text.
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const text: string = await parser.getText();
      return {
        content: text,
        mimeType: "application/pdf",
      };
    } catch (e) {
      // pdf-parse unavailable or PDF is corrupt/encrypted. Do NOT return raw bytes
      // (binary PDF content is unreadable garbage as UTF-8 and bloats the index).
      // Return an error note so the caller knows extraction failed.
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      process.stderr.write(
        `[universal-memory] PDF text extraction failed for ${realPath}: ${reason}\n`
      );
      return {
        content: `[PDF extraction failed for ${realPath}: ${reason}]`,
        mimeType: "application/pdf",
      };
    }
  }

  // ── Text / Markdown / Code: read as UTF-8 ───────────────────────────────────
  const content = readFileSync(realPath, "utf-8");
  const mimeType = TEXT_MIME[ext] ?? "text/plain";

  return { content, mimeType };
}

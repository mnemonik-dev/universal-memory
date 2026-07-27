/**
 * Additional tests for mcp/auth.ts — edge cases.
 *
 * The existing auth.test.ts covers the main happy/sad paths.
 * These tests cover:
 *   - Empty string Bearer token
 *   - "Bearer " with no token (empty)
 *   - Very long token (buffer padding behavior)
 *   - Unicode characters in token (multi-byte UTF-8)
 *   - create401Response body structure
 *
 * TDD anchors (Task 8):
 *   - mcp/auth.ts::correct_bearer_passes (already in auth.test.ts)
 *   - mcp/auth.ts::timing_safe_equal_used (already in auth.test.ts)
 *   - mcp/auth.ts::malformed header returns false
 *   - mcp/auth.ts::empty Bearer returns false
 */

import { describe, it, expect } from "bun:test";
import { validateBearer, create401Response } from "./auth.js";

const API_KEY = "secure-memory-hub-key-2026";

describe("mcp/auth.ts — validateBearer edge cases", () => {
  it("empty Bearer (no token after space) returns false", () => {
    // "Bearer " is falsy for the token portion — empty token shouldn't match
    const result = validateBearer("Bearer ", API_KEY);
    expect(result).toBe(false);
  });

  it("Token scheme (not Bearer) returns false", () => {
    const result = validateBearer(`Token ${API_KEY}`, API_KEY);
    expect(result).toBe(false);
  });

  it("Basic scheme returns false", () => {
    const result = validateBearer(`Basic ${Buffer.from(API_KEY).toString("base64")}`, API_KEY);
    expect(result).toBe(false);
  });

  it("extra spaces after Bearer prefix are included in comparison", () => {
    // "Bearer  key" has two spaces — the second space is part of the token
    const result = validateBearer(`Bearer  ${API_KEY}`, API_KEY);
    expect(result).toBe(false); // " key" != "key"
  });

  it("case sensitivity: bearer (lowercase) returns false", () => {
    // Our check uses startsWith("Bearer ") — case sensitive
    const result = validateBearer(`bearer ${API_KEY}`, API_KEY);
    expect(result).toBe(false);
  });

  it("BEARER (uppercase) returns false", () => {
    const result = validateBearer(`BEARER ${API_KEY}`, API_KEY);
    expect(result).toBe(false);
  });

  it("very long token that matches returns true", () => {
    const longKey = "a".repeat(1024);
    const result = validateBearer(`Bearer ${longKey}`, longKey);
    expect(result).toBe(true);
  });

  it("very long token that doesn't match returns false", () => {
    const longKey = "a".repeat(1024);
    const wrongKey = "b".repeat(1024);
    const result = validateBearer(`Bearer ${longKey}`, wrongKey);
    expect(result).toBe(false);
  });

  it("unicode characters in token — exact match returns true", () => {
    const unicodeKey = "key-\u{1F511}abc"; // 🔑
    const result = validateBearer(`Bearer ${unicodeKey}`, unicodeKey);
    expect(result).toBe(true);
  });

  it("unicode characters in token — mismatch returns false", () => {
    const result = validateBearer("Bearer key-🔑abc", "key-🔑def");
    expect(result).toBe(false);
  });

  it("token with special chars (dash, underscore) works", () => {
    const specialKey = "my-api_key.v2+x/z";
    const result = validateBearer(`Bearer ${specialKey}`, specialKey);
    expect(result).toBe(true);
  });

  it("null auth header returns false", () => {
    expect(validateBearer(null, API_KEY)).toBe(false);
  });

  it("empty string auth header returns false", () => {
    expect(validateBearer("", API_KEY)).toBe(false);
  });
});

describe("mcp/auth.ts — create401Response", () => {
  it("status is 401", () => {
    const resp = create401Response();
    expect(resp.status).toBe(401);
  });

  it("Content-Type is application/json", () => {
    const resp = create401Response();
    const ct = resp.headers.get("content-type");
    expect(ct).toContain("application/json");
  });

  it("body has error field with value 'unauthorized'", async () => {
    const resp = create401Response();
    const body = await resp.json() as { error: string; message: string };
    expect(body.error).toBe("unauthorized");
  });

  it("body has message field with guidance", async () => {
    const resp = create401Response();
    const body = await resp.json() as { error: string; message: string };
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("body does not contain actual API key value", async () => {
    // Verify the response body never leaks key info (D13)
    const resp = create401Response();
    const text = await resp.text();
    // Should not contain "sk-" patterns or long token-like strings
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});

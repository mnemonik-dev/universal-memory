/**
 * Tests for server.ts input validation — MEDIUM-1 audit fix.
 *
 * Validates that top_k and limit are clamped to safe bounds
 * before being passed to the storage layer.
 *
 * Tests the clamp() helper logic and the MAX_ constants to ensure
 * bounds are enforced correctly. We test the logic that server.ts
 * inlines, not the server module itself (which requires full MCP init).
 */

import { describe, it, expect } from "bun:test";

// ─── Inline the clamp helper (extracted to verify the logic independently) ────

const MAX_SEARCH_TOP_K = 100;
const MAX_LIST_LIMIT = 100;

function clamp(value: unknown, min: number, max: number, defaultVal: number): number {
  const n = typeof value === "number" ? value : defaultVal;
  return Math.min(Math.max(min, n), max);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("server.ts input validation — clamp() helper (MEDIUM-1 fix)", () => {
  describe("top_k clamping for memory_search", () => {
    it("clamps top_k: 2147483647 to MAX_SEARCH_TOP_K (100)", () => {
      expect(clamp(2147483647, 1, MAX_SEARCH_TOP_K, 10)).toBe(100);
    });

    it("clamps top_k: 100000 to 100", () => {
      expect(clamp(100000, 1, MAX_SEARCH_TOP_K, 10)).toBe(100);
    });

    it("clamps top_k: 101 to 100", () => {
      expect(clamp(101, 1, MAX_SEARCH_TOP_K, 10)).toBe(100);
    });

    it("allows top_k: 100 (at max boundary)", () => {
      expect(clamp(100, 1, MAX_SEARCH_TOP_K, 10)).toBe(100);
    });

    it("allows top_k: 50 (within range)", () => {
      expect(clamp(50, 1, MAX_SEARCH_TOP_K, 10)).toBe(50);
    });

    it("clamps top_k: 0 to min (1)", () => {
      expect(clamp(0, 1, MAX_SEARCH_TOP_K, 10)).toBe(1);
    });

    it("clamps top_k: -1 to min (1)", () => {
      expect(clamp(-1, 1, MAX_SEARCH_TOP_K, 10)).toBe(1);
    });

    it("uses defaultVal (10) when top_k is undefined", () => {
      expect(clamp(undefined, 1, MAX_SEARCH_TOP_K, 10)).toBe(10);
    });

    it("uses defaultVal when top_k is null", () => {
      expect(clamp(null, 1, MAX_SEARCH_TOP_K, 10)).toBe(10);
    });

    it("uses defaultVal when top_k is a string", () => {
      expect(clamp("big", 1, MAX_SEARCH_TOP_K, 10)).toBe(10);
    });

    it("allows top_k: 1 (at min boundary)", () => {
      expect(clamp(1, 1, MAX_SEARCH_TOP_K, 10)).toBe(1);
    });
  });

  describe("limit clamping for memory_list", () => {
    it("clamps limit: 2147483647 to MAX_LIST_LIMIT (100)", () => {
      expect(clamp(2147483647, 1, MAX_LIST_LIMIT, 20)).toBe(100);
    });

    it("clamps limit: 500 to 100", () => {
      expect(clamp(500, 1, MAX_LIST_LIMIT, 20)).toBe(100);
    });

    it("allows limit: 100 (at max boundary)", () => {
      expect(clamp(100, 1, MAX_LIST_LIMIT, 20)).toBe(100);
    });

    it("uses defaultVal (20) when limit is undefined", () => {
      expect(clamp(undefined, 1, MAX_LIST_LIMIT, 20)).toBe(20);
    });

    it("clamps limit: 0 to min (1)", () => {
      expect(clamp(0, 1, MAX_LIST_LIMIT, 20)).toBe(1);
    });

    it("allows limit: 20 (default, within range)", () => {
      expect(clamp(20, 1, MAX_LIST_LIMIT, 20)).toBe(20);
    });
  });

  describe("clamp() boundary behaviour", () => {
    it("returns max when value > max", () => {
      expect(clamp(999, 1, 100, 10)).toBe(100);
    });

    it("returns min when value < min", () => {
      expect(clamp(-999, 1, 100, 10)).toBe(1);
    });

    it("returns value when min <= value <= max", () => {
      expect(clamp(42, 1, 100, 10)).toBe(42);
    });

    it("returns defaultVal (clamped to range) for non-numeric input", () => {
      expect(clamp("not a number", 1, 100, 10)).toBe(10);
      expect(clamp(true, 1, 100, 10)).toBe(10); // boolean is not "number" typeof
      expect(clamp({}, 1, 100, 10)).toBe(10);
    });
  });
});

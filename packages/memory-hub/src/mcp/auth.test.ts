/**
 * Tests for mcp/auth.ts — Bearer token validation middleware
 *
 * TDD anchors from task 2:
 *   - correct_bearer_passes
 *   - missing_header_returns_401
 *   - wrong_key_returns_401
 *   - timing_safe_comparison_used
 */

import { describe, it, expect, spyOn } from "bun:test";
import { validateBearer, create401Response } from "./auth.js";
import * as crypto from "node:crypto";

describe("mcp/auth.ts", () => {
  describe("validateBearer", () => {
    const API_KEY = "test-secret-key-12345";

    it("correct_bearer_passes: returns true when Authorization header matches", () => {
      const result = validateBearer(`Bearer ${API_KEY}`, API_KEY);
      expect(result).toBe(true);
    });

    it("missing_header_returns_401: returns false when Authorization header is null", () => {
      const result = validateBearer(null, API_KEY);
      expect(result).toBe(false);
    });

    it("missing_header_returns_401: returns false when Authorization header is missing Bearer prefix", () => {
      const result = validateBearer(API_KEY, API_KEY);
      expect(result).toBe(false);
    });

    it("missing_header_returns_401: returns false when Authorization header is empty string", () => {
      const result = validateBearer("", API_KEY);
      expect(result).toBe(false);
    });

    it("wrong_key_returns_401: returns false when Bearer token does not match", () => {
      const result = validateBearer("Bearer wrong-key", API_KEY);
      expect(result).toBe(false);
    });

    it("wrong_key_returns_401: returns false with partial key match", () => {
      const result = validateBearer(`Bearer ${API_KEY.slice(0, -1)}`, API_KEY);
      expect(result).toBe(false);
    });

    it("timing_safe_comparison_used: uses crypto.timingSafeEqual not string equality", () => {
      // Spy on timingSafeEqual to verify it is called during comparison
      const spy = spyOn(crypto, "timingSafeEqual");
      validateBearer(`Bearer ${API_KEY}`, API_KEY);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("handles keys of different lengths safely (no Buffer length exception)", () => {
      // crypto.timingSafeEqual throws if buffers differ in length — must be handled
      const result = validateBearer("Bearer short", API_KEY);
      expect(result).toBe(false);
    });
  });

  describe("create401Response", () => {
    it("returns a Response with status 401", () => {
      const resp = create401Response();
      expect(resp.status).toBe(401);
    });

    it("returns JSON content-type", () => {
      const resp = create401Response();
      expect(resp.headers.get("content-type")).toContain("application/json");
    });

    it("body contains error field", async () => {
      const resp = create401Response();
      const body = await resp.json() as { error: string };
      expect(body).toHaveProperty("error");
    });
  });
});

/**
 * Bearer token auth middleware for HTTP MCP transport.
 *
 * Security decisions:
 * - D10: Uses crypto.timingSafeEqual() for constant-time token comparison to
 *   prevent timing attacks that could allow byte-by-byte key guessing.
 * - D13: Never logs the actual token value.
 *
 * Note: Nginx is the primary auth layer (D4). This middleware is
 * defense-in-depth — it catches requests that bypass nginx (e.g. direct
 * VPS-internal access) and enforces the same policy.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Validates an Authorization: Bearer <token> header against the expected API key.
 *
 * Returns true if the token matches, false for any failure (missing header,
 * wrong format, wrong token, or different-length tokens).
 *
 * Uses crypto.timingSafeEqual() to prevent timing attacks. Buffers are
 * zero-padded to the same length before comparison so an attacker cannot
 * measure token length from response time.
 */
export function validateBearer(
  authHeader: string | null,
  expectedKey: string
): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const provided = authHeader.slice(7); // strip "Bearer "

  // Zero-pad both buffers to the same length so timingSafeEqual cannot throw
  // and the comparison is always constant-time regardless of token length.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expectedKey);

  const maxLen = Math.max(providedBuf.length, expectedBuf.length);
  const a = Buffer.alloc(maxLen);
  const b = Buffer.alloc(maxLen);
  providedBuf.copy(a);
  expectedBuf.copy(b);

  // timingSafeEqual compares byte-by-byte in constant time.
  // We separately check lengths so a short key that happens to match after
  // zero-padding is still rejected.
  const lengthsMatch = providedBuf.length === expectedBuf.length;
  const contentMatch = timingSafeEqual(a, b);

  return lengthsMatch && contentMatch;
}

/**
 * Creates a standard 401 Unauthorized JSON response.
 * Never includes the API key or any hint of the correct value.
 */
export function create401Response(): Response {
  return Response.json(
    {
      error: "unauthorized",
      message: "Valid Authorization: Bearer <MEMORY_API_KEY> header required.",
    },
    {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }
  );
}

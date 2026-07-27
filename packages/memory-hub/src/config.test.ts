/**
 * Tests for scrubSecrets() in config.ts
 *
 * TDD anchors from task 2:
 *   - scrubSecrets_redacts_bearer_token
 *   - scrubSecrets_redacts_sk_pattern
 */

import { describe, it, expect } from "bun:test";
import { scrubSecrets } from "./config.js";

describe("config.ts — scrubSecrets()", () => {
  it("scrubSecrets_redacts_bearer_token: redacts Authorization Bearer value", () => {
    const input = "Request with Authorization: Bearer sk-abcdef1234567890 from client";
    const result = scrubSecrets(input);
    expect(result).not.toContain("sk-abcdef1234567890");
    expect(result).toContain("[REDACTED]");
  });

  it("scrubSecrets_redacts_bearer_token: redacts Bearer token in HTTP header format", () => {
    const input = 'Authorization: Bearer supersecrettoken123';
    const result = scrubSecrets(input);
    expect(result).not.toContain("supersecrettoken123");
    expect(result).toContain("[REDACTED]");
  });

  it("scrubSecrets_redacts_sk_pattern: redacts sk- prefixed API keys", () => {
    const input = "Using API key sk-proj-abc123xyz456 for OpenAI";
    const result = scrubSecrets(input);
    expect(result).not.toContain("sk-proj-abc123xyz456");
    expect(result).toContain("[REDACTED]");
  });

  it("scrubSecrets_redacts_sk_pattern: redacts multiple sk- keys in same string", () => {
    const input = "key1=sk-abc123 and key2=sk-def456";
    const result = scrubSecrets(input);
    expect(result).not.toContain("sk-abc123");
    expect(result).not.toContain("sk-def456");
  });

  it("preserves non-secret content", () => {
    const input = "Starting server in cloud mode on port 3456";
    const result = scrubSecrets(input);
    expect(result).toBe(input);
  });

  it("redacts JSON fields containing jwt", () => {
    const input = JSON.stringify({ jwt: "eyJhbGciOiJFZERTQSJ9.abc.def", user: "alice" });
    const result = scrubSecrets(input);
    expect(result).not.toContain("eyJhbGciOiJFZERTQSJ9.abc.def");
  });

  it("redacts JSON fields containing keypair", () => {
    const input = JSON.stringify({ keypair: "private-key-material-here", algo: "Ed25519" });
    const result = scrubSecrets(input);
    expect(result).not.toContain("private-key-material-here");
  });

  it("handles non-string input gracefully (returns as-is string representation)", () => {
    // Should not throw
    expect(() => scrubSecrets("")).not.toThrow();
    expect(scrubSecrets("")).toBe("");
  });
});

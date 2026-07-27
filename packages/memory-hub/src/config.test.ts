/**
 * Tests for config.ts
 *
 * TDD anchors:
 *   - scrubSecrets_redacts_bearer_token
 *   - scrubSecrets_redacts_sk_pattern
 *   - with no key and no Ollama → mode is "bm25-only", startup warning logged to stderr
 *   - getConfig() returns object with mode and dataDir
 */

import { describe, it, expect, spyOn } from "bun:test";
import { scrubSecrets, getConfig, mode, dataDir } from "./config.js";

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

describe("config.ts — mode detection", () => {
  it("getConfig() returns object with mode and dataDir", () => {
    const cfg = getConfig();
    expect(cfg).toHaveProperty("mode");
    expect(cfg).toHaveProperty("dataDir");
    expect(["full", "ollama", "bm25-only"]).toContain(cfg.mode);
    expect(typeof cfg.dataDir).toBe("string");
    expect(cfg.dataDir.length).toBeGreaterThan(0);
  });

  it("mode export matches getConfig().mode", () => {
    // Both exports read from same resolved config object
    expect(mode).toBe(getConfig().mode);
  });

  it("dataDir export matches getConfig().dataDir", () => {
    expect(dataDir).toBe(getConfig().dataDir);
  });

  it("with no API keys set → mode is bm25-only (in test env without keys)", () => {
    // In CI without any API keys, mode should be bm25-only.
    // If keys ARE set, this test is not applicable and we just check mode is valid.
    const cfg = getConfig();
    const hasKeys = !!(
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.GOOGLE_API_KEY
    );
    if (!hasKeys) {
      expect(cfg.mode).toBe("bm25-only");
    } else {
      expect(["full", "ollama"]).toContain(cfg.mode);
    }
  });

  it("dataDir does not contain literal tilde (~)", () => {
    // ~ should always be expanded to home directory
    expect(dataDir).not.toMatch(/^~/);
  });

  it("dataDir defaults to path containing .universal-memory when no MEMORY_DATA_DIR set", () => {
    if (!process.env.MEMORY_DATA_DIR) {
      expect(dataDir).toContain(".universal-memory");
    }
  });
});

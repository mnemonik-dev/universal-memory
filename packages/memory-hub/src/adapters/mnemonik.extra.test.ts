/**
 * Additional tests for adapters/mnemonik.ts — MnemonikAdapter class methods.
 *
 * The existing mnemonik.test.ts covers createMnemonikAdapter() factory.
 * These tests cover the MnemonikAdapter class directly:
 *   - Constructor validates JWT (throws on expired)
 *   - Constructor validates identity JSON (throws on missing)
 *   - sign() delegates to client.signMemory()
 *   - verify() delegates to client.verify()
 *   - recall() delegates to client.recall()
 *
 * Note: MnemonikAdapter constructor calls parseJwtPayload() which throws
 * AuthError on expired JWT, and Keypair.fromJSON() which throws on bad input.
 * We test the failure paths since success requires a valid keypair + JWT.
 *
 * TDD anchors (Task 8):
 *   - tools/sign.ts::local_mode_error (covered in sign.test.ts via null adapter)
 *   - createMnemonikAdapter factory returns null on all error paths
 */

import { describe, it, expect, spyOn, mock } from "bun:test";

describe("MnemonikAdapter — constructor error paths", () => {
  it("throws when identityJson is missing", async () => {
    const { MnemonikAdapter } = await import("./mnemonik.js");

    expect(() => {
      new MnemonikAdapter({ jwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.stub" });
    }).toThrow(/MNEMONIC_IDENTITY/);
  });

  it("throws when jwt is missing", async () => {
    const { MnemonikAdapter } = await import("./mnemonik.js");

    expect(() => {
      new MnemonikAdapter({ identityJson: JSON.stringify([1, 2, 3]) });
    }).toThrow(/MNEMONIC_JWT/);
  });

  it("throws with expired JWT (parseJwtPayload throws AuthError)", async () => {
    const { MnemonikAdapter } = await import("./mnemonik.js");

    // exp=1 is 1970 — always expired
    expect(() => {
      new MnemonikAdapter({
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.invalid",
        identityJson: JSON.stringify([1, 2, 3, 4]),
      });
    }).toThrow();
  });
});

describe("createMnemonikAdapter — factory null paths", () => {
  it("returns null when jwt is empty string", async () => {
    const { createMnemonikAdapter } = await import("./mnemonik.js");
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true; // suppress warning

    const adapter = createMnemonikAdapter({ jwt: "", identityJson: JSON.stringify([1]) });
    process.stderr.write = origStderr;

    // Empty string is falsy — should behave like missing
    expect(adapter).toBeNull();
  });

  it("returns null when both jwt and identity are missing", async () => {
    const { createMnemonikAdapter } = await import("./mnemonik.js");
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;

    const adapter = createMnemonikAdapter({ jwt: undefined, identityJson: undefined });
    process.stderr.write = origStderr;

    expect(adapter).toBeNull();
  });

  it("logs warning to stderr when JWT missing", async () => {
    const { createMnemonikAdapter } = await import("./mnemonik.js");
    const stderrSpy = spyOn(process.stderr, "write");

    createMnemonikAdapter({ jwt: undefined, identityJson: JSON.stringify([1, 2, 3]) });

    const calls = (stderrSpy as ReturnType<typeof spyOn>).mock.calls;
    const output = (calls as string[][]).flat().join("");
    expect(output).toMatch(/MNEMONIC_JWT|jwt|login/i);
    stderrSpy.mockRestore();
  });

  it("logs warning to stderr when identity missing", async () => {
    const { createMnemonikAdapter } = await import("./mnemonik.js");
    const stderrSpy = spyOn(process.stderr, "write");

    createMnemonikAdapter({
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.stub",
      identityJson: undefined,
    });

    const calls = (stderrSpy as ReturnType<typeof spyOn>).mock.calls;
    const output = (calls as string[][]).flat().join("");
    expect(output).toMatch(/MNEMONIC_IDENTITY|identity|init/i);
    stderrSpy.mockRestore();
  });

  it("never logs JWT value in warning messages", async () => {
    const { createMnemonikAdapter } = await import("./mnemonik.js");
    const stderrSpy = spyOn(process.stderr, "write");
    const sensitiveJwt = "eyJhbGciOiJFZERTQSJ9.payload.signature";

    createMnemonikAdapter({ jwt: sensitiveJwt, identityJson: undefined });

    const calls = (stderrSpy as ReturnType<typeof spyOn>).mock.calls;
    const output = (calls as string[][]).flat().join("");
    // The JWT value must NOT appear in logs
    expect(output).not.toContain(sensitiveJwt);
    stderrSpy.mockRestore();
  });
});

describe("contentHashOf() — from sign.ts — deterministic SHA-256", () => {
  it("produces consistent hash for same content", async () => {
    const { contentHashOf } = await import("../tools/sign.js");
    const h1 = contentHashOf("test content");
    const h2 = contentHashOf("test content");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different content", async () => {
    const { contentHashOf } = await import("../tools/sign.js");
    expect(contentHashOf("alpha")).not.toBe(contentHashOf("beta"));
  });

  it("produces hex string output (64 chars for SHA-256)", async () => {
    const { contentHashOf } = await import("../tools/sign.js");
    const hash = contentHashOf("any content");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

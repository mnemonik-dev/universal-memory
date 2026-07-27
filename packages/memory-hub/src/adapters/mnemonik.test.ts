/**
 * Tests for adapters/mnemonik.ts — MnemonikAdapter construction + JWT handling
 *
 * TDD anchors from task 6:
 *   - expired_jwt_logs_warning_not_crash (construction with expired JWT)
 */

import { describe, it, expect, spyOn } from "bun:test";

describe("adapters/mnemonik.ts", () => {
  describe("expired_jwt_logs_warning_not_crash", () => {
    it("createMnemonikAdapter returns null and logs warning when JWT is expired/malformed", async () => {
      const { createMnemonikAdapter } = await import("./mnemonik.js");

      // Capture stderr output
      const stderrSpy = spyOn(process.stderr, "write");

      const adapter = createMnemonikAdapter({
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.invalid", // expired JWT (exp=1)
        identityJson: JSON.stringify([1, 2, 3, 4]), // stub identity
      });

      expect(adapter).toBeNull();
      expect(stderrSpy).toHaveBeenCalled();
      const warningOutput = (stderrSpy.mock.calls as string[][])
        .flat()
        .join("");
      expect(warningOutput).toMatch(/jwt|expired|mnemonic/i);

      stderrSpy.mockRestore();
    });

    it("createMnemonikAdapter returns null when MNEMONIC_JWT is missing", async () => {
      const { createMnemonikAdapter } = await import("./mnemonik.js");

      const stderrSpy = spyOn(process.stderr, "write");

      const adapter = createMnemonikAdapter({
        jwt: undefined,
        identityJson: JSON.stringify([1, 2, 3, 4]),
      });

      expect(adapter).toBeNull();
      // Should log a warning, not crash
      stderrSpy.mockRestore();
    });

    it("createMnemonikAdapter returns null when MNEMONIC_IDENTITY is missing", async () => {
      const { createMnemonikAdapter } = await import("./mnemonik.js");

      const stderrSpy = spyOn(process.stderr, "write");

      const adapter = createMnemonikAdapter({
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.stub",
        identityJson: undefined,
      });

      expect(adapter).toBeNull();
      stderrSpy.mockRestore();
    });
  });
});

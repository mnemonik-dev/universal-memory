/**
 * Tests for tools/verify.ts — memory_verify handler
 *
 * TDD anchors from task 6:
 *   - delegates_to_MnemonicClient_verify
 *   - passes_through_verified_status
 *   - passes_through_tampered_status
 *   - passes_through_not_found_status
 */

import { describe, it, expect, mock } from "bun:test";
import type { VerifyResult } from "@mnemonik-xyz/sdk";
import type { MnemonikAdapter } from "../adapters/mnemonik.js";

function makeAdapter(result: VerifyResult): MnemonikAdapter {
  return {
    sign: mock(async () => ({ attestationId: "", signedAt: "", status: "signed" as const })),
    verify: mock(async (_attestationId: string) => result),
    recall: mock(async () => []),
  } as unknown as MnemonikAdapter;
}

describe("tools/verify.ts", () => {
  describe("delegates_to_MnemonicClient_verify", () => {
    it("calls adapter.verify with the attestationId", async () => {
      const { verifyMemory } = await import("./verify.js");
      const adapter = makeAdapter({ status: "verified", signer: "pubkey-abc" });

      await verifyMemory({ attestationId: "attest-123", adapter });

      expect(adapter.verify).toHaveBeenCalledWith("attest-123");
    });

    it("returns error when adapter is null (signing not configured)", async () => {
      const { verifyMemory } = await import("./verify.js");

      const result = await verifyMemory({ attestationId: "attest-123", adapter: null });

      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/mnemonik|signing|configured/i);
    });
  });

  describe("passes_through_verified_status", () => {
    it("returns verified status with signer", async () => {
      const { verifyMemory } = await import("./verify.js");
      const adapter = makeAdapter({ status: "verified", signer: "signer-pubkey-xyz" });

      const result = await verifyMemory({ attestationId: "attest-verified", adapter });

      expect(result.status).toBe("verified");
      expect(result.signer).toBe("signer-pubkey-xyz");
    });

    it("passes through arweaveTx when present", async () => {
      const { verifyMemory } = await import("./verify.js");
      const adapter = makeAdapter({
        status: "verified",
        signer: "signer-abc",
        arweaveTx: "arweave-tx-hash-001",
      });

      const result = await verifyMemory({ attestationId: "attest-anchored", adapter });

      expect(result.arweaveTx).toBe("arweave-tx-hash-001");
    });
  });

  describe("passes_through_tampered_status", () => {
    it("returns tampered status with signer and reason", async () => {
      const { verifyMemory } = await import("./verify.js");
      const adapter = makeAdapter({
        status: "tampered",
        signer: "signer-bad",
        reason: "content_hash_mismatch",
      });

      const result = await verifyMemory({ attestationId: "attest-tampered", adapter });

      expect(result.status).toBe("tampered");
      expect(result.signer).toBe("signer-bad");
      expect(result.reason).toBe("content_hash_mismatch");
    });
  });

  describe("passes_through_not_found_status", () => {
    it("returns not_found status", async () => {
      const { verifyMemory } = await import("./verify.js");
      const adapter = makeAdapter({ status: "not_found" });

      const result = await verifyMemory({ attestationId: "attest-missing", adapter });

      expect(result.status).toBe("not_found");
    });
  });

  describe("error handling", () => {
    it("returns actionable error when adapter.verify throws", async () => {
      const { verifyMemory } = await import("./verify.js");
      const adapter = {
        sign: mock(async () => ({ attestationId: "", signedAt: "", status: "signed" as const })),
        verify: mock(async () => { throw new Error("network error: timeout"); }),
        recall: mock(async () => []),
      } as unknown as MnemonikAdapter;

      const result = await verifyMemory({ attestationId: "attest-fail", adapter });

      expect(result.error).toBeTruthy();
    });
  });
});

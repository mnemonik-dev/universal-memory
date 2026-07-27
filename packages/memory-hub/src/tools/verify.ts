/**
 * memory_verify tool handler — extracted for test isolation.
 *
 * Thin delegation layer: validates input, guards on null adapter,
 * calls MnemonikAdapter.verify(), and maps SDK errors to user-facing text.
 *
 * The VerifyResult discriminated union from @mnemonik-xyz/sdk passes through
 * unchanged — callers receive { status: 'verified'|'tampered'|'not_found', ... }.
 */

import type { MnemonikAdapter } from "../adapters/mnemonik.js";
import type { VerifyResult } from "@mnemonik-xyz/sdk";

export interface VerifyMemoryInput {
  attestationId: string;
  adapter: MnemonikAdapter | null;
}

export type VerifyMemoryOutput = VerifyResult & { error?: string };

/**
 * Core verify logic — pure function over injected adapter.
 * Returns an error field on failure rather than throwing, consistent with
 * the MCP tool's need to return user-facing text in all cases.
 */
export async function verifyMemory(input: VerifyMemoryInput): Promise<VerifyMemoryOutput> {
  const { attestationId, adapter } = input;

  // ── Guard: Mnemonik not configured ──────────────────────────────────────
  if (!adapter) {
    return {
      status: "not_found",
      error: "Mnemonik signing not configured. Set MNEMONIK_SIGNING=true + MNEMONIC_IDENTITY + MNEMONIC_JWT to enable.",
    } as VerifyMemoryOutput;
  }

  // ── Delegate to SDK ──────────────────────────────────────────────────────
  try {
    const result = await adapter.verify(attestationId);
    return result as VerifyMemoryOutput;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "not_found",
      error: `Mnemonik verify failed — service may be unavailable. Details: ${msg}`,
    } as VerifyMemoryOutput;
  }
}

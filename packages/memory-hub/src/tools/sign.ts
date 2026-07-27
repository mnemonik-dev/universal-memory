/**
 * memory_sign tool handler — extracted for test isolation.
 *
 * Responsibilities:
 *   1. Reject local-mode calls (no adapter, no db → cloud-only error)
 *   2. Compute deterministic content hash (SHA-256 hex) for idempotency key
 *   3. Query memory_attestations by content_hash — return cached attestationId if found
 *   4. Call adapter.sign() if no existing attestation
 *   5. Insert new attestation row
 *   6. Return { attestationId, signedAt, status, cached? }
 *
 * D7: idempotent by content hash — same content → same attestationId, no double-sign.
 * D13: never log content or JWT values.
 */

import { createHash } from "node:crypto";
import { redactJWT } from "@mnemonik-xyz/sdk";
import type { MnemonikAdapter } from "../adapters/mnemonik.js";

/** Minimal Postgres client interface (pg Pool or Bun's own SQL client). */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SignMemoryInput {
  content: string;
  tags?: string[];
  adapter: MnemonikAdapter | null;
  db: DbClient | null;
}

export interface SignMemoryOutput {
  attestationId?: string;
  signedAt?: string;
  status?: string;
  contentHash?: string;
  /** true when the attestationId was returned from cache (no new signing) */
  cached?: boolean;
  error?: string;
}

/**
 * Compute SHA-256 hex digest of content.
 *
 * The tech-spec mentions blake3 (from gbrain) but blake3 requires a native
 * module unavailable in all Bun environments. SHA-256 is a stable, built-in
 * alternative that meets the same dedup-key purpose (D7). If gbrain exposes
 * a contentHash in SignMemoryResult we record that in the DB column instead;
 * SHA-256 is used only for the idempotency lookup key.
 */
export function contentHashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Core sign logic — pure function over injected adapter + db.
 * Returns a discriminated result shape rather than throwing, so the MCP
 * tool handler can return user-facing error text without crashing.
 */
export async function signMemory(input: SignMemoryInput): Promise<SignMemoryOutput> {
  const { content, tags, adapter, db } = input;

  // ── Guard: empty content ──────────────────────────────────────────────────
  // MnemonicClient.signMemory() throws UserError for empty content. Catching it
  // here gives a clearer message than the generic 'service unavailable' fallback.
  if (!content || !content.trim()) {
    return { error: "content must not be empty" };
  }

  // ── Guard: local mode (no adapter configured) ────────────────────────────
  if (!adapter) {
    return {
      error: "Signing only available in cloud mode. Set MNEMONIK_SIGNING=true + MNEMONIC_IDENTITY + MNEMONIC_JWT.",
    };
  }

  const hash = contentHashOf(content);

  // ── Idempotency check (D7) ───────────────────────────────────────────────
  if (db) {
    try {
      const existing = await db.query(
        "SELECT attestation_id, signed_at, status FROM memory_attestations WHERE content_hash = $1 LIMIT 1",
        [hash]
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        return {
          attestationId: row.attestation_id as string,
          signedAt: row.signed_at as string,
          status: row.status as string,
          contentHash: hash,
          cached: true,
        };
      }
    } catch (dbErr) {
      // Log but don't abort — the attestation table may not exist yet in this
      // environment (e.g. integration test without migrations run). Fall through
      // to signing so the tool still works.
      process.stderr.write(
        `[memory-hub] WARNING: memory_attestations query failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}\n`
      );
    }
  }

  // ── Sign via Mnemonik SDK ─────────────────────────────────────────────────
  let signResult;
  try {
    signResult = await adapter.sign(content, tags);
  } catch (err) {
    // redactJWT() removes JWT-shaped strings from error messages before they
    // reach the MCP caller (D13 — secrets must not leave the server boundary).
    const raw = err instanceof Error ? err.message : String(err);
    const msg = redactJWT(raw);
    return {
      error: `Mnemonik signing failed — service may be unavailable. Details: ${msg}`,
    };
  }

  // ── Store attestation in DB ───────────────────────────────────────────────
  if (db) {
    // Always use SHA-256 hash as the primary key / lookup key for idempotency (D7).
    // The server may return a different hash (blake3) in signResult.contentHash —
    // we do NOT use it as the dedup key because the SELECT above uses SHA-256.
    // Using different hashes in SELECT vs INSERT would cause missed idempotency hits.
    try {
      await db.query(
        `INSERT INTO memory_attestations (content_hash, attestation_id, signed_at, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (content_hash) DO NOTHING`,
        [hash, signResult.attestationId, signResult.signedAt, signResult.status]
      );
    } catch (insertErr) {
      // Non-fatal: attestation was created upstream — log and continue.
      process.stderr.write(
        `[memory-hub] WARNING: failed to store attestation in memory_attestations: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}\n`
      );
    }
  }

  return {
    attestationId: signResult.attestationId,
    signedAt: signResult.signedAt,
    status: signResult.status,
    contentHash: signResult.contentHash ?? hash,
  };
}

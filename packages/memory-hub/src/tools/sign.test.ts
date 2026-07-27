/**
 * Tests for tools/sign.ts — memory_sign handler with idempotency
 *
 * TDD anchors from task 6:
 *   - local_mode_returns_cloud_only_error
 *   - same_content_hash_returns_existing_attestationId (idempotency)
 *   - calls_MnemonicClient_signMemory
 *   - stores_attestation_in_db
 *   - mnemonik_unavailable_returns_actionable_error
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { SignMemoryResult } from "@mnemonik-xyz/sdk";
import type { MnemonikAdapter } from "../adapters/mnemonik.js";

// ─── Minimal mock types ──────────────────────────────────────────────────────

type AttestationRow = {
  attestation_id: string;
  signed_at: string;
  status: string;
};

type MockDb = {
  query: ReturnType<typeof mock>;
};

function makeDb(existingRow?: AttestationRow): MockDb {
  return {
    query: mock(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("SELECT") && existingRow) {
        return { rows: [existingRow] };
      }
      if (sql.includes("SELECT")) {
        return { rows: [] };
      }
      // INSERT → return void-like
      return { rows: [] };
    }),
  };
}

function makeAdapter(result?: Partial<SignMemoryResult>): MnemonikAdapter {
  const signResult: SignMemoryResult = {
    attestationId: result?.attestationId ?? "attest-abc-123",
    signedAt: result?.signedAt ?? "2026-07-27T00:00:00Z",
    status: result?.status ?? "signed",
    contentHash: result?.contentHash ?? "deadbeef",
  };
  return {
    sign: mock(async (_content: string, _tags?: string[]) => signResult),
    verify: mock(async () => ({ status: "not_found" as const })),
    recall: mock(async () => []),
  } as unknown as MnemonikAdapter;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("tools/sign.ts", () => {
  describe("local_mode_returns_cloud_only_error", () => {
    it("returns cloud_only error when no adapter and no db (local mode)", async () => {
      const { signMemory } = await import("./sign.js");
      const result = await signMemory({
        content: "hello world",
        adapter: null,
        db: null,
      });
      expect(result.error).toMatch(/cloud/i);
      expect(result.attestationId).toBeUndefined();
    });

    it("returns Signing not configured when adapter is null but db exists (signing disabled)", async () => {
      const { signMemory } = await import("./sign.js");
      const db = makeDb();
      const result = await signMemory({
        content: "test content",
        adapter: null,
        db: db as any,
      });
      expect(result.error).toBeTruthy();
    });
  });

  describe("same_content_hash_returns_existing_attestationId", () => {
    it("returns cached attestationId for same content (idempotency)", async () => {
      const { signMemory } = await import("./sign.js");
      const existingAttest: AttestationRow = {
        attestation_id: "cached-attest-xyz",
        signed_at: "2026-07-20T00:00:00Z",
        status: "signed",
      };
      const db = makeDb(existingAttest);
      const adapter = makeAdapter({ attestationId: "new-attest-should-not-be-called" });

      const result = await signMemory({
        content: "already signed content",
        adapter,
        db: db as any,
      });

      expect(result.attestationId).toBe("cached-attest-xyz");
      expect(result.cached).toBe(true);
      // Adapter.sign must NOT have been called
      expect(adapter.sign).not.toHaveBeenCalled();
    });
  });

  describe("calls_MnemonicClient_signMemory", () => {
    it("calls adapter.sign with the content and tags", async () => {
      const { signMemory } = await import("./sign.js");
      const db = makeDb(); // no existing row
      const adapter = makeAdapter();

      await signMemory({
        content: "brand new content",
        tags: ["tag1", "tag2"],
        adapter,
        db: db as any,
      });

      expect(adapter.sign).toHaveBeenCalledWith("brand new content", ["tag1", "tag2"]);
    });

    it("returns attestationId from adapter on success", async () => {
      const { signMemory } = await import("./sign.js");
      const db = makeDb();
      const adapter = makeAdapter({ attestationId: "fresh-attest-999" });

      const result = await signMemory({
        content: "new content to sign",
        adapter,
        db: db as any,
      });

      expect(result.attestationId).toBe("fresh-attest-999");
      expect(result.error).toBeUndefined();
    });
  });

  describe("stores_attestation_in_db", () => {
    it("inserts a row into memory_attestations after signing", async () => {
      const { signMemory } = await import("./sign.js");
      const db = makeDb(); // no existing row
      const adapter = makeAdapter({ attestationId: "stored-attest-001", contentHash: "abc123" });

      await signMemory({
        content: "store this",
        adapter,
        db: db as any,
      });

      // Should have been called twice: SELECT then INSERT
      expect(db.query).toHaveBeenCalledTimes(2);
      const insertCall = (db.query as ReturnType<typeof mock>).mock.calls[1];
      const insertSql = insertCall[0] as string;
      expect(insertSql).toMatch(/INSERT/i);
    });

    it("insert includes attestation_id, content_hash, status", async () => {
      const { signMemory } = await import("./sign.js");
      const db = makeDb();
      const adapter = makeAdapter({
        attestationId: "insert-check-attest",
        contentHash: "deadbeef1234",
        status: "signed",
      });

      await signMemory({
        content: "check insert params",
        adapter,
        db: db as any,
      });

      const insertCall = (db.query as ReturnType<typeof mock>).mock.calls[1];
      const params = insertCall[1] as string[];
      // Params should include attestationId and contentHash
      expect(params).toContain("insert-check-attest");
      expect(params).toContain("deadbeef1234");
    });
  });

  describe("mnemonik_unavailable_returns_actionable_error", () => {
    it("returns actionable error when adapter.sign throws ServerError", async () => {
      const { signMemory } = await import("./sign.js");
      const db = makeDb();
      const adapter = {
        sign: mock(async () => {
          throw new Error("network error: ECONNREFUSED");
        }),
        verify: mock(async () => ({ status: "not_found" as const })),
        recall: mock(async () => []),
      } as unknown as MnemonikAdapter;

      const result = await signMemory({
        content: "sign this",
        adapter,
        db: db as any,
      });

      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/unavailable|failed|mnemonik/i);
    });

    it("does not insert into db when adapter.sign throws", async () => {
      const { signMemory } = await import("./sign.js");
      const db = makeDb();
      const adapter = {
        sign: mock(async () => { throw new Error("MnemonikClient: ECONNREFUSED"); }),
        verify: mock(async () => ({ status: "not_found" as const })),
        recall: mock(async () => []),
      } as unknown as MnemonikAdapter;

      await signMemory({ content: "fail this", adapter, db: db as any });

      // Only the SELECT should have run, not an INSERT
      const calls = (db.query as ReturnType<typeof mock>).mock.calls;
      const insertCalls = calls.filter((c) => (c[0] as string).includes("INSERT"));
      expect(insertCalls).toHaveLength(0);
    });
  });
});

/**
 * Tests for tools/sign.ts — signContent() and signMemory() handlers
 *
 * signContent() — low-level signing primitive used by memory_capture:
 *   - local_mode_returns_cloud_only_error
 *   - same_content_hash_returns_existing_attestationId (idempotency)
 *   - calls_MnemonicClient_signMemory
 *   - stores_attestation_in_db
 *   - mnemonik_unavailable_returns_actionable_error
 *
 * signMemory() — MCP tool handler: id → content lookup → sign:
 *   - memory_not_found_returns_error
 *   - found_memory_delegates_to_signContent
 */

import { describe, it, expect, mock } from "bun:test";
import type { SignMemoryResult } from "@mnemonik-xyz/sdk";
import type { MnemonikAdapter } from "../adapters/mnemonik.js";
import type { StorageAdapter } from "../storage/index.js";

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
    // contentHash is optional — intentionally omit to test the no-server-hash path
    ...(result?.contentHash !== undefined ? { contentHash: result.contentHash } : {}),
  };
  return {
    sign: mock(async (_content: string, _tags?: string[]) => signResult),
    verify: mock(async () => ({ status: "not_found" as const })),
    recall: mock(async () => []),
  } as unknown as MnemonikAdapter;
}

/** Build a minimal StorageAdapter mock with a getById implementation. */
function makeStorage(entry?: { id: string; content: string } | null): StorageAdapter {
  return {
    getById: mock(async (_id: string) => entry ?? null),
    search: mock(async () => []),
    synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
    add: mock(async () => {}),
    list: mock(async () => []),
    delete: mock(async () => {}),
    clear: mock(async () => {}),
    sync: mock(async () => ({ pushed: 0 })),
  } as unknown as StorageAdapter;
}

// ─── Tests for signContent() ─────────────────────────────────────────────────

describe("tools/sign.ts — signContent()", () => {
  describe("local_mode_returns_cloud_only_error", () => {
    it("returns cloud_only error when no adapter and no db (local mode)", async () => {
      const { signContent } = await import("./sign.js");
      const result = await signContent({
        content: "hello world",
        adapter: null,
        db: null,
      });
      expect(result.error).toMatch(/cloud/i);
      expect(result.attestationId).toBeUndefined();
    });

    it("returns error when adapter is null but db exists (signing disabled)", async () => {
      const { signContent } = await import("./sign.js");
      const db = makeDb();
      const result = await signContent({
        content: "test content",
        adapter: null,
        db: db as any,
      });
      expect(result.error).toBeTruthy();
    });

    it("returns error for empty content before checking adapter", async () => {
      const { signContent } = await import("./sign.js");
      const result = await signContent({
        content: "",
        adapter: null,
        db: null,
      });
      expect(result.error).toMatch(/empty/i);
    });

    it("returns error for whitespace-only content", async () => {
      const { signContent } = await import("./sign.js");
      const adapter = makeAdapter();
      const result = await signContent({
        content: "   ",
        adapter,
        db: null,
      });
      expect(result.error).toMatch(/empty/i);
    });
  });

  describe("same_content_hash_returns_existing_attestationId", () => {
    it("returns cached attestationId for same content (idempotency)", async () => {
      const { signContent, contentHashOf } = await import("./sign.js");
      const content = "already signed content";
      const existingAttest: AttestationRow = {
        attestation_id: "cached-attest-xyz",
        signed_at: "2026-07-20T00:00:00Z",
        status: "signed",
      };
      const db = makeDb(existingAttest);
      const adapter = makeAdapter({ attestationId: "new-attest-should-not-be-called" });

      const result = await signContent({
        content,
        adapter,
        db: db as any,
      });

      expect(result.attestationId).toBe("cached-attest-xyz");
      expect(result.cached).toBe(true);
      // Adapter.sign must NOT have been called
      expect(adapter.sign).not.toHaveBeenCalled();
      // TR-1: verify the SELECT query used the correct SHA-256 hash of the content
      const selectCall = (db.query as ReturnType<typeof mock>).mock.calls[0];
      const selectParams = selectCall[1] as string[];
      expect(selectParams[0]).toBe(contentHashOf(content));
    });
  });

  describe("calls_MnemonicClient_signMemory", () => {
    it("calls adapter.sign with the content and tags", async () => {
      const { signContent } = await import("./sign.js");
      const db = makeDb(); // no existing row
      const adapter = makeAdapter();

      await signContent({
        content: "brand new content",
        tags: ["tag1", "tag2"],
        adapter,
        db: db as any,
      });

      expect(adapter.sign).toHaveBeenCalledWith("brand new content", ["tag1", "tag2"]);
    });

    it("returns attestationId from adapter on success", async () => {
      const { signContent } = await import("./sign.js");
      const db = makeDb();
      const adapter = makeAdapter({ attestationId: "fresh-attest-999" });

      const result = await signContent({
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
      const { signContent } = await import("./sign.js");
      const db = makeDb(); // no existing row
      const adapter = makeAdapter({ attestationId: "stored-attest-001" });

      await signContent({
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

    it("INSERT uses the SHA-256 content hash as the dedup key (not server contentHash)", async () => {
      // TR-3: hash used for SELECT must equal hash used for INSERT (CR-1 regression guard)
      const { signContent, contentHashOf } = await import("./sign.js");
      const content = "check insert params";
      const db = makeDb();
      // Adapter returns a DIFFERENT server contentHash — but our INSERT must use SHA-256
      const adapter = makeAdapter({
        attestationId: "insert-check-attest",
        contentHash: "server-blake3-hash-different-from-sha256",
        status: "signed",
      });

      await signContent({ content, adapter, db: db as any });

      const selectCall = (db.query as ReturnType<typeof mock>).mock.calls[0];
      const insertCall = (db.query as ReturnType<typeof mock>).mock.calls[1];
      const selectHash = (selectCall[1] as string[])[0];
      const insertHash = (insertCall[1] as string[])[0];

      const expectedHash = contentHashOf(content);
      // Both SELECT and INSERT use the same SHA-256 hash
      expect(selectHash).toBe(expectedHash);
      expect(insertHash).toBe(expectedHash);
      // attestationId is also in the INSERT params
      expect((insertCall[1] as string[])).toContain("insert-check-attest");
    });

    it("INSERT params include attestation_id and status", async () => {
      const { signContent } = await import("./sign.js");
      const db = makeDb();
      const adapter = makeAdapter({ attestationId: "attest-status-check", status: "signed" });

      await signContent({ content: "status check", adapter, db: db as any });

      const insertCall = (db.query as ReturnType<typeof mock>).mock.calls[1];
      const params = insertCall[1] as string[];
      expect(params).toContain("attest-status-check");
      expect(params).toContain("signed");
    });
  });

  describe("mnemonik_unavailable_returns_actionable_error", () => {
    it("returns actionable error when adapter.sign throws ServerError", async () => {
      const { signContent } = await import("./sign.js");
      const db = makeDb();
      const adapter = {
        sign: mock(async () => {
          throw new Error("network error: ECONNREFUSED");
        }),
        verify: mock(async () => ({ status: "not_found" as const })),
        recall: mock(async () => []),
      } as unknown as MnemonikAdapter;

      const result = await signContent({
        content: "sign this",
        adapter,
        db: db as any,
      });

      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/unavailable|failed|mnemonik/i);
    });

    it("does not insert into db when adapter.sign throws", async () => {
      const { signContent } = await import("./sign.js");
      const db = makeDb();
      const adapter = {
        sign: mock(async () => { throw new Error("MnemonikClient: ECONNREFUSED"); }),
        verify: mock(async () => ({ status: "not_found" as const })),
        recall: mock(async () => []),
      } as unknown as MnemonikAdapter;

      await signContent({ content: "fail this", adapter, db: db as any });

      // Only the SELECT should have run, not an INSERT
      const calls = (db.query as ReturnType<typeof mock>).mock.calls;
      const insertCalls = calls.filter((c) => (c[0] as string).includes("INSERT"));
      expect(insertCalls).toHaveLength(0);
    });
  });
});

// ─── Tests for signMemory() ──────────────────────────────────────────────────

describe("tools/sign.ts — signMemory() id-based lookup", () => {
  describe("memory_not_found_returns_error", () => {
    it("returns memory_not_found error when id does not exist in storage", async () => {
      const { signMemory } = await import("./sign.js");
      const storage = makeStorage(null); // no entry for any id
      const adapter = makeAdapter();
      const db = makeDb();

      const result = await signMemory({
        id: "nonexistent-id-xyz",
        storage,
        adapter,
        db: db as any,
      });

      expect(result.error).toBe("memory_not_found");
      expect(result.id).toBe("nonexistent-id-xyz");
      expect(result.attestationId).toBeUndefined();
    });

    it("does not call adapter.sign when memory is not found", async () => {
      const { signMemory } = await import("./sign.js");
      const storage = makeStorage(null);
      const adapter = makeAdapter();

      await signMemory({ id: "missing-id", storage, adapter, db: null });

      expect(adapter.sign).not.toHaveBeenCalled();
    });
  });

  describe("found_memory_delegates_to_signContent", () => {
    it("retrieves content by id and signs it", async () => {
      const { signMemory } = await import("./sign.js");
      const entry = { id: "mem-abc-123", content: "the memory content to sign" };
      const storage = makeStorage(entry);
      const adapter = makeAdapter({ attestationId: "attest-from-lookup-456" });
      const db = makeDb();

      const result = await signMemory({
        id: "mem-abc-123",
        storage,
        adapter,
        db: db as any,
      });

      // Confirm storage was queried with the correct id
      expect(storage.getById).toHaveBeenCalledWith("mem-abc-123");
      // Confirm adapter.sign was called with the retrieved content
      expect(adapter.sign).toHaveBeenCalledWith("the memory content to sign", undefined);
      // Confirm result contains the attestation
      expect(result.attestationId).toBe("attest-from-lookup-456");
      expect(result.error).toBeUndefined();
    });

    it("passes tags through to adapter.sign", async () => {
      const { signMemory } = await import("./sign.js");
      const entry = { id: "mem-tag-test", content: "tagged memory" };
      const storage = makeStorage(entry);
      const adapter = makeAdapter();
      const db = makeDb();

      await signMemory({
        id: "mem-tag-test",
        tags: ["important", "2026"],
        storage,
        adapter,
        db: db as any,
      });

      expect(adapter.sign).toHaveBeenCalledWith("tagged memory", ["important", "2026"]);
    });

    it("returns cached attestationId when content was already signed (idempotency)", async () => {
      const { signMemory, contentHashOf } = await import("./sign.js");
      const entry = { id: "mem-idem", content: "previously signed content" };
      const storage = makeStorage(entry);
      const adapter = makeAdapter({ attestationId: "should-not-use-this" });
      const existingAttest: AttestationRow = {
        attestation_id: "cached-attest-from-lookup",
        signed_at: "2026-07-27T00:00:00Z",
        status: "signed",
      };
      const db = makeDb(existingAttest);

      const result = await signMemory({
        id: "mem-idem",
        storage,
        adapter,
        db: db as any,
      });

      expect(result.attestationId).toBe("cached-attest-from-lookup");
      expect(result.cached).toBe(true);
      expect(adapter.sign).not.toHaveBeenCalled();
    });

    it("returns memory_not_found when adapter is null (local mode, storage has no entry)", async () => {
      const { signMemory } = await import("./sign.js");
      const storage = makeStorage(null);

      const result = await signMemory({
        id: "nonexistent",
        storage,
        adapter: null,
        db: null,
      });

      // Storage lookup fails first — before reaching the adapter check
      expect(result.error).toBe("memory_not_found");
    });

    it("returns cloud-only error when memory exists but adapter is null", async () => {
      const { signMemory } = await import("./sign.js");
      const entry = { id: "mem-local", content: "local memory" };
      const storage = makeStorage(entry);

      const result = await signMemory({
        id: "mem-local",
        storage,
        adapter: null,
        db: null,
      });

      expect(result.error).toMatch(/cloud/i);
    });
  });
});

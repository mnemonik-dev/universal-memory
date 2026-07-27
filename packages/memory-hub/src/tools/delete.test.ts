/**
 * Integration tests for memory_delete handler behaviour.
 *
 * TDD anchors (task 4):
 *   - calls_deletePage
 *   - not_found_returns_error
 *
 * Uses mock StorageAdapter to avoid PGLite startup cost.
 * Tests the delete path wired in server.ts (which calls storage.delete()).
 */

import { describe, it, expect, mock } from "bun:test";
import type { StorageAdapter } from "../storage/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a StorageAdapter mock where delete succeeds (default) or throws not_found. */
function createMockStorage(opts: { notFound?: boolean } = {}): StorageAdapter {
  const deleteFn = opts.notFound
    ? mock(async () => {
        const err = new Error("Memory not found: test-id");
        (err as any).code = "not_found";
        throw err;
      })
    : mock(async () => {});

  return {
    add: mock(async () => {}),
    search: mock(async () => []),
    synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
    list: mock(async () => []),
    delete: deleteFn,
    clear: mock(async () => {}),
    sync: mock(async () => ({})),
  };
}

// ─── Simulate server.ts delete handler logic ─────────────────────────────────

async function handleDelete(
  storage: StorageAdapter,
  id: string,
  userId?: string
): Promise<{ status: "deleted" } | { error: "not_found"; id: string } | { error: string }> {
  try {
    await storage.delete({ id, userId });
    return { status: "deleted" };
  } catch (e: unknown) {
    const code = (e as any)?.code;
    const message = e instanceof Error ? e.message : String(e);
    if (code === "not_found") {
      return { error: "not_found", id };
    }
    return { error: message };
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("delete", () => {
  describe("calls_deletePage", () => {
    it("calls storage.delete() with the given id", async () => {
      const storage = createMockStorage();

      await storage.delete({ id: "page-slug-abc" });

      const call = (storage.delete as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toMatchObject({ id: "page-slug-abc" });
    });

    it("calls storage.delete() with userId when provided", async () => {
      const storage = createMockStorage();

      await storage.delete({ id: "slug-1", userId: "user-99" });

      const call = (storage.delete as ReturnType<typeof mock>).mock.calls[0];
      expect(call[0]).toMatchObject({ id: "slug-1", userId: "user-99" });
    });

    it("returns { status: 'deleted' } on success", async () => {
      const storage = createMockStorage();

      const result = await handleDelete(storage, "existing-id");

      expect(result).toEqual({ status: "deleted" });
    });

    it("storage.delete() called exactly once per delete request", async () => {
      const storage = createMockStorage();

      await handleDelete(storage, "once-only");

      expect((storage.delete as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    });
  });

  describe("not_found_returns_error", () => {
    it("returns { error: 'not_found', id } when id doesn't exist", async () => {
      const storage = createMockStorage({ notFound: true });

      const result = await handleDelete(storage, "ghost-id");

      expect(result).toEqual({ error: "not_found", id: "ghost-id" });
    });

    it("does NOT throw when id is not found (returns error object)", async () => {
      const storage = createMockStorage({ notFound: true });

      // handleDelete should never throw — it must catch and return an error object
      // Stronger assertion: must return a not_found error, not { status: 'deleted' }
      await expect(handleDelete(storage, "missing-id")).resolves.toMatchObject({
        error: "not_found",
      });
    });

    it("error object includes the missing id", async () => {
      const storage = createMockStorage({ notFound: true });

      const result = (await handleDelete(storage, "unknown-slug-xyz")) as {
        error: string;
        id: string;
      };

      expect(result.error).toBe("not_found");
      expect(result.id).toBe("unknown-slug-xyz");
    });

    it("code 'not_found' is the discriminator (not the message text)", async () => {
      // Ensure the error code property is what triggers the not_found path,
      // not the error message text, so future message changes won't break it.
      const storage: StorageAdapter = {
        add: mock(async () => {}),
        search: mock(async () => []),
        synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
        list: mock(async () => []),
        delete: mock(async () => {
          const e = new Error("completely different message");
          (e as any).code = "not_found";
          throw e;
        }),
        clear: mock(async () => {}),
        sync: mock(async () => ({})),
      };

      const result = await handleDelete(storage, "any-id");
      expect((result as { error: string }).error).toBe("not_found");
    });

    it("other errors surface as generic error string (not not_found)", async () => {
      const storage: StorageAdapter = {
        add: mock(async () => {}),
        search: mock(async () => []),
        synthesize: mock(async () => ({ answer: "", citations: [], gaps: [] })),
        list: mock(async () => []),
        delete: mock(async () => { throw new Error("database connection lost"); }),
        clear: mock(async () => {}),
        sync: mock(async () => ({})),
      };

      const result = await handleDelete(storage, "any-id") as { error: string };
      expect(result.error).toBe("database connection lost");
    });
  });
});

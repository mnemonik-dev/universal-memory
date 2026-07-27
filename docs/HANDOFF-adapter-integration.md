# Handoff: wire the storage adapters to gbrain's REAL engine API

**Status (2026-07-27):** the hub builds and 373 unit tests pass, **but the product
does not actually work.** `memory_capture` throws on the first real call. The unit
tests pass because they mock the gbrain engine with methods that gbrain does not have.
This doc is the fix plan.

## TL;DR of the bug

`packages/memory-hub/src/storage/local.ts` and `.../cloud.ts` call engine methods that
**do not exist** on gbrain's real `BrainEngine` (`vendors/gbrain/src/core/engine.ts`):

| Adapter call (local.ts / cloud.ts) | Real gbrain API to use instead |
|---|---|
| `engine.upsert({id, content, source, userId, metadata})` — **does not exist** | `importFromContent(engine, slug, content, opts)` from `gbrain/import-file` |
| `engine.search({query, userId, limit})` — **does not exist** | `hybridSearch(engine, query, opts)` from `gbrain/search/hybrid` |
| `engine.deleteByUser(userId)` — **does not exist** | no per-user delete in gbrain; see "clear" below |
| `engine.getPage(id)` — exists but keyed by **slug**, not the hub's generated `id` | `engine.getPage(slug, opts)` — reconcile id↔slug |
| `engine.deletePage(id)` — same slug/id mismatch | `engine.deletePage(slug, opts)` |
| `engine.listPages({...})` | `engine.listPages(filters?)` — mostly OK, verify field mapping |
| `runThink(...)` via `gbrain/think` (synthesize path) | ✅ already correct |

Proof of the runtime failure:
```
$ cd packages/memory-hub && bun run scripts/mcp-smoke.ts
McpError -32603: (await this.getEngine()).upsert is not a function
```

## Why the tests didn't catch it (READ THIS)

`src/storage/local.unit.test.ts` (and the cloud/hybrid equivalents) build a **fake
engine**: `{ upsert: mock(), search: mock(), deleteByUser: mock(), ... }`. Every adapter
test asserts the adapter *calls* those fake methods with the right args — never that the
methods exist on the real engine. So the suite is green against fiction.

**Do not just make the mocks match reality and call it done.** The fix must include a
real end-to-end test (see "Test gate" below) or this exact false-green returns.

## Real gbrain signatures (from the pinned submodule, v0.42.66.0 fork)

```ts
// gbrain/import-file  — the correct ingestion path (chunk + embed + store)
export async function importFromContent(
  engine: BrainEngine,
  slug: string,           // stable identifier; use it as the memory id
  content: string,
  opts: {
    noEmbed?: boolean;    // set true in BM25-only mode (no embedding provider)
    sourceId?: string;    // use for `source` / multi-source scoping
    filename?: string;
    sourcePath?: string;
    forceRechunk?: boolean;
    // ...more, all optional
  },
): Promise<Page>;         // returns the stored Page (has .slug)

// gbrain/search/hybrid — vector + BM25 + RRF (what the spec/README promised)
export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts, // { limit?, sourceId?, ... }
): Promise<SearchResult[]>; // SearchResult has page_slug, score, snippet/body, ...

// gbrain/engine — page CRUD is SLUG-keyed
getPage(slug: string, opts?): Promise<Page | null>;
putPage(slug: string, page: PageInput, opts?): Promise<Page>;
deletePage(slug: string, opts?): Promise<void>;
deletePages(slugs: string[], opts: { sourceId }): Promise<string[]>;
listPages(filters?: PageFilters): Promise<Page[]>;

// gbrain/think — synthesis (already used correctly by the synthesize path)
runThink(...)
```

## Fix plan (per adapter method)

Files: `src/storage/local.ts`, `src/storage/cloud.ts` (same bugs in both), and
`src/storage/hybrid.ts` (delegates to the other two).

1. **`add()` / capture** — replace `engine.upsert(...)` with
   `importFromContent(engine, slug, content, { sourceId: source, noEmbed: <bm25-only?> })`.
   Decide the `slug`: reuse the id the ingest pipeline already generates, or derive a slug.
   Return `{ id: page.slug, chunks }`. Note the MCP tool contract returns `{ id, chunks }` —
   keep that shape.
2. **`search()`** — replace `engine.search(...)` with `hybridSearch(engine, query, { limit: topK, sourceId })`.
   Map `SearchResult` → the hub's `SearchResult` shape (`{ id: page_slug, content, score, source }`).
3. **`clear()` / deleteByUser** — gbrain has no per-user delete. Options: (a) drop the
   feature for MVP (per-user scoping is post-MVP in the user-spec anyway), or (b) implement
   via `listPages` + `deletePages(slugs, {sourceId})`. Pick (a) unless scoping is needed.
4. **`getPage` / `deletePage` / `list`** — reconcile the id↔slug semantics. The hub passes a
   generated `id`; gbrain keys everything by `slug`. Simplest: make the memory `id` BE the slug
   (thread it through capture → list → get → delete consistently).
5. **`synthesize()`** — leave as is (`runThink`), it's correct.

After wiring, re-check `local.ts:map*` result shaping so `memory_list` / `memory_search`
still return the documented fields (`created_at`, `source`, `score`).

## Test gate (the real acceptance criterion)

`scripts/mcp-smoke.ts` is committed — it spawns the real server and runs
capture→list→search→think against real PGLite. **Definition of done:**

```
cd packages/memory-hub && bun run scripts/mcp-smoke.ts   # exits 0, real results
```

- capture returns a real id + chunk count
- list shows the 3 captured facts
- search returns the "hybrid search / RRF" fact ranked for a ranking query
- think returns an answer citing PGLite + hybrid search, with citations[] and gaps[]

Then turn that into a committed integration test (DATABASE_URL-free, PGLite) so CI runs it.
Keep the existing mock unit tests too, but they are NOT sufficient on their own.

## Build / environment prerequisites

- **Submodule:** `git submodule update --init vendors/gbrain` (now points at the fork
  `mnemonik-dev/gbrain @ universal-memory-pin`, which carries the `./think` export;
  see PR context below). The old upstream pin `garrytan/gbrain@54306d8` is dead.
- `cd packages/memory-hub && bun install`
- `bun test src/` → 374 pass / 2 fail. **The 2 failures are macOS-only** `/tmp`→`/private/tmp`
  path-allowlist artifacts in `ingest/file.ts`; they pass on Linux/CI. Do not chase them on macOS.
- `memory_think` needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Without a key the server runs
  BM25-only (capture/search/list still work; think returns a setup message).

## Related PRs / branch state

- **universal-memory PR #1** (`fix/gbrain-submodule-pin` → `main`): re-pins the gbrain
  submodule to the fork commit that carries the `./think` export, so a clean clone builds.
  This handoff + the smoke harness ride on that same branch.
- **gbrain PR garrytan/gbrain#3427**: adds the missing `./think` export upstream. If merged,
  re-pin the submodule to an upstream release and drop the fork.

## After the fix: publishing (open question from the owner)

Distribution goal: `npx`/`bunx universal-memory` with no source checkout. Blocked until the
above works. When ready: publish `@universal-memory/hub` to npm with a `bin`, bundle or declare
the gbrain dependency (note gbrain is currently a git submodule + `workspace:` dep — for npm
publish it must become a real, resolvable dependency, e.g. a published gbrain version or a
bundled build). This is a separate task; do not start it until the smoke test passes.

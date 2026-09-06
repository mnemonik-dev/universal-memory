# Adapter ↔ gbrain integration — RESOLVED

**Status (2026-07-27):** FIXED. The storage adapters are now wired to gbrain's
real engine API and a real capture→list→search→think cycle works end to end.
`scripts/mcp-smoke.ts` exits 0.

This doc originally described the bug (below, for the record) and now records the
fix and the operational caveats discovered while verifying it.

## What was broken

`storage/local.ts` and `storage/cloud.ts` called engine methods that do not
exist on gbrain's `BrainEngine` — `engine.upsert()`, `engine.search()`,
`engine.deleteByUser()` — and read `Page.body` / `Page.source_path` fields that
gbrain does not expose. The 373 unit tests passed only because they **mocked**
those fictional methods, so the product threw on the very first real capture
while the suite stayed green.

## What was fixed

| Method | Before (fictional) | After (real gbrain API) |
|---|---|---|
| `add` | `engine.upsert({...})` | `importFromContent(engine, id, content, { noEmbed })` |
| `search` | `engine.search({...})` | `hybridSearch(engine, q, {limit})` when embeddings available, else `engine.searchKeyword(q, {limit})` |
| `getById` | `page.body` | `page.compiled_truth` |
| `list` | `page.body` / `page.source_path` / `sort` filter | `page.compiled_truth`; `listPages({limit})` (gbrain defaults to updated_desc) |
| `delete` | `getPage(id)` + `deletePage(id)` | unchanged (slug-keyed; the memory `id` is the slug) |
| `clear` | `engine.deleteByUser()` | `listPages({})` + `deletePage(slug)` loop (gbrain has no per-user delete) |
| `synthesize` | `runThink(engine, {question})` | `runThink(engine, {question, model: chatModel})` — passes the configured model |

Also added `embeddingsEnabled` and `chatModel` to `config.ts` (see caveats).

Tests: the mock-based `local.unit.test.ts` was replaced with a **real PGLite
round-trip** (add→getById→list→search→delete→clear). `cloud.unit.test.ts` was
updated to the real engine surface. Suite: **359 pass / 3 fail**; the 3 are the
pre-existing macOS `/tmp`→`/private/tmp` path-allowlist artifacts in
`ingest/file.ts` (green on Linux/CI).

## Operational caveats (important)

1. **Embeddings require OpenAI / Google / Ollama — NOT Anthropic.** Anthropic has
   no embeddings API, so `configureGateway` sets no embedding model in anthropic
   mode. `embeddingsEnabled` is therefore false for anthropic and bm25-only. In
   those modes capture stores with `noEmbed` and search is **keyword-only (BM25,
   AND semantics)** — natural-language queries need their key terms present in
   the content. For semantic search, run with `OPENAI_API_KEY` or a local Ollama
   (`OLLAMA_BASE_URL` + `nomic-embed-text`).
2. **`memory_think` needs a VALID chat key.** gbrain's `runThink` resolved a
   default model that ignored the provider key over MCP; `synthesize` now passes
   `chatModel` explicitly. With an invalid/absent key it degrades gracefully to a
   "no LLM available" answer (no crash). Verified: with a valid key it synthesizes.

## Verify

```
cd packages/memory-hub
git submodule update --init ../../vendors/gbrain   # fork pin carries the ./think export
bun install
bun run scripts/mcp-smoke.ts   # capture/list/search asserted; exits 0
bun test src/                  # 359 pass / 3 fail (macOS path artifacts only)
```

## Remaining follow-ups (not blocking)

- The 3 macOS `ingest/file.ts` path-allowlist tests (env-specific; pass on CI).
- `hub source` metadata is currently dropped on capture (gbrain `sourceId` is a
  repo/database scope, not free-form provenance). If per-memory source is needed,
  store it in gbrain frontmatter and surface it in `list`/`search`.
- Publishing (npm `npx`/`bunx`): now unblocked functionally. gbrain is a git
  submodule + `workspace:` dep — for an npm publish it must become a resolvable
  dependency (published gbrain version or a bundled build). Separate task.

## Related PRs

- **universal-memory PR #1** (`fix/gbrain-submodule-pin` → `main`): submodule
  re-pin + this fix.
- **garrytan/gbrain#3427**: adds the `./think` export upstream. When merged,
  re-pin to an upstream release and drop the fork.

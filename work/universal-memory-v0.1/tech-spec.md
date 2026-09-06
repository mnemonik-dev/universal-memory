---
created: 2026-09-06
revised: 2026-09-06
approved:
status: draft
branch: claude/universal-memory-design-vwlwao
size: M
---

# Tech Spec: Universal Memory v0.1

## Solution

Eight tasks in three waves, ordered so that the thing becomes usable before it becomes
protected. Wave 1 stands up a reachable brain; wave 2 fills it and lives with it for a
week; wave 3 keeps it from silently breaking and writes the verdict.

Two requirements drive every decision below: **usable from any machine**, and **usable
inside a locked-down enterprise perimeter**. Together they rule out a laptop-local
design and rule out third-party embedding providers.

## Architecture

**One hosted brain, thin clients.** The hub runs on a server with HTTPS and Bearer
authentication (`mcp/http.ts`, `mcp/auth.ts` — already implemented, never deployed).
Clients are configuration only: a URL and a token in the Model Context Protocol client
config. Nothing is installed on the client machine.

This follows from the requirements rather than from taste. `HybridAdapter.sync()`
implements push only — pull and bidirectional return 0 with a warning — so there is no
working local-to-cloud reconciliation. Two machines with two local databases would
diverge with no way back. One server-side brain sidesteps that entirely, and it is also
the only shape that works on a machine where nothing may be installed.

**Embeddings inside the perimeter.** `config.ts` already probes Ollama at
`OLLAMA_BASE_URL` and configures `ollama:nomic-embed-text` for embeddings plus
`ollama:llama3.2` for chat. That path becomes the default for the deployment: content
and queries are embedded on our own host, and no document text reaches a third party.
OpenAI and Google stay supported for anyone who wants them, but are not what we run.

**What changes in the code:** the ingestion fetcher gains proxy and custom certificate
authority awareness (there is currently no occurrence of "proxy" anywhere in `src/`),
and the configuration gains a fail-closed egress switch. Everything else in wave 1 is
deployment and documentation, not new code.

## Decisions

**D1. Hosted-first, local mode as the air-gap fallback.** "Any machine" means one brain
reachable from all of them. Local PGLite mode remains for a fully disconnected machine,
but then the memories do not travel — stated plainly rather than implied.

**D2. Self-hosted embeddings are the default, not an option.** An enterprise that
forbids sending documents to third parties cannot use OpenAI embeddings, and semantic
search is the product. Ollama with `nomic-embed-text` is the supported configuration.

**D3. Egress fails closed.** With `NO_EGRESS` set, the server refuses to start if a
third-party provider is configured, rather than starting and quietly calling out. The
current failure mode is the opposite: a missing key silently degrades to keyword-only.

**D4. Twenty known-answer questions replace the benchmark.** A small, honest, local
quality signal on our own material, scored by us. See the user spec for why RUMBA is
out; the short version is that it measures a different product and our harness computes
a substring proxy against an LLM-judge baseline.

**D5. Continuous integration comes after the thing is used, not before.** It protects
daily use once daily use exists. It runs the suite and the smoke test — the smoke test
because mocks once hid a total product failure (decisions F2).

**D6. The week-one verdict may kill the project.** That is a legitimate outcome and the
reason to dogfood before investing in packaging, benchmarks or a public claim.

## Testing Strategy

1. **Unit** — existing mocked suites, every push.
2. **Real-engine** — `local.unit.test.ts` against real PGLite; engine warmed in
   `beforeAll` (commit `112ca70`).
3. **Smoke** — `scripts/mcp-smoke.ts` over the real Model Context Protocol server.
4. **Lived use** — a week of real work, scored by the twenty-question check. This is
   the acceptance test for v0.1; the three above only keep it honest.

## Dependencies

- A host for the deployment: Docker Engine + Compose, a domain, Let's Encrypt
  (`DEPLOY.md`, `docker-compose.yml`, `nginx/memory.conf` all exist, none exercised).
- Ollama on that host with `nomic-embed-text` pulled, plus a chat model for
  `memory_think`.
- Postgres 15+ with pgvector for cloud mode (in `docker-compose.yml`).
- The gbrain fork pin `271fcdd` (decisions F1).

## Risks

- **Host sizing for Ollama is unmeasured.** If the model does not fit, pick a smaller
  embedding model and record it — never fall back to keyword-only silently (D3).
- **`CloudAdapter` has never touched a real database.** Wave 1 exercises it in
  production for the first time; if it breaks there, that is a wave-1 blocker, not a
  wave-3 test-coverage item.
- **The enterprise perimeter is simulated.** No corporate network is available here, so
  task 6 verifies against modelled constraints and says so.

## Acceptance Criteria

AC1 → task 1, AC2 → task 2, AC3 → task 3, AC4 → task 4, AC5 → task 5, AC6 → task 6,
AC7 → task 7, AC8 → task 8.

## Implementation Tasks

| # | Wave | Task | Depends on |
|---|---|---|---|
| 1 | 1 | Deploy a persistent hosted instance | — |
| 2 | 1 | Self-hosted embeddings + semantic search proven | 1 |
| 3 | 1 | Zero-install client connection from any machine | 1 |
| 4 | 2 | Seed with real material + twenty-question recall check | 2, 3 |
| 5 | 2 | Daily-use loop wired into the agent | 3 |
| 6 | 2 | Locked-down perimeter: proxy, custom CA, fail-closed egress | 1 |
| 7 | 3 | Minimal continuous integration | — |
| 8 | 3 | Week-one verdict | 4, 5, 6 |

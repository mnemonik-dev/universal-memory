# Decisions Log: universal-memory-v0.1

Agent reports on completed tasks. Each entry is written by the agent that executed
the task. Append only — never rewrite an existing entry.

Format per entry: `## Task N: [title]`, then **Status**, **Commit**, **Agent**,
**Summary** (1-3 sentences, not a file list), **Deviations**.

---

## Pre-existing findings (carried in from PR #1 and the 2026-09-06 session)

These are not task reports. They are established facts the tasks below build on, so
that the next reader does not rediscover them.

**F1 — The gbrain submodule pin was dead.** `vendors/gbrain` pinned
`garrytan/gbrain@54306d8`, which no longer exists on the remote, so a clean clone
could not even fetch it. Re-pinned to the fork `mnemonik-dev/gbrain`, branch
`universal-memory-pin` (`271fcdd`), which also carries the `./think` export missing
from upstream `v0.42.66.0`. Merged as `31ff10a` (PR #1). Upstream proposal:
`garrytan/gbrain#3427`.

**F2 — The storage adapters called an engine API that does not exist.**
`local.ts` and `cloud.ts` used `engine.upsert()`, `engine.search()`,
`engine.deleteByUser()` and read `Page.body` / `Page.source_path`. None exist on
gbrain's engine. The mocked unit tests asserted those fictional methods, so 373 tests
passed while the product threw on the first real capture. Fixed in PR #1 to
`importFromContent` / `hybridSearch` / `searchKeyword` / `compiled_truth`. This is the
reason decision D1 makes the smoke test a gate.

**F3 — `bunfig.toml` does not configure the test timeout.** The file declared
`[test] timeout = 30000`, but Bun does not read a test timeout from bunfig; the
effective budget was Bun's 5s default. Two real-PGLite tests failed intermittently
because engine cold start (PGLite boot + ~120 gbrain migrations) was charged to the
first test body — reproduced 3/3 under four-core load at 9.5s and 10.8s. Fixed on
this branch (`112ca70`) by warming the engine in `beforeAll` with an explicit hook
timeout and setting `--timeout 30000` in the `test` script.

**F4 — Baseline at the time of writing.** From a clean clone at `31ff10a` on Linux
with Bun 1.3.11: `bun test src/` → 362 pass / 0 fail; `scripts/mcp-smoke.ts` → exit 0.
No embeddings key was set, so the run was BM25-only and `hybridSearch` never executed.
This is the gap task 5 closes.

**F5 — There was no specification set before this one.** No `work/` directory, no
`CLAUDE.md`, no issues, one pull request ever. The only trace of the original
decomposition is the commit messages `task 1` … `task 14`, with 10-13 unaccounted for.

---

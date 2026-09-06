---
created: 2026-09-06
approved:
status: draft
branch: claude/universal-memory-design-vwlwao
size: M
---

# Tech Spec: Universal Memory v0.1

## Solution

Nine tasks in four waves. None of them adds a product feature — each one converts a
claim in `README.md` or `docs/architecture.md` into something a machine checks.

The ordering principle: build the gates first (wave 1), then run the things the gates
will protect (wave 2), then the paths that need credentials (wave 3), then release
(wave 4). Every wave leaves the repository shippable if the next wave never happens.

## Architecture

Nothing structural changes. The affected surfaces:

- `.github/workflows/` — does not exist today. Created in task 1.
- `packages/memory-hub/tsconfig.json` — does not exist today. Created in task 2.
- `.gitmodules` — `research/RUMBA` is a gitlink (`ba08160`) with no mapping, so
  `git submodule` refuses it and the directory stays empty. Fixed in task 3.
- `packages/memory-hub/src/storage/*.test.ts` — gains two real-dependency suites
  (embeddings in task 5, Postgres in task 6) alongside the existing mocked ones.
- `packages/eval/` — unchanged code; task 4 runs it and commits the output.
- Packaging (task 8) is the only task that may change dependency wiring, because
  `gbrain` is a `workspace:` dependency over a git submodule.

## Decisions

**D1. Continuous integration runs the smoke test, not only the unit suite.**
The 373-test mocked suite stayed green while the product threw on first capture
(`docs/HANDOFF-adapter-integration.md`). `scripts/mcp-smoke.ts` is the only check that
drives the real engine end to end, so it gates too.

**D2. The effective test timeout lives in the `test` script, not `bunfig.toml`.**
Bun does not read a test timeout from `bunfig.toml` — the key is inert (established
on this branch, commit `112ca70`). CI invokes `bun run test`, never a bare `bun test`.

**D3. Tests that need an external resource skip loudly, never degrade silently.**
Today a missing embeddings key turns the whole suite into BM25-only with no signal.
Tasks 5-7 must assert the resource is present when its environment variable is set,
and print an explicit skip line when it is not. A silent pass is a defect.

**D4. RUMBA results are committed to the repository.**
A benchmark whose numbers live only in a terminal is not benchmark-driven. The result
file carries the date, the commit, the backend mode and the embedding provider, so a
later reader can tell what was actually measured.

**D5. A failing benchmark threshold does not block the release.**
`packages/eval/run.py` asserts `RecallAccuracy@5 >= mem0_baseline AND AnswerQuality
>= 0.7` and exits 1 otherwise. For v0.1 the honest number ships either way; the
assertion gates future regressions, not the first measurement.

**D6. Signing stays optional in v0.1.**
`docs/architecture.md` principle 4 already calls verifiable provenance optional, and
`MNEMONIK_SIGNING` defaults off. Task 7 proves the path works with real credentials;
it does not make signing mandatory or gate the release on Mnemonik availability.

**D7. Packaging strategy is decided inside task 8, not here.**
Three options exist (publish the gbrain fork to npm, bundle a built gbrain into the
published tarball, or ship a thin installer that fetches gbrain). Choosing requires
measuring the built size and checking the gbrain licence. The task records the choice
and its rationale in `decisions.md`.

## Testing Strategy

Four layers, in the order a change meets them:

1. **Unit** — existing mocked suites. Fast, no external dependency, run on every push.
2. **Real-engine integration** — `local.unit.test.ts` (real PGLite, no mocks) plus the
   new Postgres suite from task 6. Cold start is warmed in `beforeAll`; see `112ca70`.
3. **Smoke** — `scripts/mcp-smoke.ts` drives the actual Model Context Protocol server
   over stdio: capture → list → search → think.
4. **Benchmark** — `packages/eval/run.py` against the RUMBA dataset. Not run per push;
   run per release and on demand.

Layers 1-3 run in continuous integration. Layer 4 is manual for v0.1 (dataset size and
runtime are unmeasured; making it a push gate before knowing its cost is premature).

## Dependencies

- Bun >= 1.3.10 (`README.md` prerequisite; 1.3.11 verified working in this session).
- The gbrain fork pin `mnemonik-dev/gbrain@universal-memory-pin` (`271fcdd`) — carries
  the `./think` export. Upstream `garrytan/gbrain#3427` would replace it; out of scope.
- Postgres 15+ with pgvector, for task 6 and the cloud mode generally.
- An embeddings provider for task 5: OpenAI, Google, or a local Ollama with
  `nomic-embed-text`. Anthropic has no embeddings interface — see the caveat in
  `docs/HANDOFF-adapter-integration.md`.
- Mnemonik credentials for task 7: `MNEMONIC_JWT` + `MNEMONIC_IDENTITY`.

## Risks

- **Task 5 and 6 need secrets in continuous integration.** If the repository has no
  secret store configured, both suites run locally only and CI skips them with a
  visible line. That is acceptable for v0.1; it must not be silent.
- **Task 8 may be larger than one task.** If no packaging option works without
  changing how gbrain is consumed, task 8 stops and reports rather than improvising a
  vendoring scheme mid-flight.
- **The gbrain fork is a single point of failure.** The pin is a branch in an
  organisation repository; if that branch is deleted the build breaks exactly as it did
  with the original dead pin. Task 1 catches it on the next run, not months later.

## Acceptance Criteria

Mapped one-to-one onto the user spec: AC1 → task 1, AC2 → task 2, AC3 → task 3,
AC4 → task 4, AC5 → task 5, AC6 → task 6, AC7 → task 7, AC8 → task 8, AC9 → task 9.

## Implementation Tasks

| # | Wave | Task | Depends on |
|---|---|---|---|
| 1 | 1 | Continuous integration pipeline | — |
| 2 | 1 | TypeScript configuration + working typecheck | — |
| 3 | 1 | RUMBA dataset availability | — |
| 4 | 2 | First RUMBA benchmark run + published numbers | 3 |
| 5 | 2 | Embedding path (hybridSearch) test coverage | 1, 2 |
| 6 | 2 | CloudAdapter against real Postgres + pgvector | 1, 2 |
| 7 | 3 | Live Mnemonik signing round trip | 1, 2 |
| 8 | 3 | One-command installation | 2, 5, 6 |
| 9 | 4 | Release: deploy, documentation actualisation, tag | 4, 6, 7, 8 |

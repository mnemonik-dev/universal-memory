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

## Scope change 2026-09-06: dogfooding replaces the infrastructure-first plan

**Status:** Applied — the specification set was rewritten, not amended.
**Agent:** main agent

**Summary:** The first draft of this specification decomposed v0.1 into nine
infrastructure tasks — continuous integration, a typecheck, a benchmark run, packaging,
deployment. Completing all nine would have produced a well-tested system with no users,
including us. The owner rejected it. v0.1 is now one acceptance test: the system is used
for real work, every day, from any machine.

Two requirements were added by the owner and drive the architecture: usable from **any
machine**, and usable inside a **secured enterprise environment**. Together they settle
three things that were previously open — the brain is hosted rather than laptop-local
(there is no working two-way sync: `HybridAdapter` pushes only), clients install nothing
(a URL and a token), and embeddings are computed on our own host so no document text
leaves the perimeter.

**RUMBA is dropped from v0.1** for two independent reasons. First, it measures a
different product: personalised recall across multi-session dialogue, whereas this
system serves coding agents over specifications, code and transcripts. Second, our
harness does not compute the benchmark's metric — `packages/eval/run.py` states at line
131 that its AnswerQuality is a substring heuristic, "a heuristic proxy for the
LLM-judge AnswerQuality metric", while the stored mem0 baseline was produced by the
research team's actual judge. Publishing that comparison would be a number that looks
like a comparison and is not. Source for what the benchmark is:
https://github.com/ai-forever/RUMBA (origin recorded only in the init commit message
`c5715c4`; it was never mapped in `.gitmodules`). Replaced by a twenty-question
known-answer check on our own corpus (task 4).

**Also deferred out of v0.1:** npm publication (an HTTP client installs nothing),
`memory_sync` pull and bidirectional, the three unbuilt ingestors, per-memory source
metadata, the live Mnemonik signing round trip, the upstream gbrain re-pin, and
`tsconfig.json` with a working typecheck. Task 8 decides each one explicitly.

**Deviations:** The previous nine-task set was removed rather than kept alongside. Its
content survives here and in git history (`a849c12`).

## Reconciliation 2026-09-06: embedding-bridge and latent-bridge folded in

**Status:** Applied
**Agent:** main agent

**Summary:** A second specification set, `work/embedding-bridge/`, plus the research
directory `research/latent-bridge/` and `docs/hardware.md`, were written on 2026-09-03 on
branch `claude/intermodel-bridge-research-f557bl` and had never been merged — they were
invisible from `main`, which is why an earlier reading of this repository wrongly reported
that no specifications existed. That branch is now merged here so the three sets sit side
by side with an explicit boundary.

**The boundary:** `work/embedding-bridge/` diagnoses a real defect — `config.ts` selects
the embedder from whichever key is present, and the Google/Ollama pair (both 768
dimensions) fails silently rather than loudly. Under hosted-first with one self-hosted
provider that defect mostly cannot occur, with one exception that occurs immediately:
task 2 permits substituting a smaller embedding model, which would strand the corpus task
4 ingests. v0.1 therefore takes the guard as **task 9** (tag rows, never compare across
models) and leaves the anchor-relative bridge in its own folder behind its own gate.

`research/latent-bridge/` needs GPUs this repository does not have and models this product
does not serve. Parked; blocks nothing.

**Verification performed on the merged research** (2026-09-06): all four external
citations were checked against their sources and are accurate — Moschella et al. ICLR
2023 (arXiv:2209.15430), vec2vec (arXiv:2505.12540, and its security framing is used
correctly in that set's D5), the Platonic Representation Hypothesis (arXiv:2405.07987,
correctly labelled a hypothesis), and Cache-to-Cache (arXiv:2510.03215, quoted figures
verbatim from the abstract). Mostik's claims are corroborated as *self-reported* by
secondary coverage. Two open items were raised against that set and recorded in its own
decisions log: its gating evaluation cannot run, and one quoted figure needs a source
check.

**Deviations:** Acceptance criteria were renumbered when the guard was inserted while task
identifiers were left stable, so AC8 maps to task 9 and AC9 to task 8. The mapping in
tech-spec.md is authoritative.

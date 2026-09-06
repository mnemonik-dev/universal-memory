# Decisions — embedding-bridge

Append-only log. Each entry: date, who, what, why, what changes downstream.

---

## 2026-09-03 — Feature folder created

Author: claude (research session on mostik.ai / inter-model latent communication).

Origin: reviewing [mostik.ai](https://mostik.ai/read-more) (out of stealth
2026-09-02) raised the question of whether we can build an "inter-model bridge".
Their bridge operates on LLM hidden states and needs open-weight models we serve
ourselves — out of reach for this codebase. The adjacent bridge that *is* in reach
is between **embedding spaces**, and it turns out we have a live bug there:
`config.ts` swaps embedders based on which API key is present, so memory written
under one provider is unsearchable — or, for the 768↔768 Google/Ollama pair,
silently mis-searched — under another.

Scope locked for V1: anchor set + projector + sidecar table + bridged search +
backfill + gating eval + anchor-set attestation.

Out of V1: learned space translation (vec2vec-style), pgvector-backed ANN over
relative vectors, anchor-set negotiation between remote peers, per-user anchors.

---

## D1 — Anchor-relative representations, not a learned mapping

Two families solve cross-space retrieval. Learned translators
([vec2vec, arXiv:2505.12540](https://arxiv.org/abs/2505.12540)) reach higher
fidelity but need a training run, a checkpoint per model pair, and a retraining
obligation every time a provider ships a new embedder. Anchor-relative
representations ([arXiv:2209.15430](https://arxiv.org/abs/2209.15430)) need zero
training and generalize to any future embedder at the cost of N extra encode calls,
once.

**Decision:** ship anchor-relative. A new provider becomes supported by embedding
1024 anchor strings — a one-time cost of well under a cent — with no ML pipeline,
no checkpoint storage, and no per-pair maintenance. Revisit vec2vec only if the
eval in Task 6 lands between 60 % and 85 % of baseline: that band is where a
learned mapping would be worth its operational weight.

---

## D2 — gbrain is not forked

`vendors/gbrain` is a third-party submodule (`garrytan/gbrain`) that owns the
embedding call, the memory table, and native vector search. Editing it would fork
an upstream dependency to add a feature that does not need to live inside it.

**Decision:** the bridge is a sidecar table plus a package layered above gbrain.
The bridge reads the raw vector gbrain already stored and writes its own rows.
Downstream: no bridge code may import from `vendors/`, and a gbrain upgrade must
never require a bridge change beyond a column read.

---

## D3 — The eval is a gate, not a report

The method's core assumption — that our three providers share enough relational
structure — is empirical and may be false for these specific models. A feature
built on an unverified assumption that ships anyway is worse than no feature: it
would return plausible-looking cross-provider results that are quietly wrong,
which is precisely the failure mode the feature exists to remove.

**Decision:** Task 6 gates the merge. Off-diagonal Recall@10 ≥ 85 % of the
same-embedder diagonal, for every provider pair, at some N ≤ 2048. Below that,
the branch is closed and the negative result is recorded here. Between 60 % and
85 %, re-open D1. Downstream: Tasks 7–8 do not start before Task 6 is green.

---

## D4 — Brute-force top-k in TypeScript, deliberately

Relative vectors are stored as raw float32 blobs and scanned per query rather than
indexed with pgvector. Reasons: PGLite (local, WASM) and Postgres (cloud) then
behave identically with no extension dependency, and at N = 1024 an ANN index adds
recall loss on top of whatever the bridge already costs — two approximations
stacked, one of which we are trying to measure.

**Decision:** brute force for V1. Record the query latency at 10k, 100k and 1M
rows during Task 6 and put the numbers here; that measurement, not intuition,
decides when an index becomes necessary.

---

## D5 — Relative representations are NOT anonymization

An anchor-relative vector is a lossy but informative view of the original
embedding, and embeddings are invertible enough to leak their source text:
[Harnessing the Universal Geometry of Embeddings (arXiv:2505.12540)](https://arxiv.org/abs/2505.12540)
demonstrates unsupervised translation *and* inversion between embedding spaces
without paired data, and frames it explicitly as a security result. Because the
anchor set is public and the projection is a published linear map, `r(x)` is if
anything *easier* to reason about for an attacker than the raw vector.

**Decision:** relative vectors inherit the exact confidentiality class of the raw
embedding. They are never logged, never included in a shared or exported bundle
that the raw vector would not be included in, and — specifically — are not
anchored on Arweave. What Mnemonik anchors is the **anchor-set manifest** (public
strings, by construction) and memory hashes, never user relative vectors. Task 8
(security audit) verifies this on the diff.

---

## D6 — Anchor sets are immutable and content-addressed

**Decision:** `anchor_set_id = blake3(canonical_cbor(["um-anchors-v1", [a_1 … a_N]]))`,
order-sensitive, reusing Mnemonik's canonical-CBOR + blake3 path rather than
inventing a second hashing convention. Anchor sets are never edited in place; a
new corpus is a new file with a new id. Every sidecar row carries the id it was
projected under, so two sets coexist and migrate independently. Downstream: a
query only ever compares relative vectors sharing one `anchor_set_id`.

---

## 2026-09-06 — Reviewed, merged, and sequenced behind v0.1

Author: claude (session reconciling this set with `work/universal-memory-v0.1/`).

**Review outcome: the diagnosis holds.** `config.ts:120,151,169` does select the embedder
from whichever key is present, and the Google/Ollama pair at 768 dimensions does fail
silently rather than loudly. All four external citations were verified against their
sources and are accurate, including the figures quoted from the Cache-to-Cache abstract.
D5's use of the vec2vec security result to refuse anonymization claims is correct and is
the strongest decision in this set.

**D7 — The gating evaluation cannot run as written.** Task 6 gates the merge on RUMBA,
but `research/RUMBA` is a gitlink with no `.gitmodules` mapping and an empty directory, so
`packages/eval/run.py` cannot load its dataset. Separately, that harness states at line 131
that its AnswerQuality is "a heuristic proxy for the LLM-judge AnswerQuality metric",
while the stored mem0 baseline was produced by the research team's actual judge —
comparing them yields a number that looks like a comparison and is not.

**Decision:** the kill criterion stands, but it must be made executable before this
feature is actionable. Either map the dataset and run the real judge, or restate the gate
against an evaluation we can run on our own corpus. Until then Task 6 cannot pass or fail,
which means no task after it can start.

**D8 — The 85 % threshold needs a derivation.** The number is asserted, and so is
Recall@10 as the metric. A kill criterion is only as good as its number: record why 85 %
rather than 70 % or 95 %, in terms of what a user would notice.

**D9 — Sequencing against v0.1.** Under `work/universal-memory-v0.1/`, the deployment runs
one self-hosted embedder, so there is normally nothing to bridge. The exception is real
and immediate: v0.1's task 2 permits substituting a smaller embedding model, which would
strand an already-ingested corpus. **The guard half of this feature — tag every row with
its embedding model, never compare across models — is pulled forward as v0.1 task 9.**
The anchor-relative projection stays here.

**Decision:** this set is deferred until the v0.1 week-one verdict, and resumes only if
that verdict says continue and cross-provider portability is something a real user
actually needed. Downstream: Tasks 1-8 here stay `planned`; Task 6's gate must be made
runnable before any of them starts.

---

## 2026-09-06 — D10: the gate is executable; D7's blocker is cleared

Author: claude (same session as D7-D9).

**What was wrong.** D7 recorded two problems: the dataset could not be loaded, and the
harness's metric did not match the baseline it compared against. Both are resolved, by
different means — one was fixed, the other was scoped out of the gate.

**Dataset — fixed.** `research/RUMBA` was a gitlink with no `.gitmodules` mapping,
pinned to `ba08160`, which the remote does not have (`upload-pack: not our ref`) — the
identical dead-pin failure gbrain suffered. Mapped to
`https://github.com/ai-forever/RUMBA.git` and re-pinned to `a20471a`. Verified:
`data_locomo_format_en.json` loads, 85 dialogues, 1543 QA pairs, each with
`question`/`answer`/`evidence`/`category`.

**Metric — scoped out, not papered over.** The harness's AnswerQuality is a substring
proxy and the mem0 baseline is an LLM-judge score; they are not comparable. That
mismatch does not touch this gate, because the gate is **self-relative**: off-diagonal
Recall@10 against the diagonal of the same `query_model`, same dataset, same metric. A
deterministic Recall@k over the dataset's own evidence spans is comparable to itself.
The gate therefore uses Recall@k only, and the mem0 comparison is explicitly not a
gate. `run.py` prints that caveat on every run so the distinction cannot be lost.

**Three harness defects fixed while making this runnable:**

1. `--dry-run` was documented in the module docstring but never wired into argparse —
   the flag simply did not exist. Now it does, and it validates the dataset.
2. The dry-run path wrote `universal-memory.json` — *the results filename* — containing
   the mem0 baseline's own numbers, printed "ALL ASSERTIONS PASSED", and exited 0. Any
   automated run on a machine without Bun would have produced a fabricated green with a
   plausible-looking results file. It now writes `dry-run.json`, states that no
   measurement was performed, and prints no PASS line.
3. A missing Bun during a real run silently degraded into that dry run. It is now a
   hard error with exit 1. Same principle as v0.1's D3: never degrade silently.
4. Results defaulted into `research/RUMBA/results/` — inside the submodule, where they
   would dirty it or be lost. Now `packages/eval/results/`.

**Still open (D8):** the 85 % threshold remains asserted rather than derived. The gate
can now run; what the number means to a user is still unargued.

**Downstream:** Task 6 is unblocked and carries the exact commands. It still needs Bun
plus all three providers reachable, and it still gates Tasks 7-8. Sequencing under D9 is
unchanged: this set waits on the v0.1 week-one verdict.

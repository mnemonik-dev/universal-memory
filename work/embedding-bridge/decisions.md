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

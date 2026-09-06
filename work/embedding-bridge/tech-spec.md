---
created: 2026-09-03
status: draft
size: M
branch: claude/intermodel-bridge-research-f557bl
---

# Tech Spec: Embedding Bridge

## Method

Anchor-relative representations, per Moschella et al., *Relative representations
enable zero-shot latent space communication*, ICLR 2023
([arXiv:2209.15430](https://arxiv.org/abs/2209.15430)).

Fix an ordered anchor set `A = (a_1 … a_N)` of natural-language strings. For an
embedder `E`, compute the anchor matrix `M_E ∈ R^{N×d_E}` once, with each row
L2-normalized. For a memory text `x` with stored vector `v = E(x)`:

```
r(x) = normalize( M_E · normalize(v) )        # r(x) ∈ R^N
```

`r(x)` lives in `R^N` for every embedder. Retrieval across embedders is cosine
similarity over `r`. Nothing is trained; this is one mat-vec product per memory.

Why it should work at all: independently trained encoders converge toward similar
relational structure even when their absolute coordinates differ — the empirical
claim of the *Platonic Representation Hypothesis*
([arXiv:2405.07987](https://arxiv.org/abs/2405.07987)) and the premise the ICLR'23
paper exploits. Whether it holds *well enough* on our three specific providers is
exactly what Task 6 measures, and the spec is written so a negative result closes
the feature cheaply.

## Why this feature exists (grounding)

`packages/memory-hub/src/config.ts:120,151,169` picks the embedder from whichever
API key is present:

| Key present | `embedding_model` | Native dim |
| --- | --- | --- |
| `OPENAI_API_KEY` | `openai:text-embedding-3-small` | 1536 ([OpenAI docs](https://platform.openai.com/docs/guides/embeddings)) |
| `GOOGLE_API_KEY` | `google:text-embedding-004` | 768 ([Gemini API docs](https://ai.google.dev/gemini-api/docs/embeddings)) |
| Ollama reachable | `ollama:nomic-embed-text` | 768 ([model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)) |

Google ↔ Ollama share `d = 768` and are geometrically unrelated. That pair fails
*silently* today: cosine is computable, results are returned, relevance is noise.
This is the primary bug the feature closes; cross-provider portability is the
feature it buys.

## Architecture

`vendors/gbrain` is a third-party submodule (`garrytan/gbrain`) and is **not
modified**. Same discipline as universal-paywall's "never modify the platform
forks". The bridge is a new package plus a sidecar table owned by `memory-hub`.

### Files added

- `packages/embedding-bridge/` — new workspace package `@universal-memory/embedding-bridge`.
  - `src/anchors.ts` — anchor-set loading, canonicalization, content-addressed id.
  - `src/anchors/anchor-set-v1.json` — the frozen N = 1024 anchor corpus.
  - `src/project.ts` — `buildAnchorMatrix(embed, anchors)`, `project(v, M)`.
  - `src/cache.ts` — on-disk anchor-matrix cache keyed by `(anchor_set_id, embed_model)`.
  - `src/search.ts` — cosine top-k over relative vectors.
  - `src/index.ts` — public surface.
- `packages/memory-hub/src/storage/relative.ts` — sidecar table DDL, upsert, query.
- `packages/memory-hub/src/storage/migrations/001_relative_vectors.sql`.
- `packages/embedding-bridge/bin/backfill.ts` — backfill CLI for existing databases.
- `packages/eval/src/cross-embedder.ts` — RUMBA cross-embedder Recall@k harness.

### Files modified

- `packages/memory-hub/src/ingest/pipeline.ts` — on write, tag `embed_model` and
  upsert the relative vector.
- `packages/memory-hub/src/storage/{local,cloud,hybrid}.ts` — bridged search path
  and RRF fusion.
- `packages/memory-hub/src/config.ts` — export the resolved `embedding_model` id
  (currently only logged, not returned).
- `packages/memory-hub/src/mcp/server.ts` — surface `embed_model` and
  `anchor_set_id` on recall results.
- `adapters/mnemonik/` — anchor-set manifest attestation (Task 7).

### Sidecar schema

```sql
CREATE TABLE IF NOT EXISTS um_relative_vectors (
  memory_id      TEXT NOT NULL,
  user_id        TEXT,
  anchor_set_id  TEXT NOT NULL,   -- blake3 of the canonical anchor list
  embed_model    TEXT NOT NULL,   -- e.g. 'openai:text-embedding-3-small'
  rel_dim        INTEGER NOT NULL,
  rel_vec        BYTEA  NOT NULL, -- float32[rel_dim], little-endian
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, anchor_set_id)
);
CREATE INDEX IF NOT EXISTS um_relative_vectors_user_idx
  ON um_relative_vectors (user_id, anchor_set_id);
```

`rel_vec` is stored as raw float32 rather than `vector(N)` so the table works
identically under PGLite (local, WASM) and Postgres (cloud) without requiring
pgvector at N = 1024. Top-k is computed in TypeScript over a user-scoped scan.
That is O(rows) per query — acceptable at the personal-memory scale this product
targets, and the point at which it stops being acceptable is a measured follow-up,
not a guess (see Decision D4).

### Search path

```
query text ──▶ E_current(query) ──┬──▶ gbrain native search   (rows where embed_model = current)
                                  └──▶ project() ──▶ bridge search (rows where embed_model ≠ current)
                                                        │
                                          RRF fusion ◀──┘  ──▶ ranked results
```

Rows whose `embed_model` matches the active model never go through the bridge:
the native path is strictly better and already paid for. The bridge only covers
the rows that are otherwise unreachable.

## Anchor set

- **N = 1024.** Task 6 sweeps N ∈ {256, 512, 1024, 2048} and the shipped value is
  whichever is smallest at ≥ 85 % relative Recall@10. 1024 is the starting guess,
  not a result.
- **Composition.** Domain-spread short passages (technical, prose, code, dialogue,
  numeric, multilingual), deduplicated, each 1–3 sentences. Anchors must not be
  drawn from user data — the set ships in-repo and is public by construction.
- **Identity.** `anchor_set_id = blake3(canonical_cbor(["um-anchors-v1", [a_1 … a_N]]))`,
  matching Mnemonik's existing canonical-CBOR + blake3 discipline. Order is part
  of the identity: reordering yields a different set.
- **Immutability.** An anchor set is never edited. A new corpus is a new
  `anchor-set-v2.json` with a new id; rows carry the id they were projected under,
  so both can coexist and be migrated independently.

## Hardware

No GPU. The bridge adds arithmetic and storage, not compute class: a 6.29 MB
anchor matrix per model, 4 KB per memory, and a per-query scan whose cost is
tabulated in [`docs/hardware.md`](../../docs/hardware.md) (tier B). Backfill is
memory-bound at under 100 MB peak and re-projects stored vectors without
re-embedding any text.

## Testing

- **Unit** — projection math: known vectors against a hand-computed matrix;
  invariance under scaling of `v`; determinism of `anchor_set_id`.
- **Contract** — sidecar upsert/query round-trip on PGLite and on Postgres.
- **Integration** — write memories under a mock embedder A, search under mock
  embedder B, assert bridged results are non-empty and correctly ordered.
- **Eval (gating)** — `packages/eval` cross-embedder Recall@{1,5,10} matrix over
  {openai, google, ollama} × {openai, google, ollama} on RUMBA. The diagonal is
  the same-embedder baseline; off-diagonal cells must reach ≥ 85 % of the
  corresponding diagonal at Recall@10.
- **Regression** — same-embedder recall must not degrade. The bridge is additive;
  if the fused ranking is worse than native-only on the diagonal, RRF weighting is
  wrong and the task is not done.

## Waves

| Wave | Tasks | Notes |
| --- | --- | --- |
| 1 | 1, 2 | Anchor set + projector. No storage contact, parallel-safe. |
| 2 | 3, 4 | Sidecar storage, then write/search wiring. 4 depends on 3. |
| 3 | 5, 6 | Backfill CLI + the gating eval. **Gate: stop here on failure.** |
| 4 | 7, 8 | Mnemonik attestation of the anchor set; code + security audit. |

Tasks 3 and 4 both touch `packages/memory-hub/src/storage/` — do not run them in
parallel.

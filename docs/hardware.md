# Hardware requirements

Three tiers, independent of each other. Pick the one matching what you are running.

| Tier | What it runs | GPU |
| --- | --- | --- |
| A. Repo dev environment | `memory-hub`, PGLite/Postgres, tests | none |
| B. Embedding bridge (`work/embedding-bridge/`) | tier A + anchor projection + backfill | none |
| C. Latent-bridge sandbox (`research/latent-bridge/`) | Cache-to-Cache reproduction | **required** |

Tiers A and B run on a laptop. Tier C does not, and no CI or dev environment in
this repository has a GPU — a rented box is a prerequisite, not a detail.

---

## A. Repo development environment (no GPU)

`docker-compose.yml` brings up `pgvector/pgvector:pg16` plus the Bun-based
`memory-hub`. Local mode replaces Postgres with PGLite (embedded Postgres compiled
to WebAssembly) and runs in-process.

| Resource | Minimum | Comfortable | Why |
| --- | --- | --- | --- |
| CPU | 2 cores | 4+ cores | Bun test suite, PGLite |
| RAM | 4 GB | 8 GB | PGLite holds its working set in memory; Postgres container ~1 GB |
| Disk | 10 GB | 25 GB | repo + `node_modules` + Postgres volume |
| Network | any | — | provider APIs, unless fully offline |

**Fully offline (Ollama path).** `config.ts` falls back to
`ollama:nomic-embed-text` when no API key is present. The Ollama model is ~274 MB
([model page](https://ollama.com/library/nomic-embed-text)), and the chat fallback
`llama3.2` adds ~2 GB. Add ~8 GB RAM if you also run the chat model; embeddings
alone are cheap. No GPU needed — CPU inference on an embedding model this size is
fine for development.

**Production VPS.** `DEPLOY.md` currently states no sizing. For the Docker Compose
stack (Postgres + memory-hub + nginx), 2 vCPU / 4 GB RAM / 40 GB SSD is a workable
floor; 4 vCPU / 8 GB is comfortable once the corpus grows. Postgres, not the Bun
server, is what will want the RAM.

---

## B. Embedding bridge additions (still no GPU)

The bridge adds arithmetic and storage, not compute class. Sizes are exact for
N = 1024 anchors, float32:

| Item | Size | Note |
| --- | --- | --- |
| Anchor matrix, `openai:text-embedding-3-small` (d = 1536) | 6.29 MB | cached on disk, per model |
| Anchor matrix, `google:text-embedding-004` / `nomic-embed-text` (d = 768) | 3.15 MB | " |
| Relative vector, per memory | 4 KB | vs. 6 KB for a raw 1536-dim vector |
| 100 000 memories | ~400 MB | sidecar table |
| 1 000 000 memories | ~4 GB | " |

**One-time cost per provider:** 1024 embedding calls to build the anchor matrix.
Against a hosted API that is a fraction of a cent; against local Ollama it is
seconds of CPU.

**Brute-force scan cost (Decision D4).** The bridged search path scans the
user's relative vectors:

| Rows scanned | Bytes read per query |
| --- | --- |
| 10 000 | 0.04 GB |
| 100 000 | 0.41 GB |
| 1 000 000 | 4.10 GB |

At 10k rows this is trivially fast; at 1M it plainly is not, which is why D4 is a
deliberate V1 decision with a measurement attached rather than a permanent one.
These are arithmetic, not measurements — Task 6 records real p50/p95 latency and
those numbers, not these, decide when an index becomes necessary.

**Backfill.** Memory-bound, not compute-bound: it re-projects stored vectors and
never re-embeds text. Peak RAM ≈ batch size × (d + N) × 4 bytes plus the anchor
matrix — under 100 MB at batch 512. Tier A hardware is sufficient.

---

## C. Latent-bridge sandbox (GPU required)

Sizing for the [C2C reproduction plan](../research/latent-bridge/c2c-reproduction-plan.md),
using the upstream recipe's pair: receiver `Qwen/Qwen3-0.6B` (28 layers, hidden
1024, intermediate 3072, 8 KV heads × 128), sharer `Qwen/Qwen2.5-0.5B-Instruct`
(24 layers, hidden 896, 2 KV heads × 64). Weights in bf16: 1.50 GB + 0.99 GB.

### Phase 0 — inference only

Loads both models plus the released projector, greedy decoding, 64 new tokens.

| Resource | Minimum | Comfortable |
| --- | --- | --- |
| GPU VRAM | 8 GB (RTX 3060/4060, T4) | 16–24 GB |
| Host RAM | 16 GB | 32 GB |
| Disk | 50 GB | 100 GB |
| CUDA | 12.x with a matching PyTorch build | — |

Weights 2.5 GB + KV caches (Qwen3-0.6B is ~0.115 MB/token; 2048 tokens ≈ 235 MB)
+ projector. A single consumer card is genuinely enough for the go/no-go that
decides everything downstream.

### Phase 1 — training the projector

The shipped recipe is `per_device_train_batch_size` 4 × `gradient_accumulation_steps` 8
× `num_processes` 8 → effective batch 256, sequence length 2048. Both models are
frozen, but gradients still flow *through* the receiver to reach the projector, so
the receiver's activations must be retained. That, not the weights, is the cost.

Estimated per-device VRAM at bs 4 × 2048 tokens:

| Component | Estimate |
| --- | --- |
| Receiver activations (28 layers, 8192 tokens) | ~8.9 GB |
| Output logits (8192 × 151 936 vocab, bf16) | ~2.5 GB, up to ~7.5 GB if cross-entropy upcasts to fp32 |
| Model weights (both) | ~2.5 GB |
| Sharer KV cache (no-grad) | ~0.1 GB |
| Projector + AdamW optimizer states | ~1.5 GB |
| **Total** | **~15.5–20.5 GB** |

| Configuration | Per-GPU VRAM | Notes |
| --- | --- | --- |
| Shipped recipe, 8 GPUs, bs 4 | 24 GB min, 40–80 GB comfortable | 8× A100 40 GB / L40S / RTX 4090 |
| 1 GPU, bs 1 + accum 256 | 12–16 GB | same effective batch, ~8× the wall-clock |
| 2 GPUs, bs 2 + accum 64 | 16–24 GB | middle ground |

Host: 8+ CPU cores (dataloader), 64 GB RAM for an 8-GPU node, 200–500 GB NVMe
(HF cache, 500k-sample OpenHermes, checkpoints every 500 steps). Multi-GPU wants
NVLink or PCIe 4.0 x16; the projector is small so gradient traffic is light.

**Wall-clock is not estimated here on purpose.** The public recipe states none, and
guessing it is how GPU budgets get blown. Phase 1 starts with a 1 % subset to
measure throughput, and that probe *is* the budget estimate.

### Phase 2 — large sharer, small receiver

The asymmetric regime worth productizing. With `Qwen3-8B` as sharer (16.4 GB bf16)
and `Qwen3-0.6B` as receiver: ~18 GB of weights before activations, so **40 GB
minimum, 80 GB comfortable** (A100 80 GB / H100). The sharer runs under no-grad,
so its activations are not retained — its weights are the cost.

### Reality check on the Mostik regime

Mostik's published result uses a 753B sender. At bf16 that is **~1.5 TB of weights**
— roughly **19× 80 GB GPUs for the weights alone**, before activations, KV cache,
or serving overhead. Nothing in Phases 0–2 tests that regime, and reaching it is a
different category of budget. Do not read a green Phase 1 as evidence about it.

### Rental notes

Phase 0 is one card for a day. Phase 1 is a multi-GPU node for an unknown span —
rent hourly and hold the reservation only after the throughput probe. Check
current rates directly with the provider; no pricing is quoted here because it
moves faster than this document will.

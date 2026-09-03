# C2C reproduction plan

Staged plan for reproducing Cache-to-Cache
([arXiv:2510.03215](https://arxiv.org/abs/2510.03215), ICLR'26,
[code](https://github.com/thu-nics/C2C), Apache-2.0) and deciding whether a latent
inter-model bridge is worth building here.

Ordered cheapest-falsification-first. Every phase ends in a go/no-go, and it is
expected — not a failure of the plan — that most runs stop at Phase 0 or 1.

## The decision this informs

> Should we serve a latent-bridged model pair anywhere in our stack (Fabric agents,
> memory synthesis, the MCP server's `think` path), instead of a single model or a
> text hand-off between two?

Answering "no" cheaply is a valid and likely outcome. The point of Phase 0 is to
reach that answer for the price of one GPU-day rather than one training run.

## What the upstream config actually specifies

Read from the repo, not from the paper's prose
([train recipe](https://raw.githubusercontent.com/thu-nics/C2C/main/recipe/train_recipe/C2C_0.6%2B0.5.json),
[eval recipe](https://raw.githubusercontent.com/thu-nics/C2C/main/recipe/eval_recipe/unified_eval.yaml)):

**Training** (`recipe/train_recipe/C2C_0.6+0.5.json`):

| Field | Value |
| --- | --- |
| `base_model` (receiver, generates) | `Qwen/Qwen3-0.6B` |
| `teacher_model` (sharer, contributes cache) | `Qwen/Qwen2.5-0.5B-Instruct` |
| Projector | `C2CProjector`, `hidden_dim` 1024, `intermediate_dim` 1024, 3 layers, dropout 0.1 |
| Gate temperature | annealed 1.0 → 0.001 over 1929 steps |
| Optimizer | lr 1e-4, weight decay 0.01, linear schedule, warmup 0.1, grad clip 1.0 |
| Batching | `per_device_train_batch_size` 4 × `gradient_accumulation_steps` 8 × `num_processes` 8 |
| Sequence length | 2048 |
| Epochs | 1 |
| Frozen | `["teacher", "base"]` — only the projector trains |
| Data | `OpenHermesChatDataset`, 500 000 samples, `train_ratio` 0.99 |

**Evaluation** (`recipe/eval_recipe/unified_eval.yaml`): `mmlu-redux`, greedy
decoding, `max_new_tokens` 64, chat template on, single GPU. The same file ships a
`two_stage` baseline — `context_model` Qwen3-4B writes a one-sentence background,
`answer_model` Qwen3-0.6B answers — which is the text-hand-off comparison, i.e.
the same contrast Mostik draws.

Seven pretrained projectors are published on Hugging Face, including
Qwen3-0.6B + Qwen2.5-0.5B, Qwen3-0.6B + Llama-3.2-1B (cross-family),
Qwen3-1.7B + Qwen2.5-1.5B, and Qwen3-8B + Qwen2.5-7B. Note the configs use the
project's internal name "Rosetta" for the bridged model type.

## Phase 0 — Verify without training (~1 GPU-day, 1× 24 GB)

Goal: does the published artifact reproduce the published claim on our hardware?

1. Python 3.10, `pip install -e ".[training,evaluation]"`. Record exact
   commit SHA, `torch`, `transformers` and CUDA versions — cache-surgery code is
   tightly coupled to `transformers` internals and this is the most likely source
   of a silent break.
2. Pull the released Qwen3-0.6B + Qwen2.5-0.5B projector; run
   `script/evaluation/unified_evaluator.py` on `mmlu-redux`.
3. Run three baselines on the identical harness: receiver alone, sharer alone, and
   the built-in `two_stage` text hand-off.
4. Record accuracy and wall-clock latency for all four.

**Go/no-go.** Bridged must beat both single models, and beat the text hand-off, in
our own numbers. If the published projector does not reproduce its own paper on
our hardware, stop — nothing downstream is worth doing, and that result is itself
worth writing down.

## Phase 1 — Reproduce the training run (small pair)

Only if Phase 0 passes.

1. Train the 0.6B + 0.5B projector from scratch on the shipped recipe. **First run
   1 % of OpenHermes** to measure throughput, then extrapolate the full-run cost
   before committing to it. Do not budget from the config alone — the public
   recipe states no wall-clock, and 8 processes × 500k samples × 2048 tokens is
   the kind of number that is cheap to guess wrong.
2. Compare the from-scratch projector against the released checkpoint on the
   Phase 0 harness.
3. Ablate what the paper claims carries the result: the learnable layer gate
   (fixed vs. learned), and the temperature anneal.

**Go/no-go.** From-scratch must land within ~1 point of the released checkpoint.
A large gap means the recipe is incompletely specified — record which knob was
missing and stop.

## Phase 2 — Our pair, our data

Only if Phase 1 passes.

1. Choose the pair from an actual deployment shape, not from the paper's. The
   interesting asymmetry — and the one Mostik sells — is **large sharer, small
   receiver**: a strong model prefills, a cheap model decodes. The shipped recipe
   is roughly peer-to-peer, so this is a change in kind, not a parameter tweak.
   Expect the cross-family case (e.g. Llama sharer → Qwen receiver) to be the hard
   one; a released cross-family projector exists, so measure that before assuming.
2. Train on a domain mixture that matches our own traffic, not OpenHermes alone.
3. Evaluate on our task, not `mmlu-redux`: an internal set with a text hand-off
   baseline built from the same two models.

**Go/no-go.** The bridged pair must beat the text hand-off *at equal total
compute* on our own task. Beating it on accuracy while costing more is not a win —
that is just a bigger model wearing a costume.

## Phase 3 — Serving, if Phases 0–2 all pass

Open questions, none of them small, listed so nobody mistakes a working checkpoint
for a shippable system:

- Both models must be resident, so the cheap receiver no longer deploys alone. The
  claimed win is compute, not memory.
- KV caches are large and layer-shaped; moving them between processes or hosts is
  a bandwidth problem, and the batch-tolerant "separate endpoints" path Mostik
  describes is where that cost lands.
- Serving stacks (vLLM, SGLang) do not expose the cache-surgery hooks this needs;
  Phase 3 means either patching one or running a bespoke server.
- A projector is pinned to an exact pair of model versions. A point release on
  either side invalidates it. This is the recurring maintenance cost, and it is
  the same reason `work/embedding-bridge/` deliberately chose the training-free
  method for embeddings (see its `decisions.md`, D1).

## Cost and prerequisites

- **Phase 0:** one 24 GB GPU, ~1 day. Nothing else.
- **Phase 1:** multi-GPU (the recipe assumes 8 processes). Cost unknown until the
  1 % throughput probe — that probe *is* the budget estimate.
- **Phases 2–3:** a real project, not a spike. Do not start either without Phase 1
  numbers in hand.

We have no GPUs in this repository's CI or dev environments. Phase 0 needs a
rented box before anything here begins.

## Risks

1. **`transformers` version drift** — the most likely cause of a failed Phase 0,
   and it will look like a bad result rather than a broken install. Pin versions
   and confirm the released checkpoint reproduces *before* changing anything.
2. **Evaluating the wrong contrast.** The honest baseline is the text hand-off at
   equal total compute, not the small model alone. The small model alone is the
   flattering comparison and the one to distrust.
3. **Licensing.** C2C is Apache-2.0, but each model checkpoint carries its own
   licence (Qwen and Llama differ). Check per checkpoint before any deployment.
4. **Scope creep toward Mostik's framing.** Their claim is about a large frozen
   sender at 753B. Nothing in Phases 0–2 tests that regime, and reaching it is a
   different budget entirely. Do not let a green Phase 1 be reported as evidence
   for the large-sender claim.

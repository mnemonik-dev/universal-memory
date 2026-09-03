# research/latent-bridge

Whether we can build an **inter-model bridge** — models cooperating by exchanging
internal state rather than text — and if so, at what cost.

Prompted by [mostik.ai](https://mostik.ai/read-more), which came out of stealth on
2026-09-02 claiming a trained bridge that carries hidden states from a large model
(GLM-5.2, 753B, prefill only, never generates) into a small one (Qwen-3.5, 4B,
does all decoding). Their headline numbers — the small model closing 50 % of the
gap to the large one, 2.5× less compute than the equivalent mid-sized model, up to
+10 percentage points over a text hand-off — are self-reported. There is no paper,
no code, no named benchmark, and no API. External coverage is one
[WIRED article](https://www.wired.com/story/russian-startup-mostik-ai-models-communication/).

The idea is not theirs alone, and the published version of it *is* reproducible:

| Work | What it does | Artifacts |
| --- | --- | --- |
| [Cache-to-Cache (C2C), ICLR'26 — arXiv:2510.03215](https://arxiv.org/abs/2510.03215) | Projects and fuses a source model's KV (key-value) cache into a target model's; learnable gate picks target layers. Both models frozen. | [Code, Apache-2.0](https://github.com/thu-nics/C2C) + 7 pretrained projectors |
| [DroidSpeak — arXiv:2411.02820](https://arxiv.org/abs/2411.02820) | KV cache sharing for cross-LLM communication and multi-LLM serving | Paper |
| [CALM (Google) — arXiv:2401.02412](https://arxiv.org/abs/2401.02412) | Composes two frozen models via trained cross-attention | Paper |

C2C's reported results (+6.4–14.2 % over individual models, +3.1–5.4 % over text
communication, 2.5× latency speedup) cover roughly the same ground Mostik
announced, with an Apache-2.0 implementation attached. So the reproduction question
is answerable without waiting for Mostik to publish anything.

## Contents

- [`c2c-reproduction-plan.md`](./c2c-reproduction-plan.md) — staged plan, cheapest
  falsification first, with explicit kill criteria at each stage.

## Relationship to `work/embedding-bridge/`

Different layer, do not conflate them:

- **This directory** — bridges between *LLM hidden states / KV caches*. Requires
  open-weight models we serve ourselves on our own GPUs. Research; may not ship.
- **`work/embedding-bridge/`** — bridges between *embedding spaces*. Needs no GPU
  and no training, fixes a live cross-provider bug in `memory-hub`, and is
  specified as a normal feature with a gating eval.

Nothing in this directory blocks that one.

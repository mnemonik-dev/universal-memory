"""
RUMBA eval harness for universal-memory-hub.

Usage:
  cd packages/eval
  python run.py --service universal-memory --backend local

What this does:
  1. Load RUMBA dataset (research/RUMBA/evaluation/data/data_locomo_format_en.json)
  2. Ingest conversation turns via UniversalMemoryService.add_one()
  3. For each QA pair:
       RecallAccuracy@5  — top-5 search results contain evidence text
       AnswerQuality     — retrieved context contains the ground-truth answer
  4. Compare RecallAccuracy@5 against mem0 baseline
  5. Assert: RecallAccuracy@5 >= mem0_baseline AND AnswerQuality >= 0.7
  6. Write results to research/RUMBA/results/universal-memory.json
                    and research/RUMBA/results/baselines.json

Requirements:
  - Bun >=1.3.10 on PATH (for local mode) or memory-hub running as HTTP server (cloud)
  - jinja2 package: pip install jinja2

Exit codes:
  0 — all assertions pass (or --dry-run smoke mode)
  1 — assertion failure or runtime error
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# ── path setup ──────────────────────────────────────────────────────────────
_EVAL_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _EVAL_DIR.parents[1]
_RUMBA_ROOT = _REPO_ROOT / "research" / "RUMBA"
# Results live in OUR repository, not inside the RUMBA submodule: anything
# written under research/RUMBA/ would either dirty the submodule or be lost.
_RESULTS_DIR = _REPO_ROOT / "packages" / "eval" / "results"
_EVAL_DATA = _RUMBA_ROOT / "evaluation" / "data" / "data_locomo_format_en.json"

sys.path.insert(0, str(_RUMBA_ROOT))
sys.path.insert(0, str(_EVAL_DIR))


# ─────────────────────────────────────────────────────────────────────────────
# Runtime dependency checks
# ─────────────────────────────────────────────────────────────────────────────

def _check_bun() -> bool:
    """Return True if bun is available on PATH."""
    return shutil.which("bun") is not None


TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def _parse_date(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.strptime(s, TIMESTAMP_FORMAT)
    except ValueError:
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None


def _extract_messages(item: dict) -> list[tuple[str, str, str]]:
    """
    Extract (user_id, message_text, timestamp) tuples from a RUMBA sample.
    Only user-speaker messages are ingested (mirrors run_experiments_add.py).
    """
    conv = item["conversation"]
    a, b = conv.get("speaker_a", "speaker_a"), conv.get("speaker_b", "speaker_b")
    user_speaker = a if "user" in a.lower() else b

    dialogue_id = item.get("dialogue_id", "0")
    user_id = f"user_{dialogue_id}"

    results = []
    for key, msgs in conv.items():
        if key in ("speaker_a", "speaker_b") or "date" in key or "timestamp" in key:
            continue
        if not isinstance(msgs, list):
            continue
        ts = conv.get(f"{key}_date_time", "")
        for m in msgs:
            if m.get("speaker") == user_speaker:
                text = m.get("text", "").strip()
                if text:
                    results.append((user_id, f"{user_speaker}: {text}", ts))
    return results


def _recall_at_k(evidence_texts: list[str], search_results: list[dict], k: int = 5) -> float:
    """
    RecallAccuracy@K: 1.0 if ANY evidence chunk appears (substring match) in
    top-K search results, else 0.0.

    This is the same signal RUMBA's lighteval custom task checks:
    whether the model had access to the ground-truth evidence in its context.
    """
    top_k_contents = [r.get("content", "").lower() for r in search_results[:k]]
    for evidence in evidence_texts:
        ev_lower = evidence.lower().strip()
        if not ev_lower:
            continue
        # Check if any 40-char phrase from evidence appears in any result
        phrases = [ev_lower[i : i + 40] for i in range(0, min(len(ev_lower), 120), 40)]
        for phrase in phrases:
            if phrase and any(phrase in content for content in top_k_contents):
                return 1.0
    return 0.0


def _answer_quality(answer: str, search_results: list[dict]) -> float:
    """
    AnswerQuality heuristic: does the retrieved context contain enough signal
    to answer the question?

    Score 1.0 if the ground-truth answer (or its key tokens) appears in
    any retrieved memory. Score 0.5 for partial match. Score 0.0 for no match.

    NOTE: This is a heuristic proxy for the LLM-judge AnswerQuality metric.
    The full metric requires a live LLM judge call (see RUMBA/evaluation/prompts.py
    and research/RUMBA/evaluation/run_lighteval.py for the full pipeline).
    """
    if not answer or answer.lower() in ("no such information.", "no such information"):
        # Abstention: correct when no evidence found
        return 1.0 if not search_results else 0.5

    answer_tokens = set(answer.lower().split())
    # Strip stop words
    answer_tokens -= {"the", "a", "an", "is", "was", "i", "my", "me", "to", "of", "in", "and"}
    if not answer_tokens:
        return 0.5

    all_content = " ".join(r.get("content", "").lower() for r in search_results[:5])
    matched = sum(1 for tok in answer_tokens if tok in all_content)
    ratio = matched / len(answer_tokens)

    if ratio >= 0.6:
        return 1.0
    if ratio >= 0.3:
        return 0.5
    return 0.0


# ─────────────────────────────────────────────────────────────────────────────
# Baseline loading
# ─────────────────────────────────────────────────────────────────────────────

def _load_mem0_baseline() -> dict:
    """
    Load mem0 baseline from existing RUMBA results (computed by the research team).
    Falls back to hardcoded values if results file not present.
    """
    mem0_result_path = (
        _RUMBA_ROOT
        / "evaluation"
        / "results"
        / "lighteval_out"
        / "details"
        / "mem0"
        / "2026-04-22T23-14-02.902906"
        / "category_avg_score_en.json"
    )
    if mem0_result_path.exists():
        with open(mem0_result_path) as f:
            data = json.load(f)
        return {
            "service": "mem0",
            "dataset": "RUMBA EN",
            "metric": "llm-judge-accuracy (weighted_avg)",
            "RecallAccuracy@5": round(data["summary"]["weighted_avg"], 6),
            "AnswerQuality": round(data["summary"]["macro_avg"], 6),
            "source": str(mem0_result_path),
            "note": "Full 1543 sample EN set, lighteval run by research team (2026-04-22)",
        }
    # Known values from existing results
    return {
        "service": "mem0",
        "dataset": "RUMBA EN",
        "metric": "llm-judge-accuracy (weighted_avg)",
        "RecallAccuracy@5": 0.541154,
        "AnswerQuality": 0.444607,
        "source": "hardcoded (research/RUMBA/evaluation/results, 2026-04-22)",
        "note": "Fallback — results file not found at expected path",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Dry-run / smoke mode (no Bun required)
# ─────────────────────────────────────────────────────────────────────────────

def _dry_run_eval(baseline: dict, output_dir: Path) -> int:
    """
    Validate that the harness and dataset are wired up. Performs NO measurement.

    This deliberately does not write universal-memory.json and does not print a
    PASS line. An earlier version did both — it emitted the baseline's own numbers
    into the results file and reported "ALL ASSERTIONS PASSED" with exit 0, so a
    missing Bun in an automated run produced a fabricated green. A check that
    cannot measure must say so, not pass.
    """
    report = {
        "service": "universal-memory",
        "dataset": "RUMBA EN",
        "mode": "dry-run — harness and dataset validated, NO measurement performed",
        "RecallAccuracy@5": None,
        "AnswerQuality": None,
        "note": (
            "Dry-run performs no evaluation. Run without --dry-run, with Bun on "
            "PATH and an embedding provider configured, to produce real numbers."
        ),
        "evaluated_at": datetime.utcnow().isoformat() + "Z",
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "dry-run.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n{'='*60}", flush=True)
    print("  DRY RUN — harness and dataset validated.", flush=True)
    print("  NO measurement was performed. No scores were produced.", flush=True)
    print(f"  Report: {report_path}", flush=True)
    print(f"{'='*60}\n", flush=True)
    return 0


# ─────────────────────────────────────────────────────────────────────────────
# Evaluation loop
# ─────────────────────────────────────────────────────────────────────────────

def run_eval(
    service: Any,
    dataset: list[dict],
    max_samples: int,
    top_k: int = 5,
    verbose: bool = False,
) -> dict:
    """
    Run the RUMBA evaluation loop using UniversalMemoryService.

    Returns metrics dict with RecallAccuracy@5 and AnswerQuality.
    """
    recall_scores: list[float] = []
    quality_scores: list[float] = []
    errors: list[dict] = []

    samples = dataset[:max_samples] if max_samples > 0 else dataset
    total_qa = sum(len(item.get("qa", [])) for item in samples)

    print(f"[eval] Running on {len(samples)} dialogues, {total_qa} QA pairs ...", flush=True)

    for idx, item in enumerate(samples):
        dialogue_id = item.get("dialogue_id", str(idx))
        user_id = f"user_{dialogue_id}"

        # ── ingest conversation turns ──────────────────────────────────────
        service.clear_user_collection(user_id)
        messages = _extract_messages(item)

        for uid, text, ts in messages:
            try:
                service.add_one(uid, text, ts)
            except Exception as exc:
                errors.append({"dialogue_id": dialogue_id, "phase": "add", "error": str(exc)})
                if verbose:
                    print(f"  [WARN] add_one failed: {exc}", file=sys.stderr)

        # ── evaluate QA pairs ──────────────────────────────────────────────
        for qa in item.get("qa", []):
            question = qa.get("question", "")
            answer = qa.get("answer", "")
            evidence = [
                e.get("content", "")
                for e in qa.get("evidence", [])
                if e.get("content")
            ]

            try:
                # Direct search for RecallAccuracy@5
                search_results = service._client.search(question, top_k=top_k)

                recall = _recall_at_k(evidence, search_results, k=top_k)
                quality = _answer_quality(answer, search_results)

                recall_scores.append(recall)
                quality_scores.append(quality)

                if verbose:
                    status = "PASS" if recall > 0 else "MISS"
                    print(f"  [{status}] Q={question[:60]!r} recall={recall:.1f} quality={quality:.1f}")

            except Exception as exc:
                errors.append({"dialogue_id": dialogue_id, "question": question, "error": str(exc)})
                if verbose:
                    print(f"  [ERROR] QA eval failed: {exc}", file=sys.stderr)
                recall_scores.append(0.0)
                quality_scores.append(0.0)

        if (idx + 1) % 5 == 0 or idx == len(samples) - 1:
            ra5 = sum(recall_scores) / len(recall_scores) if recall_scores else 0.0
            aq = sum(quality_scores) / len(quality_scores) if quality_scores else 0.0
            print(
                f"[eval] Dialogue {idx + 1}/{len(samples)} "
                f"RecallAccuracy@5={ra5:.4f} AnswerQuality={aq:.4f}",
                flush=True,
            )

    n = len(recall_scores)
    recall_accuracy_at_5 = sum(recall_scores) / n if n else 0.0
    answer_quality = sum(quality_scores) / n if n else 0.0

    return {
        "service": "universal-memory",
        "dataset": "RUMBA EN",
        "n_dialogues": len(samples),
        "n_qa_pairs": n,
        "RecallAccuracy@5": round(recall_accuracy_at_5, 6),
        "AnswerQuality": round(answer_quality, 6),
        "errors": len(errors),
        "error_rate": round(len(errors) / max(n, 1), 4),
        "note": (
            "RecallAccuracy@5: substring match between ground-truth evidence and top-5 search results. "
            "AnswerQuality: token overlap heuristic (not LLM judge). "
            "For full LLM-judge evaluation run research/RUMBA/evaluation/run_lighteval.py."
        ),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        description="RUMBA eval harness for universal-memory-hub",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--service", default="universal-memory",
        help="Service to evaluate (default: universal-memory)",
    )
    ap.add_argument(
        "--backend", default="local", choices=["local", "cloud"],
        help="Memory backend mode (default: local)",
    )
    ap.add_argument(
        "--data", default=str(_EVAL_DATA),
        help="Path to RUMBA dataset JSON",
    )
    ap.add_argument(
        "--max-samples", type=int, default=5,
        help="Number of dialogues to evaluate (0=all, default=5)",
    )
    ap.add_argument(
        "--top-k", type=int, default=5,
        help="Top-K for RecallAccuracy (default=5)",
    )
    ap.add_argument(
        "--data-dir", default=None,
        help="PGLite data dir (local mode, default: ~/.universal-memory/rumba-eval)",
    )
    ap.add_argument(
        "--output-dir", default=str(_RESULTS_DIR),
        help="Directory to write result JSONs",
    )
    ap.add_argument(
        "--verbose", action="store_true",
        help="Print per-QA results",
    )
    ap.add_argument(
        "--dry-run", action="store_true",
        help="Validate the dataset and the harness without running the backend",
    )
    args = ap.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── load baselines ───────────────────────────────────────────────────────
    baseline = _load_mem0_baseline()
    baselines_path = output_dir / "baselines.json"
    with open(baselines_path, "w") as f:
        json.dump({"mem0": baseline}, f, indent=2)
    print(f"[eval] Baseline written to {baselines_path}", flush=True)
    print(
        f"[eval] mem0 baseline — "
        f"RecallAccuracy@5={baseline['RecallAccuracy@5']:.4f}  "
        f"AnswerQuality={baseline['AnswerQuality']:.4f}",
        flush=True,
    )
    print(
        "[eval] CAVEAT: the mem0 baseline above is an LLM-judge score, while this "
        "harness computes a substring proxy for AnswerQuality. The comparison is "
        "indicative only and is NOT a gate. Deterministic Recall@k against the "
        "dataset's own evidence spans is comparable to itself and IS gate-usable "
        "(see work/embedding-bridge/decisions.md, D7).",
        flush=True,
    )

    # ── dry run: prove the dataset is reachable and parses, then stop ────────
    if args.dry_run:
        data_path = Path(args.data)
        if not data_path.exists():
            print(
                f"[ERROR] Dataset not found: {data_path}\n"
                f"        Run: git submodule update --init research/RUMBA",
                file=sys.stderr,
            )
            return 1
        with open(data_path) as f:
            data = json.load(f)
        n_qa = sum(len(item.get("qa", [])) for item in data)
        print(
            f"[eval] Dataset OK — {data_path.name}: "
            f"{len(data)} dialogues, {n_qa} QA pairs",
            flush=True,
        )
        return _dry_run_eval(baseline, output_dir)

    # ── check Bun availability ───────────────────────────────────────────────
    if not _check_bun():
        print(
            "[ERROR] 'bun' not found on PATH — cannot run the backend, so nothing "
            "can be measured.\n"
            "        Install Bun (https://bun.sh), or pass --dry-run to validate "
            "the harness only.",
            file=sys.stderr,
        )
        return 1

    # ── load dataset ─────────────────────────────────────────────────────────
    data_path = Path(args.data)
    if not data_path.exists():
        print(f"[ERROR] Dataset not found: {data_path}", file=sys.stderr)
        return 1

    with open(data_path) as f:
        dataset = json.load(f)
    print(f"[eval] Loaded {len(dataset)} dialogues from {data_path.name}", flush=True)

    # ── run evaluation ───────────────────────────────────────────────────────
    if args.service != "universal-memory":
        print(f"[ERROR] Unknown service: {args.service!r}. Only 'universal-memory' supported.", file=sys.stderr)
        return 1

    from adapters.universal_memory import UniversalMemoryService

    with UniversalMemoryService(data_dir=args.data_dir, top_k=args.top_k) as service:
        t0 = time.monotonic()
        results = run_eval(
            service=service,
            dataset=dataset,
            max_samples=args.max_samples,
            top_k=args.top_k,
            verbose=args.verbose,
        )
        elapsed = time.monotonic() - t0

    results["elapsed_seconds"] = round(elapsed, 2)
    results["backend"] = args.backend
    results["max_samples"] = args.max_samples
    results["evaluated_at"] = datetime.utcnow().isoformat() + "Z"

    # ── write results ─────────────────────────────────────────────────────────
    results_path = output_dir / "universal-memory.json"
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n[eval] Results written to {results_path}", flush=True)

    # ── print summary ─────────────────────────────────────────────────────────
    ra5 = results["RecallAccuracy@5"]
    aq = results["AnswerQuality"]
    mem0_ra5 = baseline["RecallAccuracy@5"]

    print(f"\n{'='*60}", flush=True)
    print(f"  RecallAccuracy@5 = {ra5:.4f}  (mem0 baseline: {mem0_ra5:.4f})", flush=True)
    print(f"  AnswerQuality    = {aq:.4f}  (threshold: 0.70)", flush=True)
    print(f"{'='*60}", flush=True)

    # ── assertions ────────────────────────────────────────────────────────────
    passed = True

    if ra5 >= mem0_ra5:
        print(f"  PASS  RecallAccuracy@5 {ra5:.4f} >= mem0 {mem0_ra5:.4f}", flush=True)
    else:
        print(f"  FAIL  RecallAccuracy@5 {ra5:.4f} < mem0 {mem0_ra5:.4f}", flush=True)
        passed = False

    if aq >= 0.70:
        print(f"  PASS  AnswerQuality {aq:.4f} >= 0.70", flush=True)
    else:
        print(f"  FAIL  AnswerQuality {aq:.4f} < 0.70", flush=True)
        passed = False

    if passed:
        print(f"\n  ALL ASSERTIONS PASSED", flush=True)
    else:
        print(f"\n  ASSERTION FAILURE — see output above", flush=True)

    print(flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())

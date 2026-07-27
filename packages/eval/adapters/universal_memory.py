"""
Universal Memory RUMBA adapter.

Wraps the memory-hub MCP server (local stdio mode) as a MemoryService,
conforming to research/RUMBA/services/interface.py.

  add_one()               → memory_capture MCP tool
  get_relevant_memories() → memory_search  MCP tool (top-5)
  clear_user_collection() → memory_delete  per-id (best-effort)

The adapter spawns a Bun subprocess running packages/memory-hub/src/mcp/server.ts
and communicates via JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

from jinja2 import Template

# RUMBA interface
_RUMBA_ROOT = Path(__file__).resolve().parents[3] / "research" / "RUMBA"
sys.path.insert(0, str(_RUMBA_ROOT))

from services.interface import MemoryService  # noqa: E402
from evaluation.prompts import ANSWER_PROMPT_EN, ANSWER_PROMPT_RU  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# MCP stdio transport — JSON-RPC 2.0 over Bun subprocess
# ─────────────────────────────────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SERVER_ENTRY = _REPO_ROOT / "packages" / "memory-hub" / "src" / "mcp" / "server.ts"

_INIT_TIMEOUT = 60   # seconds — PGLite cold start can take up to 20s
_CALL_TIMEOUT = 30   # seconds per tool call
_TOP_K = 5           # RecallAccuracy@5


class _McpStdioClient:
    """
    Minimal MCP JSON-RPC 2.0 stdio client.

    Opens a Bun subprocess, sends initialize, then allows tool calls.
    Thread-safe: each call acquires the lock around write + read.
    """

    def __init__(self, data_dir: str, env: Optional[dict] = None):
        self._lock = threading.Lock()
        self._pending: dict[str | int, dict] = {}
        self._id_counter = 0
        self._data_dir = data_dir

        bun_env = {**os.environ, "MEMORY_BACKEND": "local", "MEMORY_DATA_DIR": data_dir}
        if env:
            bun_env.update(env)
        # BM25-only mode when no LLM key available
        if not any(bun_env.get(k) for k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY")):
            bun_env.setdefault("MEMORY_BACKEND", "local")

        self._proc = subprocess.Popen(
            ["bun", "run", str(_SERVER_ENTRY)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=bun_env,
            cwd=str(_REPO_ROOT),
        )

        # stderr reader thread — prevents pipe buffer blocking
        self._stderr_lines: list[str] = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

        self._initialize()

    # ── internal ──────────────────────────────────────────────────────────────

    def _drain_stderr(self) -> None:
        assert self._proc.stderr
        for line in self._proc.stderr:
            decoded = line.decode("utf-8", errors="replace").rstrip()
            self._stderr_lines.append(decoded)

    def _next_id(self) -> int:
        self._id_counter += 1
        return self._id_counter

    def _send(self, msg: dict) -> None:
        assert self._proc.stdin
        payload = (json.dumps(msg) + "\n").encode("utf-8")
        self._proc.stdin.write(payload)
        self._proc.stdin.flush()

    def _recv_line(self, timeout: float) -> dict:
        """Read one JSON line from stdout with timeout."""
        assert self._proc.stdout
        deadline = time.monotonic() + timeout
        buf = b""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"MCP response timeout after {timeout}s. stderr tail: {self._stderr_lines[-5:]}")
            # non-blocking read attempt with small sleep
            import select
            ready, _, _ = select.select([self._proc.stdout], [], [], min(remaining, 0.5))
            if ready:
                byte = self._proc.stdout.read(1)
                if not byte:
                    raise EOFError(f"MCP server stdout closed. stderr tail: {self._stderr_lines[-10:]}")
                if byte == b"\n":
                    if buf.strip():
                        return json.loads(buf.decode("utf-8"))
                    buf = b""  # skip blank lines
                else:
                    buf += byte
            # check process still alive
            if self._proc.poll() is not None:
                raise RuntimeError(
                    f"MCP server exited with code {self._proc.returncode}. "
                    f"stderr: {chr(10).join(self._stderr_lines[-20:])}"
                )

    def _request(self, method: str, params: dict, timeout: float = _CALL_TIMEOUT) -> Any:
        """Send a JSON-RPC 2.0 request and return the result."""
        with self._lock:
            req_id = self._next_id()
            self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
            # drain until we get our response (may receive notifications in between)
            while True:
                msg = self._recv_line(timeout)
                if msg.get("id") == req_id:
                    if "error" in msg:
                        raise RuntimeError(f"MCP error: {msg['error']}")
                    return msg.get("result")
                # notification or unmatched response — ignore

    def _notify(self, method: str, params: dict) -> None:
        """Send a JSON-RPC notification (no response expected)."""
        with self._lock:
            self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _initialize(self) -> None:
        result = self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "rumba-eval", "version": "1.0.0"},
            },
            timeout=_INIT_TIMEOUT,
        )
        # send initialized notification (MCP handshake)
        self._notify("notifications/initialized", {})
        _ = result  # server capabilities — not needed for eval

    # ── public API ────────────────────────────────────────────────────────────

    def call_tool(self, name: str, arguments: dict) -> Any:
        """Call an MCP tool and return parsed content."""
        result = self._request(
            "tools/call",
            {"name": name, "arguments": arguments},
        )
        # MCP result: { content: [{ type: "text", text: "..." }], isError?: bool }
        if not result:
            return {}
        content = result.get("content", [])
        if not content:
            return {}
        text = content[0].get("text", "") if isinstance(content, list) else ""
        if text:
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return {"raw": text}
        return {}

    def capture(self, content: str, source: Optional[str] = None, tags: Optional[list] = None) -> dict:
        args: dict[str, Any] = {"content": content}
        if source:
            args["source"] = source
        if tags:
            args["tags"] = tags
        return self.call_tool("memory_capture", args)

    def search(self, query: str, top_k: int = _TOP_K) -> list:
        result = self.call_tool("memory_search", {"query": query, "top_k": top_k})
        if isinstance(result, list):
            return result
        # unwrap if wrapped: { results: [...] }
        if isinstance(result, dict) and "results" in result:
            return result["results"]
        return []

    def delete(self, memory_id: str) -> None:
        try:
            self.call_tool("memory_delete", {"id": memory_id})
        except Exception:
            pass  # best-effort

    def list_all(self, limit: int = 200) -> list:
        result = self.call_tool("memory_list", {"limit": limit})
        if isinstance(result, list):
            return result
        return []

    def close(self) -> None:
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
            self._proc.terminate()
            self._proc.wait(timeout=5)
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# MemoryService implementation
# ─────────────────────────────────────────────────────────────────────────────

class UniversalMemoryService(MemoryService):
    """
    RUMBA MemoryService wrapping memory-hub MCP (local stdio backend).

    One MCP subprocess per evaluation run (shared across users). Memory
    isolation between users is approximated by tagging each entry with
    `user_id` and filtering search results to the same tag. This mirrors
    how mem0 and other services scope memories by user_id.

    In BM25-only mode (no LLM key) only keyword search is available —
    RecallAccuracy@5 is measured over BM25 scores.
    """

    is_async: bool = False

    def __init__(self, data_dir: Optional[str] = None, top_k: int = _TOP_K):
        self.top_k = top_k
        self._data_dir = data_dir or str(Path.home() / ".universal-memory" / "rumba-eval")
        os.makedirs(self._data_dir, exist_ok=True)
        print(f"[universal-memory] Starting MCP server (data_dir={self._data_dir})", file=sys.stderr)
        self._client = _McpStdioClient(data_dir=self._data_dir)
        print("[universal-memory] MCP server ready.", file=sys.stderr)
        # track captured ids per user for clear_user_collection
        self._user_ids: dict[str, list[str]] = {}

    # ── MemoryService interface ───────────────────────────────────────────────

    def clear_user_collection(self, user_id: str) -> None:
        """
        Delete all memories tagged with user_id (best-effort).
        Called before ingestion to ensure clean state per user.
        """
        ids = self._user_ids.pop(user_id, [])
        for mid in ids:
            self._client.delete(mid)

    def add_one(self, user_id: str, payload: Any, timestamp: str) -> dict:
        """
        Ingest one memory turn into memory-hub via memory_capture.

        payload may be:
          - str  — "User: <text>" from conversation_to_payload
          - list — [{"role": ..., "content": ...}] from conversation_to_pairs
        """
        if isinstance(payload, list):
            # conversation pair → flat text
            content = "\n".join(
                f"{msg['role']}: {msg['content']}"
                for msg in payload
                if msg.get("content", "").strip()
            )
        else:
            content = str(payload)

        if not content.strip():
            return {"status": "skipped"}

        result = self._client.capture(
            content=content,
            source="rumba-eval",
            tags=[user_id, "rumba"],
        )
        # track id for cleanup
        if isinstance(result, dict) and "id" in result:
            self._user_ids.setdefault(user_id, []).append(result["id"])

        return {"status": "success"}

    def get_relevant_memories(
        self,
        user_id: str,
        message: str,
        query_date: datetime,
        lan: str,
    ) -> str:
        """
        Search memory-hub for relevant memories and return a filled prompt template.

        Calls memory_search with top_k=5 (RecallAccuracy@5 metric).
        Formats memories with timestamp and content for the ANSWER_PROMPT template.
        """
        results = self._client.search(message, top_k=self.top_k)

        # Filter to this user's memories where possible (tag-based)
        user_results = [
            r for r in results
            if user_id in (r.get("tags") or [])
        ]
        # If tag filtering removed everything, fall back to unfiltered results
        # (can happen in BM25-only mode where tags are not indexed for filtering)
        if not user_results:
            user_results = results

        # Format memories for the prompt template
        formatted_memories = []
        for r in user_results[:self.top_k]:
            content = r.get("content", "")
            score = r.get("score", 0)
            source_ts = r.get("source", "")
            # Use source field as timestamp if available, else placeholder
            ts_str = source_ts if source_ts and source_ts != "rumba-eval" else "unknown"
            formatted_memories.append(f"{ts_str} (score={score:.3f}): {content}")

        prompt = ANSWER_PROMPT_RU if lan == "ru" else ANSWER_PROMPT_EN
        template = Template(prompt)
        return template.render(
            memories=formatted_memories,
            question=message,
            query_date=query_date,
            query_weekday=query_date.strftime("%A") if query_date else "",
        )

    def close(self) -> None:
        """Shut down the MCP subprocess."""
        self._client.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

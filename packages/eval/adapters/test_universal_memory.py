"""
Unit tests for packages/eval/adapters/universal_memory.py

Tests cover:
- UniversalMemoryService interface conformance (MemoryService ABC)
- add_one() payload handling (str and list variants)
- get_relevant_memories() prompt template output
- _McpStdioClient.call_tool() JSON parsing
- RecallAccuracy@5 and AnswerQuality helpers in run.py

All MCP I/O is mocked — no Bun process is spawned.
"""
from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch, PropertyMock

# path setup
_EVAL_DIR = Path(__file__).resolve().parent.parent
_RUMBA_ROOT = _EVAL_DIR.parents[1] / "research" / "RUMBA"
sys.path.insert(0, str(_RUMBA_ROOT))
sys.path.insert(0, str(_EVAL_DIR))

from adapters.universal_memory import UniversalMemoryService, _McpStdioClient  # noqa: E402


def _make_service(mock_client: MagicMock) -> UniversalMemoryService:
    """Build a UniversalMemoryService with a mocked _McpStdioClient."""
    with patch.object(UniversalMemoryService, "__init__", lambda self, **kw: None):
        svc = UniversalMemoryService.__new__(UniversalMemoryService)
        svc._client = mock_client
        svc._user_ids = {}
        svc.top_k = 5
        return svc


class TestAddOne(unittest.TestCase):
    def test_string_payload_calls_capture(self):
        client = MagicMock()
        client.capture.return_value = {"id": "mem-1", "chunks": 2}
        svc = _make_service(client)

        result = svc.add_one("user_0", "Alice: I love hiking.", "2022-05-20T20:09:18Z")

        client.capture.assert_called_once()
        call_args = client.capture.call_args
        assert "I love hiking" in call_args.kwargs.get("content", call_args.args[0] if call_args.args else "")
        assert result == {"status": "success"}

    def test_list_payload_flattened(self):
        client = MagicMock()
        client.capture.return_value = {"id": "mem-2", "chunks": 1}
        svc = _make_service(client)

        payload = [
            {"role": "user", "content": "I went skiing today."},
            {"role": "assistant", "content": "That sounds fun!"},
        ]
        svc.add_one("user_0", payload, "2022-05-21T20:09:18Z")

        client.capture.assert_called_once()
        content_arg = client.capture.call_args.kwargs.get("content", "")
        assert "skiing" in content_arg

    def test_empty_content_skipped(self):
        client = MagicMock()
        svc = _make_service(client)

        result = svc.add_one("user_0", "   ", "2022-05-20T20:09:18Z")

        client.capture.assert_not_called()
        assert result["status"] == "skipped"

    def test_id_tracked_for_cleanup(self):
        client = MagicMock()
        client.capture.return_value = {"id": "mem-42", "chunks": 1}
        svc = _make_service(client)

        svc.add_one("user_5", "Some memory text.", "2022-05-20T20:09:18Z")

        assert "user_5" in svc._user_ids
        assert "mem-42" in svc._user_ids["user_5"]

    def test_tags_include_user_id(self):
        client = MagicMock()
        client.capture.return_value = {"id": "x", "chunks": 1}
        svc = _make_service(client)

        svc.add_one("user_7", "Memory content.", "")

        call_kw = client.capture.call_args.kwargs
        assert "user_7" in call_kw.get("tags", [])


class TestClearUserCollection(unittest.TestCase):
    def test_deletes_tracked_ids(self):
        client = MagicMock()
        svc = _make_service(client)
        svc._user_ids["user_3"] = ["id-1", "id-2"]

        svc.clear_user_collection("user_3")

        assert client.delete.call_count == 2
        assert "user_3" not in svc._user_ids

    def test_unknown_user_noop(self):
        client = MagicMock()
        svc = _make_service(client)

        # Should not raise
        svc.clear_user_collection("user_unknown")
        client.delete.assert_not_called()


class TestGetRelevantMemories(unittest.TestCase):
    def _mock_results(self, user_id: str = "user_0") -> list[dict]:
        return [
            {"id": "m1", "content": "Alice loves hiking in the mountains.", "score": 0.9, "tags": [user_id, "rumba"]},
            {"id": "m2", "content": "Alice works as a librarian.", "score": 0.7, "tags": [user_id, "rumba"]},
        ]

    def test_returns_string(self):
        client = MagicMock()
        client.search.return_value = self._mock_results()
        svc = _make_service(client)

        result = svc.get_relevant_memories(
            "user_0", "What does Alice do for work?", datetime(2022, 7, 11), "en"
        )

        assert isinstance(result, str)
        assert "librarian" in result

    def test_prompt_contains_question(self):
        client = MagicMock()
        client.search.return_value = self._mock_results()
        svc = _make_service(client)

        result = svc.get_relevant_memories(
            "user_0", "Where does Alice like to hike?", datetime(2022, 7, 11), "en"
        )

        assert "Where does Alice like to hike?" in result

    def test_filters_by_user_id_tag(self):
        client = MagicMock()
        # Two users' results mixed
        client.search.return_value = [
            {"id": "m1", "content": "Alice memory.", "score": 0.9, "tags": ["user_0", "rumba"]},
            {"id": "m2", "content": "Bob memory.", "score": 0.8, "tags": ["user_1", "rumba"]},
        ]
        svc = _make_service(client)

        result = svc.get_relevant_memories("user_0", "question", datetime(2022, 7, 11), "en")

        # Bob's memory should not appear in user_0's context
        assert "Bob memory" not in result
        assert "Alice memory" in result

    def test_fallback_when_no_tag_match(self):
        """If tag filtering removes all results, fall back to unfiltered."""
        client = MagicMock()
        client.search.return_value = [
            {"id": "m1", "content": "Generic memory.", "score": 0.9, "tags": []},
        ]
        svc = _make_service(client)

        result = svc.get_relevant_memories("user_0", "question", datetime(2022, 7, 11), "en")

        assert "Generic memory" in result

    def test_ru_prompt_used_for_ru_language(self):
        client = MagicMock()
        client.search.return_value = self._mock_results()
        svc = _make_service(client)

        result = svc.get_relevant_memories("user_0", "Вопрос", datetime(2022, 7, 11), "ru")

        # Russian prompt contains Russian keywords
        assert "КОНТЕКСТ" in result or "воспоминани" in result.lower()


class TestMcpClientToolParsing(unittest.TestCase):
    """Unit-test _McpStdioClient.call_tool() response parsing without spawning Bun."""

    def _client_with_mock_request(self, response_result: Any) -> _McpStdioClient:
        with patch.object(_McpStdioClient, "__init__", lambda self, **kw: None):
            client = _McpStdioClient.__new__(_McpStdioClient)
        client._request = MagicMock(return_value=response_result)
        client._lock = __import__("threading").Lock()
        return client

    def test_text_content_parsed_as_json(self):
        payload = [{"id": "m1", "content": "some text", "score": 0.9}]
        mock_result = {"content": [{"type": "text", "text": json.dumps(payload)}]}
        client = self._client_with_mock_request(mock_result)

        result = client.call_tool("memory_search", {"query": "test"})

        assert result == payload

    def test_empty_content_returns_empty_dict(self):
        client = self._client_with_mock_request({"content": []})

        result = client.call_tool("memory_search", {"query": "test"})

        assert result == {}

    def test_none_result_returns_empty_dict(self):
        client = self._client_with_mock_request(None)

        result = client.call_tool("memory_capture", {"content": "test"})

        assert result == {}

    def test_search_unwraps_results_key(self):
        """If MCP server wraps results in { results: [...] } shape."""
        inner = [{"id": "m1", "content": "text"}]
        mock_result = {"content": [{"type": "text", "text": json.dumps({"results": inner})}]}
        client = self._client_with_mock_request(mock_result)

        result = client.search("query")

        assert result == inner


class TestMetricsHelpers(unittest.TestCase):
    """Test RecallAccuracy@5 and AnswerQuality helpers from run.py."""

    def setUp(self):
        # Import helpers from run.py
        import importlib.util, os
        run_path = Path(__file__).resolve().parents[1] / "run.py"
        spec = importlib.util.spec_from_file_location("run", run_path)
        self.run = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.run)

    def test_recall_exact_match(self):
        evidence = ["Alice loves hiking in the mountains every weekend."]
        results = [
            {"content": "Alice loves hiking in the mountains every weekend."},
        ]
        score = self.run._recall_at_k(evidence, results, k=5)
        assert score == 1.0

    def test_recall_partial_phrase_match(self):
        evidence = ["Alice loves hiking in the mountains"]
        results = [
            {"content": "Alice loves hiking in the mountains near her village."},
        ]
        score = self.run._recall_at_k(evidence, results, k=5)
        assert score == 1.0

    def test_recall_miss(self):
        evidence = ["Bob works as an accountant."]
        results = [
            {"content": "Alice is a librarian at the central library."},
        ]
        score = self.run._recall_at_k(evidence, results, k=5)
        assert score == 0.0

    def test_recall_only_checks_top_k(self):
        evidence = ["Bob is a chef."]
        # evidence is at position k+1, should not be counted
        results = [
            {"content": "unrelated content one"},
            {"content": "unrelated content two"},
            {"content": "unrelated content three"},
            {"content": "unrelated content four"},
            {"content": "unrelated content five"},
            {"content": "Bob is a chef and cooks Italian food."},  # position 6, out of top-5
        ]
        score = self.run._recall_at_k(evidence, results, k=5)
        assert score == 0.0

    def test_answer_quality_high_token_overlap(self):
        answer = "Cappuccino"
        results = [{"content": "She always orders cappuccino at the coffee shop."}]
        score = self.run._answer_quality(answer, results)
        assert score >= 0.5

    def test_answer_quality_abstention(self):
        answer = "No such information."
        score = self.run._answer_quality(answer, [])
        assert score == 1.0

    def test_answer_quality_no_match(self):
        answer = "skiing"
        results = [{"content": "Alice likes hiking and swimming."}]
        score = self.run._answer_quality(answer, results)
        assert score == 0.0

    def test_parse_date_iso(self):
        dt = self.run._parse_date("2022-07-11T20:09:18Z")
        assert dt.year == 2022
        assert dt.month == 7

    def test_parse_date_none(self):
        assert self.run._parse_date(None) is None


# ── type alias for Any to avoid import in test file ──────────────────────────
Any = object

if __name__ == "__main__":
    unittest.main()

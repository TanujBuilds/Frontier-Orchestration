"""Offline search transport and structural gate tests; no public network access."""
import importlib.util
import json
import pathlib
import sys
import threading
import time
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / ".agents/skills/deep-research/scripts"
sys.path.insert(0, str(SCRIPTS))


def load_component(case, name):
    path = SCRIPTS / (name + ".py")
    case.assertTrue(path.is_file(), f"{name} is not implemented")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        self.server.requests.append(parse_qs(self.rfile.read(size).decode()))
        status, body, headers, delay = self.server.responses.pop(0)
        if delay:
            time.sleep(delay)
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.search = load_component(self, "research_search")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.requests = []
        self.server.responses = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}/search"

    def tearDown(self):
        if hasattr(self, "server"):
            self.server.shutdown()
            self.server.server_close()
            self.thread.join()

    def reply(self, data, status=200, headers=None, delay=0):
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.server.responses.append((status, body, headers or {"Content-Type": "application/json"}, delay))

    def client(self, **kwargs):
        return self.search.SearxSearch(base_url=self.base, min_interval=0, **kwargs)

    def test_actual_transport_uses_fixed_engines_and_preserves_upstream_errors(self):
        self.reply({"results": [{"url": "https://docs.python.org/3/library/sqlite3.html",
                                "title": "SQLite", "content": "Transactions", "engines": ["duckduckgo"]}],
                    "unresponsive_engines": [["brave", "CAPTCHA"]]})
        result = self.client().search("Python sqlite3 transactions")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["results"][0]["engines"], ["duckduckgo"])
        self.assertEqual(result["unresponsive_engines"], [["brave", "CAPTCHA"]])
        self.assertEqual(self.server.requests[0]["engines"], ["duckduckgo,brave"])
        self.assertEqual(self.server.requests[0]["format"], ["json"])
        self.assertEqual(result["query"], "Python sqlite3 transactions")
        self.assertTrue(result["fetched_at"].endswith("Z"))
        self.assertGreaterEqual(result["elapsed"], 0)

    def test_no_usable_results_is_explicit_and_strings_are_bounded(self):
        self.reply({"results": [
            {"url": "file:///etc/passwd", "title": "secret"},
            {"url": "https://user:pass@example.com/", "title": "credential"},
            {"url": "https://127.0.0.1/", "title": "loopback"},
            {"url": "https://example.com/a\nb", "title": "control"},
            {"url": "http://example.com/", "title": "plain"}]})
        result = self.client().search("test")
        self.assertEqual(result["status"], "empty")
        self.assertEqual(result["results"], [])
        self.assertEqual(result["error"]["code"], "no_usable_results")

    def test_result_lengths_and_count_are_limited(self):
        self.reply({"results": [{"url": f"https://example.com/{i}",
                    "title": "t" * 2000, "content": "c" * 20000,
                    "engines": ["duckduckgo", "unexpected"]} for i in range(40)]})
        result = self.client().search("test")
        self.assertEqual(len(result["results"]), 20)
        self.assertEqual(len(result["results"][0]["title"]), 500)
        self.assertEqual(len(result["results"][0]["content"]), 8000)
        self.assertEqual(result["results"][0]["engines"], ["duckduckgo"])

    def test_invalid_json_and_429_are_not_retried(self):
        self.reply(b"{broken")
        result = self.client().search("first")
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_json")
        self.reply({"error": "slow down"}, 429, {"Retry-After": "60"})
        result = self.client().search("second")
        self.assertEqual(result["error"]["code"], "http_error")
        self.assertEqual(result["error"]["http_status"], 429)
        self.assertEqual(result["error"]["retry_after"], "60")
        self.assertEqual(len(self.server.requests), 2)

    def test_redirect_is_not_followed(self):
        self.reply(b"", 302, {"Location": self.base})
        result = self.client().search("test")
        self.assertEqual(result["error"]["http_status"], 302)
        self.assertEqual(len(self.server.requests), 1)

    def test_oversized_response_is_rejected_before_json_parsing(self):
        self.reply(b" " * (2 * 1024 * 1024 + 1))
        result = self.client().search("test")
        self.assertEqual(result["error"]["code"], "response_too_large")

    def test_scalar_and_malformed_result_schema_are_clear_failures(self):
        for obj in ([], {"results": "bad"}, {"results": [], "unresponsive_engines": "bad"}):
            self.reply(obj)
            result = self.client().search("test")
            self.assertEqual(result["error"]["code"], "invalid_schema")

    def test_config_and_queries_cannot_expand_authorized_network_or_engine_scope(self):
        for url in ("https://example.com/search", "http://localhost/search",
                    "http://127.0.0.1/search?x=1", "http://user@127.0.0.1/search",
                    "http://127.0.0.1/other", "http://0.0.0.0/search"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.search.SearxSearch(base_url=url)
        for engines in (("google",), ("duckduckgo", "braveapi"), (), ("duckduckgo", "duckduckgo")):
            with self.subTest(engines=engines), self.assertRaises(ValueError):
                self.client(engines=engines)
        for query in ("", " " * 4, "x" * 1001, "!google test", "test\nother", 7):
            with self.subTest(query=str(query)[:30]), self.assertRaises(ValueError):
                self.client().search(query)
        self.assertEqual(len(self.server.requests), 0)

    def test_total_timeout_is_bounded_and_minimum_spacing_is_applied(self):
        self.reply({"results": []}, delay=0.15)
        started = time.monotonic()
        result = self.client(timeout=0.04).search("slow")
        self.assertEqual(result["error"]["code"], "transport_error")
        self.assertLess(time.monotonic() - started, 0.3)
        self.reply({"results": []})
        self.reply({"results": []})
        client = self.search.SearxSearch(base_url=self.base, min_interval=0.06)
        client.search("one")
        start = time.monotonic()
        client.search("two")
        self.assertGreaterEqual(time.monotonic() - start, 0.045)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.gate = load_component(self, "research_gate")

    def passing_record(self, when="2026-10-28T01:00:00Z"):
        rows = []
        for case in self.gate.QUERIES:
            rows.append({"id": case["id"], "query": case["query"],
                         "expected_domains": case["expected_domains"],
                         "search": {"status": "ok", "query": case["query"], "fetched_at": when,
                                    "elapsed": 0.1, "unresponsive_engines": [],
                                    "results": [
                                        {"url": "https://" + case["expected_domains"][0] + "/test",
                                         "title": case["query"], "content": "primary source",
                                         "engines": ["duckduckgo"]},
                                        {"url": "https://independent.example/a", "title": "second", "content": "two",
                                         "engines": ["brave"]},
                                        {"url": "https://other.example/b", "title": "third", "content": "three",
                                         "engines": ["duckduckgo"]}]}})
        return {"schema_version": 1, "kind": "searxng_gate_pass",
                "captured_at": when, "live_gate_status": "pending",
                "human_relevance": "not_reviewed", "queries": rows}

    def test_corpus_is_ten_fixed_ai_infra_queries(self):
        self.assertEqual(len(self.gate.QUERIES), 10)
        self.assertEqual(len({q["id"] for q in self.gate.QUERIES}), 10)
        self.assertTrue(all(q["expected_domains"] for q in self.gate.QUERIES))

    def test_structural_comparison_does_not_certify_human_relevance(self):
        first = self.passing_record()
        second = self.passing_record("2026-10-28T01:30:00Z")
        result = self.gate.compare_passes(first, second)
        self.assertTrue(result["structural_pass"])
        self.assertFalse(result["live_gate_pass"])
        self.assertEqual(result["live_gate_status"], "pending")
        self.assertEqual(result["human_relevance"], "not_reviewed")
        self.assertEqual(result["passes"][0]["qualified_queries"], 10)
        self.assertEqual(len(result["reader_urls"]), 10)

    def test_spacing_and_eight_query_threshold_are_enforced(self):
        first = self.passing_record()
        early = self.passing_record("2026-10-28T01:29:59Z")
        self.assertFalse(self.gate.compare_passes(first, early)["structural_pass"])
        second = self.passing_record("2026-10-28T01:30:00Z")
        for row in second["queries"][:3]:
            row["search"]["results"] = row["search"]["results"][:2]
        self.assertFalse(self.gate.compare_passes(first, second)["structural_pass"])

    def test_duplicate_missing_corpus_and_primary_outside_first_five_do_not_pass(self):
        record = self.passing_record()
        record["queries"][-1] = record["queries"][0]
        self.assertFalse(self.gate.assess_pass(record)["structural_pass"])
        record = self.passing_record()
        for row in record["queries"][:3]:
            primary = row["search"]["results"].pop(0)
            row["search"]["results"] = [
                {"url": f"https://other{i}.example/a", "engines": ["brave"]} for i in range(5)] + [primary]
        self.assertFalse(self.gate.assess_pass(record)["structural_pass"])

    def test_capture_uses_exact_corpus_and_provides_reader_source_urls(self):
        calls = []
        class FixtureSearch:
            def search(inner, query):
                calls.append(query)
                return {"query": query, "status": "empty", "results": [],
                        "fetched_at": "2026-10-28T01:00:00Z", "elapsed": 0,
                        "unresponsive_engines": []}
        record = self.gate.capture_pass(FixtureSearch())
        self.assertEqual(calls, [q["query"] for q in self.gate.QUERIES])
        self.assertEqual(record["live_gate_status"], "pending")
        self.assertEqual(record["human_relevance"], "not_reviewed")
        self.assertFalse(self.gate.assess_pass(record)["structural_pass"])


if __name__ == "__main__":
    unittest.main()

"""Unit tests for signal_rules — 16 error pattern matchers + fallback + task/capability/tags.

Ported from the TypeScript SDK signal-rules tests.
"""

import pytest

from prismer.signal_rules import extract_signals


# ===========================================================================
# Error pattern matching — 16 known patterns
# ===========================================================================

class TestErrorPatterns:
    """Each of the 16 regex patterns should produce the correct error:* type."""

    def test_timeout(self):
        signals = extract_signals(error="request timed out")
        assert len(signals) == 1
        assert signals[0]["type"] == "error:timeout"

    def test_timeout_deadline_exceeded(self):
        signals = extract_signals(error="context deadline exceeded")
        assert signals[0]["type"] == "error:timeout"

    def test_connection_refused(self):
        signals = extract_signals(error="ECONNREFUSED 127.0.0.1:3000")
        assert signals[0]["type"] == "error:connection_refused"

    def test_connection_refused_text(self):
        signals = extract_signals(error="connection refused by server")
        assert signals[0]["type"] == "error:connection_refused"

    def test_dns_error(self):
        signals = extract_signals(error="getaddrinfo ENOTFOUND api.example.com")
        assert signals[0]["type"] == "error:dns_error"

    def test_dns_resolve(self):
        signals = extract_signals(error="could not resolve host")
        assert signals[0]["type"] == "error:dns_error"

    def test_rate_limit(self):
        signals = extract_signals(error="rate limit exceeded, retry after 60s")
        assert signals[0]["type"] == "error:rate_limit"

    def test_rate_limit_429(self):
        signals = extract_signals(error="HTTP 429 Too Many Requests")
        assert signals[0]["type"] == "error:rate_limit"

    def test_auth_error_401(self):
        signals = extract_signals(error="401 Unauthorized")
        assert signals[0]["type"] == "error:auth_error"

    def test_auth_error_text(self):
        signals = extract_signals(error="authentication failed for user")
        assert signals[0]["type"] == "error:auth_error"

    def test_permission_error_403(self):
        signals = extract_signals(error="403 Forbidden")
        assert signals[0]["type"] == "error:permission_error"

    def test_permission_error_access_denied(self):
        signals = extract_signals(error="access denied to resource")
        assert signals[0]["type"] == "error:permission_error"

    def test_not_found_404(self):
        signals = extract_signals(error="404 page not found")
        assert signals[0]["type"] == "error:not_found"

    def test_not_found_text(self):
        signals = extract_signals(error="resource not found")
        assert signals[0]["type"] == "error:not_found"

    def test_server_error_500(self):
        signals = extract_signals(error="500 Internal Server Error")
        assert signals[0]["type"] == "error:server_error"

    def test_server_error_502(self):
        signals = extract_signals(error="502 Bad Gateway")
        assert signals[0]["type"] == "error:server_error"

    def test_server_error_503(self):
        signals = extract_signals(error="503 Service Unavailable")
        assert signals[0]["type"] == "error:server_error"

    def test_server_error_504(self):
        signals = extract_signals(error="504 Gateway Timeout")
        # Note: "504" matches server_error pattern because of 5\d{2}
        # But "timeout" in the string could match timeout first.
        # Actually the patterns are checked in order, so "timeout" is first.
        # "504 Gateway Timeout" contains "timeout" so it matches timeout first.
        assert signals[0]["type"] == "error:timeout"

    def test_server_error_text(self):
        signals = extract_signals(error="internal server error occurred")
        assert signals[0]["type"] == "error:server_error"

    def test_type_error(self):
        signals = extract_signals(error="TypeError: undefined is not a function")
        assert signals[0]["type"] == "error:type_error"

    def test_syntax_error(self):
        signals = extract_signals(error="SyntaxError: unexpected token '}'")
        assert signals[0]["type"] == "error:syntax_error"

    def test_syntax_error_unexpected_token(self):
        signals = extract_signals(error="unexpected token in JSON at position 0")
        assert signals[0]["type"] == "error:syntax_error"

    def test_reference_error(self):
        signals = extract_signals(error="ReferenceError: foo is not defined")
        assert signals[0]["type"] == "error:reference_error"

    def test_reference_error_not_defined(self):
        signals = extract_signals(error="myVar is not defined")
        assert signals[0]["type"] == "error:reference_error"

    def test_oom(self):
        signals = extract_signals(error="JavaScript heap out of memory")
        assert signals[0]["type"] == "error:oom"

    def test_oom_allocation_failed(self):
        signals = extract_signals(error="allocation failed - out of memory")
        assert signals[0]["type"] == "error:oom"

    def test_crash(self):
        signals = extract_signals(error="process crashed with SIGSEGV")
        assert signals[0]["type"] == "error:crash"

    def test_crash_panic(self):
        signals = extract_signals(error="panic: runtime error: index out of range")
        assert signals[0]["type"] == "error:crash"

    def test_quota_exceeded(self):
        signals = extract_signals(error="quota exceeded for project")
        assert signals[0]["type"] == "error:quota_exceeded"

    def test_quota_limit_exceeded(self):
        signals = extract_signals(error="limit exceeded: max 1000 requests per hour")
        assert signals[0]["type"] == "error:quota_exceeded"

    def test_quota_insufficient(self):
        signals = extract_signals(error="insufficient credits remaining")
        assert signals[0]["type"] == "error:quota_exceeded"

    def test_tls_error(self):
        signals = extract_signals(error="SSL certificate verify failed")
        assert signals[0]["type"] == "error:tls_error"

    def test_tls_certificate(self):
        signals = extract_signals(error="certificate has expired")
        assert signals[0]["type"] == "error:tls_error"

    def test_deadlock(self):
        signals = extract_signals(error="deadlock detected in transaction")
        assert signals[0]["type"] == "error:deadlock"

    def test_deadlock_lock_wait(self):
        signals = extract_signals(error="lock wait exceeded; try restarting deadlock victim")
        assert signals[0]["type"] == "error:deadlock"


# ===========================================================================
# Fallback (unrecognized error)
# ===========================================================================

class TestFallback:
    def test_unrecognized_error_normalizes(self):
        signals = extract_signals(error="Some weird ~error~ message!")
        assert len(signals) == 1
        assert signals[0]["type"].startswith("error:")
        # The normalized type should only contain [a-z0-9_]
        error_suffix = signals[0]["type"][len("error:"):]
        assert all(c in "abcdefghijklmnopqrstuvwxyz0123456789_" for c in error_suffix)

    def test_fallback_truncates_to_50_chars(self):
        long_error = "x" * 200
        signals = extract_signals(error=long_error)
        error_suffix = signals[0]["type"][len("error:"):]
        assert len(error_suffix) <= 50

    def test_no_error_returns_empty(self):
        signals = extract_signals()
        assert signals == []


# ===========================================================================
# Provider / stage / severity enrichment
# ===========================================================================

class TestEnrichment:
    def test_provider_attached_to_error_signal(self):
        signals = extract_signals(error="timeout", provider="openai")
        assert signals[0]["provider"] == "openai"

    def test_stage_attached_to_error_signal(self):
        signals = extract_signals(error="timeout", stage="inference")
        assert signals[0]["stage"] == "inference"

    def test_severity_attached_to_error_signal(self):
        signals = extract_signals(error="timeout", severity="critical")
        assert signals[0]["severity"] == "critical"

    def test_all_enrichment_fields(self):
        signals = extract_signals(
            error="connection refused",
            provider="aws",
            stage="deploy",
            severity="high",
        )
        sig = signals[0]
        assert sig["type"] == "error:connection_refused"
        assert sig["provider"] == "aws"
        assert sig["stage"] == "deploy"
        assert sig["severity"] == "high"

    def test_provider_on_fallback(self):
        signals = extract_signals(error="unknown error xyz", provider="gcp")
        assert signals[0]["provider"] == "gcp"

    def test_stage_on_fallback(self):
        signals = extract_signals(error="unknown error xyz", stage="build")
        assert signals[0]["stage"] == "build"

    def test_severity_not_on_fallback(self):
        # The fallback path does not attach severity (only provider and stage)
        signals = extract_signals(error="unknown error xyz", severity="low")
        assert "severity" not in signals[0]


# ===========================================================================
# Task status signals
# ===========================================================================

class TestTaskSignals:
    def test_task_failed(self):
        signals = extract_signals(task_status="failed")
        assert len(signals) == 1
        assert signals[0]["type"] == "task.failed"

    def test_task_completed(self):
        signals = extract_signals(task_status="completed")
        assert len(signals) == 1
        assert signals[0]["type"] == "task.completed"

    def test_task_unknown_status_ignored(self):
        signals = extract_signals(task_status="running")
        assert len(signals) == 0

    def test_task_none_status_ignored(self):
        signals = extract_signals(task_status=None)
        assert len(signals) == 0


# ===========================================================================
# Capability signals
# ===========================================================================

class TestCapability:
    def test_capability_signal(self):
        signals = extract_signals(task_capability="code_generation")
        assert len(signals) == 1
        assert signals[0]["type"] == "capability:code_generation"

    def test_capability_none_ignored(self):
        signals = extract_signals(task_capability=None)
        assert len(signals) == 0


# ===========================================================================
# Custom tags
# ===========================================================================

class TestCustomTags:
    def test_single_tag(self):
        signals = extract_signals(tags=["custom:my_tag"])
        assert len(signals) == 1
        assert signals[0]["type"] == "custom:my_tag"

    def test_multiple_tags(self):
        signals = extract_signals(tags=["lang:python", "tool:pytest"])
        assert len(signals) == 2
        assert signals[0]["type"] == "lang:python"
        assert signals[1]["type"] == "tool:pytest"

    def test_empty_tags_list(self):
        signals = extract_signals(tags=[])
        assert len(signals) == 0

    def test_tags_none_ignored(self):
        signals = extract_signals(tags=None)
        assert len(signals) == 0


# ===========================================================================
# Combined signals
# ===========================================================================

class TestCombined:
    def test_error_plus_task_plus_capability_plus_tags(self):
        signals = extract_signals(
            error="timeout occurred",
            task_status="failed",
            task_capability="web_search",
            tags=["env:prod"],
            provider="exa",
            stage="fetch",
        )
        types = [s["type"] for s in signals]
        assert "error:timeout" in types
        assert "task.failed" in types
        assert "capability:web_search" in types
        assert "env:prod" in types
        assert len(signals) == 4

        # Error signal should have provider and stage
        error_sig = next(s for s in signals if s["type"] == "error:timeout")
        assert error_sig["provider"] == "exa"
        assert error_sig["stage"] == "fetch"

    def test_only_first_error_pattern_matches(self):
        # "401 unauthorized" could match auth_error. Only one error signal emitted.
        signals = extract_signals(error="401 unauthorized access denied")
        error_signals = [s for s in signals if s["type"].startswith("error:")]
        assert len(error_signals) == 1
        # "401" matches auth_error first in pattern order
        assert error_signals[0]["type"] == "error:auth_error"

"""Signal Enrichment — SDK-side signal extraction using regex rules.

Ported from server's signal-extractor.ts. Zero dependencies, synchronous.
"""

import re
from typing import Dict, List, Optional

# Matches server-side signal-extractor.ts patterns
ERROR_PATTERNS = [
    (re.compile(r"timeout|timed?\s*out|deadline\s*exceeded|context\s*deadline", re.I), "timeout"),
    (re.compile(r"econnrefused|connection\s*refused", re.I), "connection_refused"),
    (re.compile(r"enotfound|dns|getaddrinfo|resolve", re.I), "dns_error"),
    (re.compile(r"rate\s*limit|too\s*many\s*requests|429", re.I), "rate_limit"),
    (re.compile(r"401|unauthorized|unauthenticated|auth.*fail", re.I), "auth_error"),
    (re.compile(r"403|forbidden|access\s*denied|permission", re.I), "permission_error"),
    (re.compile(r"404|not\s*found", re.I), "not_found"),
    (re.compile(r"5\d{2}|internal\s*server|server\s*error|502|503|504", re.I), "server_error"),
    (re.compile(r"type\s*error|typeerror", re.I), "type_error"),
    (re.compile(r"syntax\s*error|syntaxerror|unexpected\s*token", re.I), "syntax_error"),
    (re.compile(r"reference\s*error|referenceerror|is\s*not\s*defined", re.I), "reference_error"),
    (re.compile(r"out\s*of\s*memory|oom|heap|allocation\s*failed", re.I), "oom"),
    (re.compile(r"crash|panic|segfault|sigsegv|sigabrt", re.I), "crash"),
    (re.compile(r"quota|limit\s*exceeded|insufficient", re.I), "quota_exceeded"),
    (re.compile(r"tls|ssl|certificate|cert\s*verify", re.I), "tls_error"),
    (re.compile(r"deadlock|lock\s*timeout|lock\s*wait", re.I), "deadlock"),
]


def extract_signals(
    error: Optional[str] = None,
    task_status: Optional[str] = None,
    task_capability: Optional[str] = None,
    provider: Optional[str] = None,
    stage: Optional[str] = None,
    severity: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> List[Dict[str, str]]:
    """Extract structured SignalTag list from execution context.

    Returns list of dicts with {type, provider?, stage?, severity?}.
    Pure regex rules, zero deps, <0.1ms.
    """
    result: List[Dict[str, str]] = []

    # Error pattern matching
    if error:
        matched = False
        for pattern, error_type in ERROR_PATTERNS:
            if pattern.search(error):
                tag: Dict[str, str] = {"type": f"error:{error_type}"}
                if provider:
                    tag["provider"] = provider
                if stage:
                    tag["stage"] = stage
                if severity:
                    tag["severity"] = severity
                result.append(tag)
                matched = True
                break

        if not matched:
            normalized = re.sub(r"[^a-z0-9_]", "_", error[:50].lower())
            tag = {"type": f"error:{normalized}"}
            if provider:
                tag["provider"] = provider
            if stage:
                tag["stage"] = stage
            result.append(tag)

    # Task status
    if task_status == "failed":
        result.append({"type": "task.failed"})
    elif task_status == "completed":
        result.append({"type": "task.completed"})

    # Capability
    if task_capability:
        result.append({"type": f"capability:{task_capability}"})

    # Custom tags
    if tags:
        for t in tags:
            result.append({"type": t})

    return result

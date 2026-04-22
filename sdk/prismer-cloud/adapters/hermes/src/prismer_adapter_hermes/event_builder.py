"""
event_builder.py — Pure helper functions that construct PARA event dicts.

Each make_Xxx() returns a plain dict shaped per PARA spec §4.3.
No validation or side effects — callers are responsible for validation before emit.
Mirror of @prismer/adapters-core builders, Python edition.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


# ─── Lifecycle family ──────────────────────────────────────────────────────────


def make_agent_register(
    agent_id: str,
    adapter: str,
    version: str,
    tiers_supported: List[int],
    capability_tags: List[str],
    workspace: str,
    workspace_group: Optional[str] = None,
) -> dict:
    agent: Dict[str, Any] = {
        "id": agent_id,
        "adapter": adapter,
        "version": version,
        "tiersSupported": tiers_supported,
        "capabilityTags": capability_tags,
        "workspace": workspace,
    }
    if workspace_group is not None:
        agent["workspaceGroup"] = workspace_group
    return {"type": "agent.register", "agent": agent}


def make_session_started(
    session_id: str,
    scope: str,
    parent_session_id: Optional[str] = None,
) -> dict:
    evt: Dict[str, Any] = {
        "type": "agent.session.started",
        "sessionId": session_id,
        "scope": scope,
    }
    if parent_session_id is not None:
        evt["parentSessionId"] = parent_session_id
    return evt


def make_session_ended(
    session_id: str,
    reason: str = "stop",
) -> dict:
    return {
        "type": "agent.session.ended",
        "sessionId": session_id,
        "reason": reason,
    }


def make_session_reset(
    session_id: str,
    reason: str = "reset",
) -> dict:
    return {
        "type": "agent.session.reset",
        "sessionId": session_id,
        "reason": reason,
    }


# ─── Turn / LLM family ─────────────────────────────────────────────────────────


def make_prompt_submit(
    session_id: str,
    prompt: str,
    source: str = "user",
) -> dict:
    return {
        "type": "agent.prompt.submit",
        "sessionId": session_id,
        "prompt": prompt,
        "source": source,
    }


def make_llm_pre(
    session_id: str,
    model: str,
    conversation_length: int,
    is_first_turn: bool,
) -> dict:
    return {
        "type": "agent.llm.pre",
        "sessionId": session_id,
        "model": model,
        "conversationLength": conversation_length,
        "isFirstTurn": is_first_turn,
    }


def make_llm_post(
    session_id: str,
    tokens_used: int,
    stop_reason: str,
) -> dict:
    return {
        "type": "agent.llm.post",
        "sessionId": session_id,
        "tokensUsed": tokens_used,
        "stopReason": stop_reason,
    }


def make_turn_step(
    session_id: str,
    iteration: int,
    tool_names: Optional[List[str]] = None,
) -> dict:
    return {
        "type": "agent.turn.step",
        "sessionId": session_id,
        "iteration": iteration,
        "toolNames": tool_names or [],
    }


def make_turn_end(
    session_id: str,
    last_assistant_message: Optional[str] = None,
) -> dict:
    evt: Dict[str, Any] = {
        "type": "agent.turn.end",
        "sessionId": session_id,
    }
    if last_assistant_message is not None:
        evt["lastAssistantMessage"] = last_assistant_message
    return evt


# ─── Tool family ───────────────────────────────────────────────────────────────


def make_tool_pre(
    call_id: str,
    tool: str,
    args: Any,
    risk_tag: Optional[str] = None,
) -> dict:
    evt: Dict[str, Any] = {
        "type": "agent.tool.pre",
        "callId": call_id,
        "tool": tool,
        "args": args,
    }
    if risk_tag is not None:
        evt["riskTag"] = risk_tag
    return evt


def make_tool_post(
    call_id: str,
    ok: bool,
    duration_ms: float,
    summary: str,
    updated_mcp_tool_output: Any = None,
) -> dict:
    evt: Dict[str, Any] = {
        "type": "agent.tool.post",
        "callId": call_id,
        "ok": ok,
        "durationMs": duration_ms,
        "summary": summary,
    }
    if updated_mcp_tool_output is not None:
        evt["updatedMCPToolOutput"] = updated_mcp_tool_output
    return evt


def make_tool_failure(
    call_id: str,
    error: str,
    signal_pattern: Optional[str] = None,
    is_interrupt: Optional[bool] = None,
) -> dict:
    evt: Dict[str, Any] = {
        "type": "agent.tool.failure",
        "callId": call_id,
        "error": error,
    }
    if signal_pattern is not None:
        evt["signalPattern"] = signal_pattern
    if is_interrupt is not None:
        evt["isInterrupt"] = is_interrupt
    return evt


# ─── Command family ────────────────────────────────────────────────────────────


def make_command(
    command: str,
    command_kind: str = "other",
    args: Any = None,
    source: Optional[str] = None,
) -> dict:
    evt: Dict[str, Any] = {
        "type": "agent.command",
        "command": command,
        "commandKind": command_kind,
    }
    if args is not None:
        evt["args"] = args
    if source is not None:
        evt["source"] = source
    return evt


# ─── Delegation family ─────────────────────────────────────────────────────────


def make_subagent_ended(
    parent_session_id: Optional[str],
    subagent_type: Optional[str],
    summary: Optional[str],
    status: str,
    duration_ms: float,
) -> dict:
    evt: Dict[str, Any] = {
        "type": "agent.subagent.ended",
        "status": status,
        "durationMs": duration_ms,
    }
    # Hermes delegate_tool passes parent_session_id=getattr(..., "session_id", None),
    # which may be None when the parent has no session_id. Omit rather than
    # emit parentSessionId="" so downstream can distinguish absence from empty.
    if parent_session_id:
        evt["parentSessionId"] = parent_session_id
    if subagent_type is not None:
        evt["subagentType"] = subagent_type
    if summary is not None:
        evt["summary"] = summary
    return evt


# ─── State family ──────────────────────────────────────────────────────────────


def make_agent_state(status: str) -> dict:
    return {"type": "agent.state", "status": status}

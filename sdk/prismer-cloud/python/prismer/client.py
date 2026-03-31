"""Prismer Cloud API Client — covers Context, Parse, and IM APIs."""

from typing import Any, BinaryIO, Callable, Dict, List, Optional, Union
from urllib.parse import quote as _url_quote
import mimetypes
import pathlib
import re
import httpx


def _safe_slug(slug: str) -> str:
    """Sanitize slug for safe filesystem use — prevents directory traversal."""
    s = re.sub(r'[/\\]', '', slug).replace('..', '')
    return s if s else ''

from .types import (
    ENVIRONMENTS,
    LoadResult,
    SaveResult,
    ParseResult,
    IMResult,
    PrismerError,
)


# ============================================================================
# IM Sub-Client Building Blocks (sync)
# ============================================================================

class AccountClient:
    """Account management: register, identity, token refresh."""

    def __init__(self, request_fn):
        self._request = request_fn

    def register(self, **kwargs) -> IMResult:
        """Register an agent or human identity."""
        return self._request("POST", "/api/im/register", json=kwargs)

    def me(self) -> IMResult:
        """Get own identity, stats, bindings, credits."""
        return self._request("GET", "/api/im/me")

    def refresh_token(self) -> IMResult:
        """Refresh JWT token."""
        return self._request("POST", "/api/im/token/refresh")


class DirectClient:
    """Direct messaging between two users."""

    def __init__(self, request_fn):
        self._request = request_fn

    def send(
        self, user_id: str, content: str, *, type: str = "text",
        metadata: Optional[Dict[str, Any]] = None,
        parent_id: Optional[str] = None,
    ) -> IMResult:
        """Send a direct message to a user."""
        payload: Dict[str, Any] = {"content": content, "type": type}
        if metadata:
            payload["metadata"] = metadata
        if parent_id:
            payload["parentId"] = parent_id
        return self._request("POST", f"/api/im/direct/{user_id}/messages", json=payload)

    def get_messages(
        self, user_id: str, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        """Get direct message history with a user."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return self._request("GET", f"/api/im/direct/{user_id}/messages", params=params)


class GroupsClient:
    """Group chat management and messaging."""

    def __init__(self, request_fn):
        self._request = request_fn

    def create(
        self, title: str, members: List[str], *, description: Optional[str] = None,
    ) -> IMResult:
        """Create a group chat."""
        payload: Dict[str, Any] = {"title": title, "members": members}
        if description:
            payload["description"] = description
        return self._request("POST", "/api/im/groups", json=payload)

    def list(self) -> IMResult:
        """List groups you belong to."""
        return self._request("GET", "/api/im/groups")

    def get(self, group_id: str) -> IMResult:
        """Get group details."""
        return self._request("GET", f"/api/im/groups/{group_id}")

    def send(
        self, group_id: str, content: str, *, type: str = "text",
        metadata: Optional[Dict[str, Any]] = None,
        parent_id: Optional[str] = None,
    ) -> IMResult:
        """Send a message to a group."""
        payload: Dict[str, Any] = {"content": content, "type": type}
        if metadata:
            payload["metadata"] = metadata
        if parent_id:
            payload["parentId"] = parent_id
        return self._request("POST", f"/api/im/groups/{group_id}/messages", json=payload)

    def get_messages(
        self, group_id: str, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        """Get group message history."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return self._request("GET", f"/api/im/groups/{group_id}/messages", params=params)

    def add_member(self, group_id: str, user_id: str) -> IMResult:
        """Add a member to a group (owner/admin only)."""
        return self._request("POST", f"/api/im/groups/{group_id}/members", json={"userId": user_id})

    def remove_member(self, group_id: str, user_id: str) -> IMResult:
        """Remove a member from a group (owner/admin only)."""
        return self._request("DELETE", f"/api/im/groups/{group_id}/members/{user_id}")


class ConversationsClient:
    """Conversation management."""

    def __init__(self, request_fn):
        self._request = request_fn

    def list(self, *, with_unread: bool = False, unread_only: bool = False) -> IMResult:
        """List conversations."""
        params: Dict[str, Any] = {}
        if with_unread:
            params["withUnread"] = "true"
        if unread_only:
            params["unreadOnly"] = "true"
        return self._request("GET", "/api/im/conversations", params=params)

    def get(self, conversation_id: str) -> IMResult:
        """Get conversation details."""
        return self._request("GET", f"/api/im/conversations/{conversation_id}")

    def create_direct(self, user_id: str) -> IMResult:
        """Create a direct conversation."""
        return self._request("POST", "/api/im/conversations/direct", json={"userId": user_id})

    def mark_as_read(self, conversation_id: str) -> IMResult:
        """Mark a conversation as read."""
        return self._request("POST", f"/api/im/conversations/{conversation_id}/read")


class MessagesClient:
    """Low-level message operations (by conversation ID)."""

    def __init__(self, request_fn):
        self._request = request_fn

    def send(
        self, conversation_id: str, content: str, *, type: str = "text",
        metadata: Optional[Dict[str, Any]] = None,
        parent_id: Optional[str] = None,
    ) -> IMResult:
        """Send a message to a conversation."""
        payload: Dict[str, Any] = {"content": content, "type": type}
        if metadata:
            payload["metadata"] = metadata
        if parent_id:
            payload["parentId"] = parent_id
        return self._request("POST", f"/api/im/messages/{conversation_id}", json=payload)

    def get_history(
        self, conversation_id: str, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        """Get message history for a conversation."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return self._request("GET", f"/api/im/messages/{conversation_id}", params=params)

    def edit(self, conversation_id: str, message_id: str, content: str, *, metadata: dict | None = None) -> IMResult:
        """Edit a message."""
        body: dict = {"content": content}
        if metadata is not None:
            body["metadata"] = metadata
        return self._request(
            "PATCH", f"/api/im/messages/{conversation_id}/{message_id}", json=body
        )

    def delete(self, conversation_id: str, message_id: str) -> IMResult:
        """Delete a message."""
        return self._request("DELETE", f"/api/im/messages/{conversation_id}/{message_id}")


class ContactsClient:
    """Contacts and agent discovery."""

    def __init__(self, request_fn):
        self._request = request_fn

    def list(self) -> IMResult:
        """List contacts (users you've communicated with)."""
        return self._request("GET", "/api/im/contacts")

    def discover(self, *, type: Optional[str] = None, capability: Optional[str] = None) -> IMResult:
        """Discover agents by capability or type."""
        params: Dict[str, Any] = {}
        if type:
            params["type"] = type
        if capability:
            params["capability"] = capability
        return self._request("GET", "/api/im/discover", params=params)


class BindingsClient:
    """Social bindings (Telegram, Discord, Slack, etc.)."""

    def __init__(self, request_fn):
        self._request = request_fn

    def create(self, **kwargs) -> IMResult:
        """Create a social binding."""
        return self._request("POST", "/api/im/bindings", json=kwargs)

    def verify(self, binding_id: str, code: str) -> IMResult:
        """Verify a binding with 6-digit code."""
        return self._request("POST", f"/api/im/bindings/{binding_id}/verify", json={"code": code})

    def list(self) -> IMResult:
        """List bindings."""
        return self._request("GET", "/api/im/bindings")

    def delete(self, binding_id: str) -> IMResult:
        """Delete a binding."""
        return self._request("DELETE", f"/api/im/bindings/{binding_id}")


class CreditsClient:
    """Credits balance and transaction history."""

    def __init__(self, request_fn):
        self._request = request_fn

    def get(self) -> IMResult:
        """Get credits balance."""
        return self._request("GET", "/api/im/credits")

    def transactions(
        self, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        """Get credit transaction history."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return self._request("GET", "/api/im/credits/transactions", params=params)


class WorkspaceClient:
    """Workspace management (advanced collaborative environments)."""

    def __init__(self, request_fn):
        self._request = request_fn

    def init(self, workspace_id: str, user_id: str, user_display_name: str) -> IMResult:
        """Initialize a 1:1 workspace (1 user + 1 agent)."""
        return self._request("POST", "/api/im/workspace/init", json={
            "workspaceId": workspace_id, "userId": user_id, "userDisplayName": user_display_name,
        })

    def init_group(self, workspace_id: str, title: str, users: list) -> IMResult:
        """Initialize a group workspace (multi-user + multi-agent)."""
        return self._request("POST", "/api/im/workspace/init-group", json={
            "workspaceId": workspace_id, "title": title, "users": users,
        })

    def add_agent(self, workspace_id: str, agent_id: str) -> IMResult:
        """Add an agent to a workspace."""
        return self._request(
            "POST", f"/api/im/workspace/{workspace_id}/agents", json={"agentId": agent_id}
        )

    def list_agents(self, workspace_id: str) -> IMResult:
        """List agents in a workspace."""
        return self._request("GET", f"/api/im/workspace/{workspace_id}/agents")

    def mention_autocomplete(self, conversation_id: str, query: Optional[str] = None) -> IMResult:
        """@mention autocomplete."""
        params: Dict[str, Any] = {"conversationId": conversation_id}
        if query:
            params["q"] = query
        return self._request("GET", "/api/im/workspace/mentions/autocomplete", params=params)


class TasksClient:
    """Task management: create, list, claim, complete, fail."""

    def __init__(self, request_fn):
        self._request = request_fn

    def create(self, title: str, **kwargs) -> IMResult:
        """Create a new task."""
        payload = {"title": title, **kwargs}
        return self._request("POST", "/api/im/tasks", json=payload)

    def list(
        self, *, status=None, capability=None, assignee_id=None, creator_id=None,
        schedule_type=None, limit=None, cursor=None,
    ) -> IMResult:
        """List tasks with optional filters."""
        params: Dict[str, Any] = {}
        if status:
            params["status"] = status
        if capability:
            params["capability"] = capability
        if assignee_id:
            params["assigneeId"] = assignee_id
        if creator_id:
            params["creatorId"] = creator_id
        if schedule_type:
            params["scheduleType"] = schedule_type
        if limit is not None:
            params["limit"] = limit
        if cursor:
            params["cursor"] = cursor
        return self._request("GET", "/api/im/tasks", params=params)

    def get(self, task_id: str) -> IMResult:
        """Get task details with logs."""
        return self._request("GET", f"/api/im/tasks/{task_id}")

    def update(self, task_id: str, **kwargs) -> IMResult:
        """Update a task (creator only)."""
        return self._request("PATCH", f"/api/im/tasks/{task_id}", json=kwargs)

    def claim(self, task_id: str) -> IMResult:
        """Claim a pending task."""
        return self._request("POST", f"/api/im/tasks/{task_id}/claim")

    def progress(self, task_id: str, *, message=None, metadata=None) -> IMResult:
        """Report task progress."""
        payload: Dict[str, Any] = {}
        if message:
            payload["message"] = message
        if metadata:
            payload["metadata"] = metadata
        return self._request("POST", f"/api/im/tasks/{task_id}/progress", json=payload)

    def complete(self, task_id: str, *, result=None, result_uri=None, cost=None) -> IMResult:
        """Mark task as completed."""
        payload: Dict[str, Any] = {}
        if result is not None:
            payload["result"] = result
        if result_uri:
            payload["resultUri"] = result_uri
        if cost is not None:
            payload["cost"] = cost
        return self._request("POST", f"/api/im/tasks/{task_id}/complete", json=payload)

    def fail(self, task_id: str, error: str, *, metadata=None) -> IMResult:
        """Mark task as failed."""
        payload: Dict[str, Any] = {"error": error}
        if metadata:
            payload["metadata"] = metadata
        return self._request("POST", f"/api/im/tasks/{task_id}/fail", json=payload)


class MemoryClient:
    """Memory management: files, compaction, session load."""

    def __init__(self, request_fn):
        self._request = request_fn

    def create_file(self, path: str, content: str, *, scope=None, owner_type=None) -> IMResult:
        """Create or upsert a memory file."""
        payload: Dict[str, Any] = {"path": path, "content": content}
        if scope:
            payload["scope"] = scope
        if owner_type:
            payload["ownerType"] = owner_type
        return self._request("POST", "/api/im/memory/files", json=payload)

    def list_files(self, *, scope=None, path=None) -> IMResult:
        """List memory files (metadata only)."""
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        if path:
            params["path"] = path
        return self._request("GET", "/api/im/memory/files", params=params)

    def get_file(self, file_id: str) -> IMResult:
        """Read a memory file with content."""
        return self._request("GET", f"/api/im/memory/files/{file_id}")

    def update_file(
        self, file_id: str, operation: str, content: str, *, section=None, version=None,
    ) -> IMResult:
        """Update a memory file (append/replace/replace_section)."""
        payload: Dict[str, Any] = {"operation": operation, "content": content}
        if section:
            payload["section"] = section
        if version is not None:
            payload["version"] = version
        return self._request("PATCH", f"/api/im/memory/files/{file_id}", json=payload)

    def delete_file(self, file_id: str) -> IMResult:
        """Delete a memory file."""
        return self._request("DELETE", f"/api/im/memory/files/{file_id}")

    def compact(
        self, conversation_id: str, summary: str, *,
        message_range_start=None, message_range_end=None,
    ) -> IMResult:
        """Create a compaction summary."""
        payload: Dict[str, Any] = {"conversationId": conversation_id, "summary": summary}
        if message_range_start:
            payload["messageRangeStart"] = message_range_start
        if message_range_end:
            payload["messageRangeEnd"] = message_range_end
        return self._request("POST", "/api/im/memory/compact", json=payload)

    def get_compaction(self, conversation_id: str) -> IMResult:
        """Get compaction summaries for a conversation."""
        return self._request("GET", f"/api/im/memory/compact/{conversation_id}")

    def load(self, scope=None) -> IMResult:
        """Auto-load MEMORY.md session memory."""
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return self._request("GET", "/api/im/memory/load", params=params)


class IdentityClient:
    """Identity key management: Ed25519 keys, attestation, audit."""

    def __init__(self, request_fn):
        self._request = request_fn

    def get_server_key(self) -> IMResult:
        """Get server's public Ed25519 key."""
        return self._request("GET", "/api/im/keys/server")

    def register_key(self, public_key: str, *, derivation_mode=None) -> IMResult:
        """Register or rotate identity key."""
        payload: Dict[str, Any] = {"publicKey": public_key}
        if derivation_mode:
            payload["derivationMode"] = derivation_mode
        return self._request("PUT", "/api/im/keys/identity", json=payload)

    def get_key(self, user_id: str) -> IMResult:
        """Get peer's identity key + attestation."""
        return self._request("GET", f"/api/im/keys/identity/{user_id}")

    def revoke_key(self) -> IMResult:
        """Revoke own identity key."""
        return self._request("POST", "/api/im/keys/identity/revoke")

    def get_audit_log(self, user_id: str) -> IMResult:
        """Get key audit log."""
        return self._request("GET", f"/api/im/keys/audit/{user_id}")

    def verify_audit_log(self, user_id: str) -> IMResult:
        """Verify audit log hash chain integrity."""
        return self._request("GET", f"/api/im/keys/audit/{user_id}/verify")


class EvolutionClient:
    """Skill Evolution: gene management, analysis, recording, distillation."""

    def __init__(self, request_fn):
        self._request = request_fn

    # Public endpoints

    def get_stats(self) -> IMResult:
        """Get public evolution statistics."""
        return self._request("GET", "/api/im/evolution/public/stats")

    def get_hot_genes(self, limit=None) -> IMResult:
        """Get hot/trending genes."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        return self._request("GET", "/api/im/evolution/public/hot", params=params)

    def browse_genes(
        self, *, category=None, search=None, sort=None, page=None, limit=None,
    ) -> IMResult:
        """Browse public gene catalog."""
        params: Dict[str, Any] = {}
        if category:
            params["category"] = category
        if search:
            params["search"] = search
        if sort:
            params["sort"] = sort
        if page is not None:
            params["page"] = page
        if limit is not None:
            params["limit"] = limit
        return self._request("GET", "/api/im/evolution/public/genes", params=params)

    def get_public_gene(self, gene_id: str) -> IMResult:
        """Get a public gene by ID."""
        return self._request("GET", f"/api/im/evolution/public/genes/{gene_id}")

    def get_gene_capsules(self, gene_id: str, limit=None) -> IMResult:
        """Get capsules for a public gene."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        return self._request("GET", f"/api/im/evolution/public/genes/{gene_id}/capsules", params=params)

    def get_gene_lineage(self, gene_id: str) -> IMResult:
        """Get lineage/fork tree for a gene."""
        return self._request("GET", f"/api/im/evolution/public/genes/{gene_id}/lineage")

    def get_feed(self, limit=None) -> IMResult:
        """Get public evolution feed."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        return self._request("GET", "/api/im/evolution/public/feed", params=params)

    # Authenticated endpoints

    def analyze(self, *, scope: Optional[str] = None, **kwargs) -> IMResult:
        """Analyze signals for gene matching."""
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return self._request("POST", "/api/im/evolution/analyze", json=kwargs, params=params or None)

    def record(self, gene_id: str, signals: list, outcome: str, summary: str, *, scope: Optional[str] = None, **kwargs) -> IMResult:
        """Record an evolution capsule."""
        payload: Dict[str, Any] = {
            "gene_id": gene_id, "signals": signals, "outcome": outcome, "summary": summary, **kwargs,
        }
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return self._request("POST", "/api/im/evolution/record", json=payload, params=params or None)

    def evolve(self, *, outcome: str, score: Optional[float] = None, summary: Optional[str] = None,
               strategy_used: Optional[list] = None, scope: Optional[str] = None, **analyze_kwargs) -> IMResult:
        """One-step evolution: analyze context → get gene → auto-record outcome."""
        analysis = self.analyze(scope=scope, **analyze_kwargs)
        if not analysis.get("ok") or not analysis.get("data"):
            return analysis
        data = analysis["data"]
        gene_id = data.get("gene_id")
        if gene_id and data.get("action") in ("apply_gene", "explore"):
            signals = data.get("signals") or analyze_kwargs.get("signals", [])
            rec = self.record(gene_id, signals, outcome,
                              summary or f"{'Resolved' if outcome == 'success' else 'Failed'} using {gene_id}",
                              score=score or (0.8 if outcome == "success" else 0.2),
                              strategy_used=strategy_used, scope=scope)
            return {"ok": True, "data": {"analysis": data, "recorded": True, "edge_updated": rec.get("data", {}).get("edge_updated")}}
        return {"ok": True, "data": {"analysis": data, "recorded": False}}

    def distill(self, dry_run=False) -> IMResult:
        """Distill capsules into gene updates."""
        params: Dict[str, Any] = {}
        if dry_run:
            params["dry_run"] = "true"
        return self._request("POST", "/api/im/evolution/distill", params=params)

    def list_genes(self, signals=None, scope: Optional[str] = None) -> IMResult:
        """List own genes, optionally filtered by signals."""
        params: Dict[str, Any] = {}
        if signals:
            params["signals"] = signals
        if scope:
            params["scope"] = scope
        return self._request("GET", "/api/im/evolution/genes", params=params)

    def create_gene(self, category: str, signals_match: list, strategy: list, *, scope: Optional[str] = None, **kwargs) -> IMResult:
        """Create a new gene."""
        payload: Dict[str, Any] = {
            "category": category, "signals_match": signals_match, "strategy": strategy, **kwargs,
        }
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return self._request("POST", "/api/im/evolution/genes", json=payload, params=params or None)

    def delete_gene(self, gene_id: str) -> IMResult:
        """Delete a gene."""
        return self._request("DELETE", f"/api/im/evolution/genes/{gene_id}")

    def publish_gene(self, gene_id: str) -> IMResult:
        """Publish a gene to the public catalog."""
        return self._request("POST", f"/api/im/evolution/genes/{gene_id}/publish")

    def import_gene(self, gene_id: str) -> IMResult:
        """Import a public gene."""
        return self._request("POST", "/api/im/evolution/genes/import", json={"gene_id": gene_id})

    def fork_gene(self, gene_id: str, modifications=None) -> IMResult:
        """Fork a gene with optional modifications."""
        payload: Dict[str, Any] = {"gene_id": gene_id}
        if modifications:
            payload["modifications"] = modifications
        return self._request("POST", "/api/im/evolution/genes/fork", json=payload)

    def get_edges(self, *, signal_key=None, gene_id=None, limit=None, scope: Optional[str] = None) -> IMResult:
        """Get signal-gene edges."""
        params: Dict[str, Any] = {}
        if signal_key:
            params["signal_key"] = signal_key
        if gene_id:
            params["gene_id"] = gene_id
        if limit is not None:
            params["limit"] = limit
        if scope:
            params["scope"] = scope
        return self._request("GET", "/api/im/evolution/edges", params=params)

    def get_personality(self, agent_id: str) -> IMResult:
        """Get agent personality profile."""
        return self._request("GET", f"/api/im/evolution/personality/{agent_id}")

    def get_capsules(self, *, page=None, limit=None, scope: Optional[str] = None) -> IMResult:
        """Get own evolution capsules."""
        params: Dict[str, Any] = {}
        if page is not None:
            params["page"] = page
        if limit is not None:
            params["limit"] = limit
        if scope:
            params["scope"] = scope
        return self._request("GET", "/api/im/evolution/capsules", params=params)

    def get_report(self, agent_id=None, scope: Optional[str] = None) -> IMResult:
        """Get evolution report."""
        params: Dict[str, Any] = {}
        if agent_id:
            params["agent_id"] = agent_id
        if scope:
            params["scope"] = scope
        return self._request("GET", "/api/im/evolution/report", params=params)

    def list_scopes(self) -> IMResult:
        """List available evolution scopes."""
        return self._request("GET", "/api/im/evolution/scopes")

    # ─── v0.3.1: Stories, Metrics, Skills ──────────────

    def get_stories(self, limit=3, since=30) -> IMResult:
        """Get recent evolution stories for L1 narrative."""
        return self._request("GET", "/api/im/evolution/stories", params={"limit": limit, "since": since})

    def get_metrics(self) -> IMResult:
        """Get north-star metrics comparison (standard vs hypergraph)."""
        return self._request("GET", "/api/im/evolution/metrics")

    def collect_metrics(self, window_hours=1) -> IMResult:
        """Trigger metrics collection snapshot."""
        return self._request("POST", "/api/im/evolution/metrics/collect", json={"window_hours": window_hours})

    def search_skills(self, query=None, category=None, limit=None) -> IMResult:
        """Search skills catalog."""
        params: Dict[str, Any] = {}
        if query: params["query"] = query
        if category: params["category"] = category
        if limit is not None: params["limit"] = limit
        return self._request("GET", "/api/im/skills/search", params=params)

    def get_skill_stats(self) -> IMResult:
        """Get skill catalog statistics."""
        return self._request("GET", "/api/im/skills/stats")

    def install_skill(self, slug_or_id: str) -> IMResult:
        """Install a skill — creates cloud record + Gene, returns content for local install."""
        return self._request("POST", f"/api/im/skills/{_url_quote(slug_or_id, safe='')}/install")

    def uninstall_skill(self, slug_or_id: str) -> IMResult:
        """Uninstall a skill."""
        return self._request("DELETE", f"/api/im/skills/{_url_quote(slug_or_id, safe='')}/install")

    def installed_skills(self) -> IMResult:
        """List installed skills for this agent."""
        return self._request("GET", "/api/im/skills/installed")

    def get_skill_content(self, slug_or_id: str) -> IMResult:
        """Get full skill content (SKILL.md + package info)."""
        return self._request("GET", f"/api/im/skills/{_url_quote(slug_or_id, safe='')}/content")

    def install_skill_local(self, slug_or_id: str, platforms: Optional[List[str]] = None, project: bool = False, project_root: Optional[str] = None) -> IMResult:
        """Install a skill and write SKILL.md to local filesystem.

        Combines cloud install + local file sync for Claude Code / OpenClaw / OpenCode / Plugin.

        Args:
            slug_or_id: Skill slug or ID
            platforms: Target platforms (default: all). Options: 'claude-code', 'openclaw', 'opencode', 'plugin'
            project: Write to project-level paths instead of global
            project_root: Project root directory (for project-level installs)
        """
        import os as _os
        from pathlib import Path

        result = self.install_skill(slug_or_id)
        result.local_paths = []

        if not result.ok or not result.data:
            return result

        skill = result.data.get("skill", {})
        content = skill.get("content", "")
        slug = _safe_slug(skill.get("slug", slug_or_id))
        if not slug:
            return result

        if not content:
            content_result = self.get_skill_content(slug_or_id)
            if content_result.ok and content_result.data:
                content = content_result.data.get("content", "")

        if not content:
            return result

        home = Path.home()
        plugin_dir = Path(_os.environ.get("PRISMER_PLUGIN_DIR", str(home / ".claude" / "plugins" / "prismer")))
        if project:
            root = Path(project_root) if project_root else Path.cwd()
            platform_paths = {
                "claude-code": root / ".claude" / "skills" / slug,
                "openclaw": root / "skills" / slug,
                "opencode": root / ".opencode" / "skills" / slug,
                "plugin": root / ".claude" / "plugins" / "prismer" / "skills" / slug,
            }
        else:
            platform_paths = {
                "claude-code": home / ".claude" / "skills" / slug,
                "openclaw": home / ".openclaw" / "skills" / slug,
                "opencode": home / ".config" / "opencode" / "skills" / slug,
                "plugin": plugin_dir / "skills" / slug,
            }

        targets = platforms or list(platform_paths.keys())
        local_paths = []

        for platform in targets:
            skill_dir = platform_paths.get(platform)
            if not skill_dir:
                continue
            try:
                skill_dir.mkdir(parents=True, exist_ok=True)
                file_path = skill_dir / "SKILL.md"
                file_path.write_text(content, encoding="utf-8")
                local_paths.append(str(file_path))
            except OSError:
                pass

        result.local_paths = local_paths
        return result

    def uninstall_skill_local(self, slug_or_id: str) -> IMResult:
        """Uninstall a skill and remove local SKILL.md files."""
        import os as _os
        import shutil
        from pathlib import Path

        result = self.uninstall_skill(slug_or_id)
        removed = []

        safe = _safe_slug(slug_or_id)
        if not safe:
            result.removed_paths = removed
            return result

        home = Path.home()
        plugin_dir = Path(_os.environ.get("PRISMER_PLUGIN_DIR", str(home / ".claude" / "plugins" / "prismer")))
        dirs = [
            home / ".claude" / "skills" / safe,
            home / ".openclaw" / "skills" / safe,
            home / ".config" / "opencode" / "skills" / safe,
            plugin_dir / "skills" / safe,
        ]

        for d in dirs:
            try:
                if d.exists():
                    shutil.rmtree(d)
                    removed.append(str(d))
            except OSError:
                pass

        result.removed_paths = removed
        return result

    def sync_skills_local(self, platforms: Optional[List[str]] = None) -> dict:
        """Sync all installed skills to local filesystem."""
        import os as _os
        from pathlib import Path

        installed = self.installed_skills()
        if not installed.ok or not installed.data:
            return {"synced": 0, "failed": 0, "paths": []}

        synced = 0
        failed = 0
        paths = []

        home = Path.home()
        plugin_dir = Path(_os.environ.get("PRISMER_PLUGIN_DIR", str(home / ".claude" / "plugins" / "prismer")))

        for record in installed.data:
            skill = record.get("skill", {})
            raw_slug = skill.get("slug") if skill else None
            if not raw_slug:
                failed += 1
                continue
            slug = _safe_slug(raw_slug)
            if not slug:
                failed += 1
                continue

            try:
                content_result = self.get_skill_content(slug)
                content = content_result.data.get("content", "") if content_result.ok and content_result.data else ""
                if not content:
                    failed += 1
                    continue

                platform_paths = {
                    "claude-code": home / ".claude" / "skills" / slug,
                    "openclaw": home / ".openclaw" / "skills" / slug,
                    "opencode": home / ".config" / "opencode" / "skills" / slug,
                    "plugin": plugin_dir / "skills" / slug,
                }

                targets = platforms or list(platform_paths.keys())
                for platform in targets:
                    skill_dir = platform_paths.get(platform)
                    if not skill_dir:
                        continue
                    try:
                        skill_dir.mkdir(parents=True, exist_ok=True)
                        file_path = skill_dir / "SKILL.md"
                        file_path.write_text(content, encoding="utf-8")
                        paths.append(str(file_path))
                    except OSError:
                        pass
                synced += 1
            except Exception:
                failed += 1

        return {"synced": synced, "failed": failed, "paths": paths}

    # ─── P0: Report, Achievements, Sync ──────────────

    def submit_report(self, raw_context: str, outcome: str, **kwargs) -> IMResult:
        """Submit a raw-context evolution report (auto-creates signals + gene match)."""
        payload: Dict[str, Any] = {"raw_context": raw_context, "outcome": outcome, **kwargs}
        return self._request("POST", "/api/im/evolution/report", json=payload)

    def get_report_status(self, trace_id: str) -> IMResult:
        """Get status of a submitted report by traceId."""
        return self._request("GET", f"/api/im/evolution/report/{trace_id}")

    def get_achievements(self) -> IMResult:
        """Get evolution achievements for the current agent."""
        return self._request("GET", "/api/im/evolution/achievements")

    def get_sync_snapshot(self, since: Optional[int] = None) -> IMResult:
        """Get a sync snapshot (global gene/edge state since a sequence number)."""
        params: Dict[str, Any] = {"scope": "global"}
        if since is not None:
            params["since"] = since
        return self._request("GET", "/api/im/evolution/sync/snapshot", params=params)

    def sync(self, push_outcomes: Optional[List] = None, pull_since: Optional[int] = None) -> IMResult:
        """Bidirectional sync: push local outcomes and pull remote updates."""
        payload: Dict[str, Any] = {}
        if push_outcomes:
            payload["push"] = {"outcomes": push_outcomes}
        if pull_since is not None:
            payload["pull"] = {"since": pull_since}
        return self._request("POST", "/api/im/evolution/sync", json=payload)

    def export_as_skill(self, gene_id: str, **kwargs) -> IMResult:
        """Export a Gene as a Skill."""
        return self._request("POST", f"/api/im/evolution/genes/{gene_id}/export-skill", json=kwargs or None)


class SecurityClient:
    """Conversation security: E2E encryption settings and key management."""

    def __init__(self, request_fn):
        self._request = request_fn

    def get_conversation_security(self, conversation_id: str) -> IMResult:
        """Get conversation security settings."""
        return self._request("GET", f"/api/im/conversations/{conversation_id}/security")

    def set_conversation_security(self, conversation_id: str, **kwargs) -> IMResult:
        """Update conversation security settings (signingPolicy, encryptionMode)."""
        return self._request("PATCH", f"/api/im/conversations/{conversation_id}/security", json=kwargs)

    def upload_key(self, conversation_id: str, public_key: str, algorithm: Optional[str] = None) -> IMResult:
        """Upload a public key for a conversation."""
        payload: Dict[str, Any] = {"publicKey": public_key}
        if algorithm:
            payload["algorithm"] = algorithm
        return self._request("POST", f"/api/im/conversations/{conversation_id}/keys", json=payload)

    def get_keys(self, conversation_id: str) -> IMResult:
        """Get keys for a conversation."""
        return self._request("GET", f"/api/im/conversations/{conversation_id}/keys")

    def revoke_key(self, conversation_id: str, key_user_id: str) -> IMResult:
        """Revoke a key for a specific user in a conversation."""
        return self._request("DELETE", f"/api/im/conversations/{conversation_id}/keys/{key_user_id}")


def _guess_mime_type(file_name: str) -> str:
    """Guess MIME type from file extension using stdlib + fallback map."""
    mime, _ = mimetypes.guess_type(file_name)
    if mime:
        return mime
    ext = pathlib.Path(file_name).suffix.lower()
    fallback = {
        ".md": "text/markdown", ".yaml": "text/yaml", ".yml": "text/yaml",
        ".webp": "image/webp", ".webm": "video/webm",
    }
    return fallback.get(ext, "application/octet-stream")


# File input type: str/Path (file path), bytes, or file-like object
FileInput = Union[str, pathlib.Path, bytes, BinaryIO]


class FilesClient:
    """File upload management (presign → upload → confirm)."""

    def __init__(self, request_fn, base_url: str, get_auth_headers: Callable):
        self._request = request_fn
        self._base_url = base_url
        self._get_auth_headers = get_auth_headers

    def presign(self, file_name: str, file_size: int, mime_type: str) -> IMResult:
        """Get a presigned upload URL."""
        return self._request("POST", "/api/im/files/presign", json={
            "fileName": file_name, "fileSize": file_size, "mimeType": mime_type,
        })

    def confirm(self, upload_id: str) -> IMResult:
        """Confirm an uploaded file (triggers validation + CDN activation)."""
        return self._request("POST", "/api/im/files/confirm", json={"uploadId": upload_id})

    def quota(self) -> IMResult:
        """Get storage quota."""
        return self._request("GET", "/api/im/files/quota")

    def delete(self, upload_id: str) -> IMResult:
        """Delete a file."""
        return self._request("DELETE", f"/api/im/files/{upload_id}")

    def types(self) -> IMResult:
        """List allowed MIME types."""
        return self._request("GET", "/api/im/files/types")

    def init_multipart(self, file_name: str, file_size: int, mime_type: str) -> IMResult:
        """Initialize a multipart upload (for files > 10 MB)."""
        return self._request("POST", "/api/im/files/upload/init", json={
            "fileName": file_name, "fileSize": file_size, "mimeType": mime_type,
        })

    def complete_multipart(self, upload_id: str, parts: List[Dict]) -> IMResult:
        """Complete a multipart upload."""
        return self._request("POST", "/api/im/files/upload/complete", json={
            "uploadId": upload_id, "parts": parts,
        })

    # ------------------------------------------------------------------
    # High-level convenience methods
    # ------------------------------------------------------------------

    def upload(
        self,
        file: FileInput,
        *,
        file_name: Optional[str] = None,
        mime_type: Optional[str] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Dict[str, Any]:
        """Upload a file (full lifecycle: presign → upload → confirm).

        Args:
            file: File path (str/Path), bytes, or file-like object.
            file_name: Required if ``file`` is bytes or a nameless file-like object.
            mime_type: Auto-detected from extension if not provided.
            on_progress: ``(uploaded, total)`` callback.

        Returns:
            Confirmed upload dict with ``uploadId``, ``cdnUrl``, ``fileName``, etc.
        """
        data, file_name = self._resolve_input(file, file_name)
        file_size = len(data)
        mime_type = mime_type or _guess_mime_type(file_name)

        if file_size > 50 * 1024 * 1024:
            raise ValueError("File exceeds maximum size of 50 MB")

        if file_size <= 10 * 1024 * 1024:
            return self._upload_simple(data, file_name, file_size, mime_type, on_progress)
        return self._upload_multipart(data, file_name, file_size, mime_type, on_progress)

    def send_file(
        self,
        conversation_id: str,
        file: FileInput,
        *,
        content: Optional[str] = None,
        parent_id: Optional[str] = None,
        file_name: Optional[str] = None,
        mime_type: Optional[str] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Dict[str, Any]:
        """Upload a file and send it as a message in one call.

        Returns:
            ``{"upload": ..., "message": ...}``
        """
        uploaded = self.upload(file, file_name=file_name, mime_type=mime_type, on_progress=on_progress)

        payload: Dict[str, Any] = {
            "content": content or uploaded["fileName"],
            "type": "file",
            "metadata": {
                "uploadId": uploaded["uploadId"],
                "fileUrl": uploaded["cdnUrl"],
                "fileName": uploaded["fileName"],
                "fileSize": uploaded["fileSize"],
                "mimeType": uploaded["mimeType"],
            },
        }
        if parent_id:
            payload["parentId"] = parent_id

        msg_res = self._request("POST", f"/api/im/messages/{conversation_id}", json=payload)
        if not msg_res.get("ok"):
            raise RuntimeError(msg_res.get("error", {}).get("message", "Failed to send file message"))
        return {"upload": uploaded, "message": msg_res.get("data")}

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_input(file: FileInput, file_name: Optional[str]) -> tuple:
        if isinstance(file, (str, pathlib.Path)):
            path = pathlib.Path(file)
            return path.read_bytes(), file_name or path.name
        if isinstance(file, bytes):
            if not file_name:
                raise ValueError("file_name is required when uploading bytes")
            return file, file_name
        # file-like object
        if hasattr(file, "read"):
            data = file.read()
            name = file_name or getattr(file, "name", None)
            if not name:
                raise ValueError("file_name is required for file-like objects without name")
            if isinstance(name, str) and "/" in name:
                name = pathlib.Path(name).name
            return data, name
        raise TypeError(f"Unsupported file input type: {type(file)}")

    def _upload_simple(self, data, file_name, file_size, mime_type, on_progress=None):
        res = self.presign(file_name, file_size, mime_type)
        if not res.get("ok"):
            raise RuntimeError(res.get("error", {}).get("message", "Presign failed"))
        presign = res["data"]
        upload_id, url, fields = presign["uploadId"], presign["url"], presign.get("fields", {})

        is_s3 = url.startswith("http")
        upload_url = url if is_s3 else f"{self._base_url}{url}"

        files_param = {"file": (file_name, data, mime_type)}
        if is_s3:
            resp = httpx.post(upload_url, data=fields, files=files_param, timeout=60)
        else:
            resp = httpx.post(upload_url, files=files_param, headers=self._get_auth_headers(), timeout=60)
        resp.raise_for_status()

        if on_progress:
            on_progress(file_size, file_size)

        confirm_res = self.confirm(upload_id)
        if not confirm_res.get("ok"):
            raise RuntimeError(confirm_res.get("error", {}).get("message", "Confirm failed"))
        return confirm_res["data"]

    def _upload_multipart(self, data, file_name, file_size, mime_type, on_progress=None):
        init_res = self.init_multipart(file_name, file_size, mime_type)
        if not init_res.get("ok"):
            raise RuntimeError(init_res.get("error", {}).get("message", "Multipart init failed"))
        init = init_res["data"]
        upload_id, part_urls = init["uploadId"], init["parts"]

        chunk_size = 5 * 1024 * 1024
        completed: List[Dict] = []
        uploaded = 0

        for part in part_urls:
            start = (part["partNumber"] - 1) * chunk_size
            end = min(start + chunk_size, file_size)
            chunk = data[start:end]

            is_s3 = part["url"].startswith("http")
            part_url = part["url"] if is_s3 else f"{self._base_url}{part['url']}"
            headers = {"Content-Type": mime_type}
            if not is_s3:
                headers.update(self._get_auth_headers())

            resp = httpx.put(part_url, content=chunk, headers=headers, timeout=120)
            resp.raise_for_status()

            etag = resp.headers.get("ETag", f'"part-{part["partNumber"]}"')
            completed.append({"partNumber": part["partNumber"], "etag": etag})
            uploaded += len(chunk)
            if on_progress:
                on_progress(uploaded, file_size)

        complete_res = self.complete_multipart(upload_id, completed)
        if not complete_res.get("ok"):
            raise RuntimeError(complete_res.get("error", {}).get("message", "Multipart complete failed"))
        return complete_res["data"]


class IMRealtimeClient:
    """Real-time connection factory (WebSocket & SSE)."""

    def __init__(self, base_url: str):
        self._base_url = base_url

    def ws_url(self, token: Optional[str] = None) -> str:
        """Get the WebSocket URL."""
        base = self._base_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{base}/ws?token={token}" if token else f"{base}/ws"

    def sse_url(self, token: Optional[str] = None) -> str:
        """Get the SSE URL."""
        return f"{self._base_url}/sse?token={token}" if token else f"{self._base_url}/sse"

    def connect_ws(self, config) -> "RealtimeWSClient":
        """Create a sync WebSocket client. Call .connect() to start."""
        from .realtime import RealtimeWSClient
        return RealtimeWSClient(self._base_url, config)

    def connect_sse(self, config) -> "RealtimeSSEClient":
        """Create a sync SSE client. Call .connect() to start."""
        from .realtime import RealtimeSSEClient
        return RealtimeSSEClient(self._base_url, config)


# ============================================================================
# IM Client (sync) — orchestrates sub-modules
# ============================================================================

class IMClient:
    """IM API sub-client with sub-module access pattern. Access via ``client.im``."""

    def __init__(self, request_fn, base_url: str, get_auth_headers: Callable):
        self._request = request_fn
        self.account = AccountClient(request_fn)
        self.direct = DirectClient(request_fn)
        self.groups = GroupsClient(request_fn)
        self.conversations = ConversationsClient(request_fn)
        self.messages = MessagesClient(request_fn)
        self.contacts = ContactsClient(request_fn)
        self.bindings = BindingsClient(request_fn)
        self.credits = CreditsClient(request_fn)
        self.workspace = WorkspaceClient(request_fn)
        self.files = FilesClient(request_fn, base_url, get_auth_headers)
        self.tasks = TasksClient(request_fn)
        self.memory = MemoryClient(request_fn)
        self.identity = IdentityClient(request_fn)
        self.security = SecurityClient(request_fn)
        self.evolution = EvolutionClient(request_fn)
        self.realtime = IMRealtimeClient(base_url)

    def health(self) -> IMResult:
        """IM health check."""
        return self._request("GET", "/api/im/health")


# ============================================================================
# IM Sub-Client Building Blocks (async)
# ============================================================================

class AsyncAccountClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def register(self, **kwargs) -> IMResult:
        return await self._request("POST", "/api/im/register", json=kwargs)

    async def me(self) -> IMResult:
        return await self._request("GET", "/api/im/me")

    async def refresh_token(self) -> IMResult:
        return await self._request("POST", "/api/im/token/refresh")


class AsyncDirectClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def send(
        self, user_id: str, content: str, *, type: str = "text",
        metadata: Optional[Dict[str, Any]] = None,
        parent_id: Optional[str] = None,
    ) -> IMResult:
        payload: Dict[str, Any] = {"content": content, "type": type}
        if metadata:
            payload["metadata"] = metadata
        if parent_id:
            payload["parentId"] = parent_id
        return await self._request("POST", f"/api/im/direct/{user_id}/messages", json=payload)

    async def get_messages(
        self, user_id: str, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return await self._request("GET", f"/api/im/direct/{user_id}/messages", params=params)


class AsyncGroupsClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def create(
        self, title: str, members: List[str], *, description: Optional[str] = None,
    ) -> IMResult:
        payload: Dict[str, Any] = {"title": title, "members": members}
        if description:
            payload["description"] = description
        return await self._request("POST", "/api/im/groups", json=payload)

    async def list(self) -> IMResult:
        return await self._request("GET", "/api/im/groups")

    async def get(self, group_id: str) -> IMResult:
        return await self._request("GET", f"/api/im/groups/{group_id}")

    async def send(
        self, group_id: str, content: str, *, type: str = "text",
        metadata: Optional[Dict[str, Any]] = None,
        parent_id: Optional[str] = None,
    ) -> IMResult:
        payload: Dict[str, Any] = {"content": content, "type": type}
        if metadata:
            payload["metadata"] = metadata
        if parent_id:
            payload["parentId"] = parent_id
        return await self._request("POST", f"/api/im/groups/{group_id}/messages", json=payload)

    async def get_messages(
        self, group_id: str, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return await self._request("GET", f"/api/im/groups/{group_id}/messages", params=params)

    async def add_member(self, group_id: str, user_id: str) -> IMResult:
        return await self._request(
            "POST", f"/api/im/groups/{group_id}/members", json={"userId": user_id}
        )

    async def remove_member(self, group_id: str, user_id: str) -> IMResult:
        return await self._request("DELETE", f"/api/im/groups/{group_id}/members/{user_id}")


class AsyncConversationsClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def list(self, *, with_unread: bool = False, unread_only: bool = False) -> IMResult:
        params: Dict[str, Any] = {}
        if with_unread:
            params["withUnread"] = "true"
        if unread_only:
            params["unreadOnly"] = "true"
        return await self._request("GET", "/api/im/conversations", params=params)

    async def get(self, conversation_id: str) -> IMResult:
        return await self._request("GET", f"/api/im/conversations/{conversation_id}")

    async def create_direct(self, user_id: str) -> IMResult:
        return await self._request(
            "POST", "/api/im/conversations/direct", json={"userId": user_id}
        )

    async def mark_as_read(self, conversation_id: str) -> IMResult:
        return await self._request("POST", f"/api/im/conversations/{conversation_id}/read")


class AsyncMessagesClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def send(
        self, conversation_id: str, content: str, *, type: str = "text",
        metadata: Optional[Dict[str, Any]] = None,
        parent_id: Optional[str] = None,
    ) -> IMResult:
        payload: Dict[str, Any] = {"content": content, "type": type}
        if metadata:
            payload["metadata"] = metadata
        if parent_id:
            payload["parentId"] = parent_id
        return await self._request("POST", f"/api/im/messages/{conversation_id}", json=payload)

    async def get_history(
        self, conversation_id: str, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return await self._request("GET", f"/api/im/messages/{conversation_id}", params=params)

    async def edit(self, conversation_id: str, message_id: str, content: str, *, metadata: dict | None = None) -> IMResult:
        body: dict = {"content": content}
        if metadata is not None:
            body["metadata"] = metadata
        return await self._request(
            "PATCH", f"/api/im/messages/{conversation_id}/{message_id}", json=body
        )

    async def delete(self, conversation_id: str, message_id: str) -> IMResult:
        return await self._request("DELETE", f"/api/im/messages/{conversation_id}/{message_id}")


class AsyncContactsClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def list(self) -> IMResult:
        return await self._request("GET", "/api/im/contacts")

    async def discover(
        self, *, type: Optional[str] = None, capability: Optional[str] = None,
    ) -> IMResult:
        params: Dict[str, Any] = {}
        if type:
            params["type"] = type
        if capability:
            params["capability"] = capability
        return await self._request("GET", "/api/im/discover", params=params)


class AsyncBindingsClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def create(self, **kwargs) -> IMResult:
        return await self._request("POST", "/api/im/bindings", json=kwargs)

    async def verify(self, binding_id: str, code: str) -> IMResult:
        return await self._request(
            "POST", f"/api/im/bindings/{binding_id}/verify", json={"code": code}
        )

    async def list(self) -> IMResult:
        return await self._request("GET", "/api/im/bindings")

    async def delete(self, binding_id: str) -> IMResult:
        return await self._request("DELETE", f"/api/im/bindings/{binding_id}")


class AsyncCreditsClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def get(self) -> IMResult:
        return await self._request("GET", "/api/im/credits")

    async def transactions(
        self, *, limit: Optional[int] = None, offset: Optional[int] = None,
    ) -> IMResult:
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        return await self._request("GET", "/api/im/credits/transactions", params=params)


class AsyncWorkspaceClient:
    def __init__(self, request_fn):
        self._request = request_fn

    async def init(self, workspace_id: str, user_id: str, user_display_name: str) -> IMResult:
        return await self._request("POST", "/api/im/workspace/init", json={
            "workspaceId": workspace_id, "userId": user_id, "userDisplayName": user_display_name,
        })

    async def init_group(self, workspace_id: str, title: str, users: list) -> IMResult:
        return await self._request("POST", "/api/im/workspace/init-group", json={
            "workspaceId": workspace_id, "title": title, "users": users,
        })

    async def add_agent(self, workspace_id: str, agent_id: str) -> IMResult:
        return await self._request(
            "POST", f"/api/im/workspace/{workspace_id}/agents", json={"agentId": agent_id}
        )

    async def list_agents(self, workspace_id: str) -> IMResult:
        return await self._request("GET", f"/api/im/workspace/{workspace_id}/agents")

    async def mention_autocomplete(self, conversation_id: str, query: Optional[str] = None) -> IMResult:
        params: Dict[str, Any] = {"conversationId": conversation_id}
        if query:
            params["q"] = query
        return await self._request("GET", "/api/im/workspace/mentions/autocomplete", params=params)


class AsyncTasksClient:
    """Async task management: create, list, claim, complete, fail."""

    def __init__(self, request_fn):
        self._request = request_fn

    async def create(self, title: str, **kwargs) -> IMResult:
        """Create a new task."""
        payload = {"title": title, **kwargs}
        return await self._request("POST", "/api/im/tasks", json=payload)

    async def list(
        self, *, status=None, capability=None, assignee_id=None, creator_id=None,
        schedule_type=None, limit=None, cursor=None,
    ) -> IMResult:
        """List tasks with optional filters."""
        params: Dict[str, Any] = {}
        if status:
            params["status"] = status
        if capability:
            params["capability"] = capability
        if assignee_id:
            params["assigneeId"] = assignee_id
        if creator_id:
            params["creatorId"] = creator_id
        if schedule_type:
            params["scheduleType"] = schedule_type
        if limit is not None:
            params["limit"] = limit
        if cursor:
            params["cursor"] = cursor
        return await self._request("GET", "/api/im/tasks", params=params)

    async def get(self, task_id: str) -> IMResult:
        """Get task details with logs."""
        return await self._request("GET", f"/api/im/tasks/{task_id}")

    async def update(self, task_id: str, **kwargs) -> IMResult:
        """Update a task (creator only)."""
        return await self._request("PATCH", f"/api/im/tasks/{task_id}", json=kwargs)

    async def claim(self, task_id: str) -> IMResult:
        """Claim a pending task."""
        return await self._request("POST", f"/api/im/tasks/{task_id}/claim")

    async def progress(self, task_id: str, *, message=None, metadata=None) -> IMResult:
        """Report task progress."""
        payload: Dict[str, Any] = {}
        if message:
            payload["message"] = message
        if metadata:
            payload["metadata"] = metadata
        return await self._request("POST", f"/api/im/tasks/{task_id}/progress", json=payload)

    async def complete(self, task_id: str, *, result=None, result_uri=None, cost=None) -> IMResult:
        """Mark task as completed."""
        payload: Dict[str, Any] = {}
        if result is not None:
            payload["result"] = result
        if result_uri:
            payload["resultUri"] = result_uri
        if cost is not None:
            payload["cost"] = cost
        return await self._request("POST", f"/api/im/tasks/{task_id}/complete", json=payload)

    async def fail(self, task_id: str, error: str, *, metadata=None) -> IMResult:
        """Mark task as failed."""
        payload: Dict[str, Any] = {"error": error}
        if metadata:
            payload["metadata"] = metadata
        return await self._request("POST", f"/api/im/tasks/{task_id}/fail", json=payload)


class AsyncMemoryClient:
    """Async memory management: files, compaction, session load."""

    def __init__(self, request_fn):
        self._request = request_fn

    async def create_file(self, path: str, content: str, *, scope=None, owner_type=None) -> IMResult:
        """Create or upsert a memory file."""
        payload: Dict[str, Any] = {"path": path, "content": content}
        if scope:
            payload["scope"] = scope
        if owner_type:
            payload["ownerType"] = owner_type
        return await self._request("POST", "/api/im/memory/files", json=payload)

    async def list_files(self, *, scope=None, path=None) -> IMResult:
        """List memory files (metadata only)."""
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        if path:
            params["path"] = path
        return await self._request("GET", "/api/im/memory/files", params=params)

    async def get_file(self, file_id: str) -> IMResult:
        """Read a memory file with content."""
        return await self._request("GET", f"/api/im/memory/files/{file_id}")

    async def update_file(
        self, file_id: str, operation: str, content: str, *, section=None, version=None,
    ) -> IMResult:
        """Update a memory file (append/replace/replace_section)."""
        payload: Dict[str, Any] = {"operation": operation, "content": content}
        if section:
            payload["section"] = section
        if version is not None:
            payload["version"] = version
        return await self._request("PATCH", f"/api/im/memory/files/{file_id}", json=payload)

    async def delete_file(self, file_id: str) -> IMResult:
        """Delete a memory file."""
        return await self._request("DELETE", f"/api/im/memory/files/{file_id}")

    async def compact(
        self, conversation_id: str, summary: str, *,
        message_range_start=None, message_range_end=None,
    ) -> IMResult:
        """Create a compaction summary."""
        payload: Dict[str, Any] = {"conversationId": conversation_id, "summary": summary}
        if message_range_start:
            payload["messageRangeStart"] = message_range_start
        if message_range_end:
            payload["messageRangeEnd"] = message_range_end
        return await self._request("POST", "/api/im/memory/compact", json=payload)

    async def get_compaction(self, conversation_id: str) -> IMResult:
        """Get compaction summaries for a conversation."""
        return await self._request("GET", f"/api/im/memory/compact/{conversation_id}")

    async def load(self, scope=None) -> IMResult:
        """Auto-load MEMORY.md session memory."""
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return await self._request("GET", "/api/im/memory/load", params=params)


class AsyncIdentityClient:
    """Async identity key management: Ed25519 keys, attestation, audit."""

    def __init__(self, request_fn):
        self._request = request_fn

    async def get_server_key(self) -> IMResult:
        """Get server's public Ed25519 key."""
        return await self._request("GET", "/api/im/keys/server")

    async def register_key(self, public_key: str, *, derivation_mode=None) -> IMResult:
        """Register or rotate identity key."""
        payload: Dict[str, Any] = {"publicKey": public_key}
        if derivation_mode:
            payload["derivationMode"] = derivation_mode
        return await self._request("PUT", "/api/im/keys/identity", json=payload)

    async def get_key(self, user_id: str) -> IMResult:
        """Get peer's identity key + attestation."""
        return await self._request("GET", f"/api/im/keys/identity/{user_id}")

    async def revoke_key(self) -> IMResult:
        """Revoke own identity key."""
        return await self._request("POST", "/api/im/keys/identity/revoke")

    async def get_audit_log(self, user_id: str) -> IMResult:
        """Get key audit log."""
        return await self._request("GET", f"/api/im/keys/audit/{user_id}")

    async def verify_audit_log(self, user_id: str) -> IMResult:
        """Verify audit log hash chain integrity."""
        return await self._request("GET", f"/api/im/keys/audit/{user_id}/verify")


class AsyncEvolutionClient:
    """Async Skill Evolution: gene management, analysis, recording, distillation."""

    def __init__(self, request_fn):
        self._request = request_fn

    # Public endpoints

    async def get_stats(self) -> IMResult:
        """Get public evolution statistics."""
        return await self._request("GET", "/api/im/evolution/public/stats")

    async def get_hot_genes(self, limit=None) -> IMResult:
        """Get hot/trending genes."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        return await self._request("GET", "/api/im/evolution/public/hot", params=params)

    async def browse_genes(
        self, *, category=None, search=None, sort=None, page=None, limit=None,
    ) -> IMResult:
        """Browse public gene catalog."""
        params: Dict[str, Any] = {}
        if category:
            params["category"] = category
        if search:
            params["search"] = search
        if sort:
            params["sort"] = sort
        if page is not None:
            params["page"] = page
        if limit is not None:
            params["limit"] = limit
        return await self._request("GET", "/api/im/evolution/public/genes", params=params)

    async def get_public_gene(self, gene_id: str) -> IMResult:
        """Get a public gene by ID."""
        return await self._request("GET", f"/api/im/evolution/public/genes/{gene_id}")

    async def get_gene_capsules(self, gene_id: str, limit=None) -> IMResult:
        """Get capsules for a public gene."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        return await self._request(
            "GET", f"/api/im/evolution/public/genes/{gene_id}/capsules", params=params,
        )

    async def get_gene_lineage(self, gene_id: str) -> IMResult:
        """Get lineage/fork tree for a gene."""
        return await self._request("GET", f"/api/im/evolution/public/genes/{gene_id}/lineage")

    async def get_feed(self, limit=None) -> IMResult:
        """Get public evolution feed."""
        params: Dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        return await self._request("GET", "/api/im/evolution/public/feed", params=params)

    # Authenticated endpoints

    async def analyze(self, *, scope: Optional[str] = None, **kwargs) -> IMResult:
        """Analyze signals for gene matching."""
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return await self._request("POST", "/api/im/evolution/analyze", json=kwargs, params=params or None)

    async def record(
        self, gene_id: str, signals: list, outcome: str, summary: str, *, scope: Optional[str] = None, **kwargs,
    ) -> IMResult:
        """Record an evolution capsule."""
        payload: Dict[str, Any] = {
            "gene_id": gene_id, "signals": signals, "outcome": outcome, "summary": summary, **kwargs,
        }
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return await self._request("POST", "/api/im/evolution/record", json=payload, params=params or None)

    async def evolve(self, *, outcome: str, score: Optional[float] = None, summary: Optional[str] = None,
                     strategy_used: Optional[list] = None, scope: Optional[str] = None, **analyze_kwargs) -> IMResult:
        """One-step evolution: analyze context → get gene → auto-record outcome."""
        analysis = await self.analyze(scope=scope, **analyze_kwargs)
        if not analysis.get("ok") or not analysis.get("data"):
            return analysis
        data = analysis["data"]
        gene_id = data.get("gene_id")
        if gene_id and data.get("action") in ("apply_gene", "explore"):
            signals = data.get("signals") or analyze_kwargs.get("signals", [])
            rec = await self.record(gene_id, signals, outcome,
                                    summary or f"{'Resolved' if outcome == 'success' else 'Failed'} using {gene_id}",
                                    score=score or (0.8 if outcome == "success" else 0.2),
                                    strategy_used=strategy_used, scope=scope)
            return {"ok": True, "data": {"analysis": data, "recorded": True, "edge_updated": rec.get("data", {}).get("edge_updated")}}
        return {"ok": True, "data": {"analysis": data, "recorded": False}}

    async def distill(self, dry_run=False) -> IMResult:
        """Distill capsules into gene updates."""
        params: Dict[str, Any] = {}
        if dry_run:
            params["dry_run"] = "true"
        return await self._request("POST", "/api/im/evolution/distill", params=params)

    async def list_genes(self, signals=None, scope: Optional[str] = None) -> IMResult:
        """List own genes, optionally filtered by signals."""
        params: Dict[str, Any] = {}
        if signals:
            params["signals"] = signals
        if scope:
            params["scope"] = scope
        return await self._request("GET", "/api/im/evolution/genes", params=params)

    async def create_gene(
        self, category: str, signals_match: list, strategy: list, *, scope: Optional[str] = None, **kwargs,
    ) -> IMResult:
        """Create a new gene."""
        payload: Dict[str, Any] = {
            "category": category, "signals_match": signals_match, "strategy": strategy, **kwargs,
        }
        params: Dict[str, Any] = {}
        if scope:
            params["scope"] = scope
        return await self._request("POST", "/api/im/evolution/genes", json=payload, params=params or None)

    async def delete_gene(self, gene_id: str) -> IMResult:
        """Delete a gene."""
        return await self._request("DELETE", f"/api/im/evolution/genes/{gene_id}")

    async def publish_gene(self, gene_id: str) -> IMResult:
        """Publish a gene to the public catalog."""
        return await self._request("POST", f"/api/im/evolution/genes/{gene_id}/publish")

    async def import_gene(self, gene_id: str) -> IMResult:
        """Import a public gene."""
        return await self._request(
            "POST", "/api/im/evolution/genes/import", json={"gene_id": gene_id},
        )

    async def fork_gene(self, gene_id: str, modifications=None) -> IMResult:
        """Fork a gene with optional modifications."""
        payload: Dict[str, Any] = {"gene_id": gene_id}
        if modifications:
            payload["modifications"] = modifications
        return await self._request("POST", "/api/im/evolution/genes/fork", json=payload)

    async def get_edges(self, *, signal_key=None, gene_id=None, limit=None, scope: Optional[str] = None) -> IMResult:
        """Get signal-gene edges."""
        params: Dict[str, Any] = {}
        if signal_key:
            params["signal_key"] = signal_key
        if gene_id:
            params["gene_id"] = gene_id
        if limit is not None:
            params["limit"] = limit
        if scope:
            params["scope"] = scope
        return await self._request("GET", "/api/im/evolution/edges", params=params)

    async def get_personality(self, agent_id: str) -> IMResult:
        """Get agent personality profile."""
        return await self._request("GET", f"/api/im/evolution/personality/{agent_id}")

    async def get_capsules(self, *, page=None, limit=None, scope: Optional[str] = None) -> IMResult:
        """Get own evolution capsules."""
        params: Dict[str, Any] = {}
        if page is not None:
            params["page"] = page
        if limit is not None:
            params["limit"] = limit
        if scope:
            params["scope"] = scope
        return await self._request("GET", "/api/im/evolution/capsules", params=params)

    async def get_report(self, agent_id=None, scope: Optional[str] = None) -> IMResult:
        """Get evolution report."""
        params: Dict[str, Any] = {}
        if agent_id:
            params["agent_id"] = agent_id
        if scope:
            params["scope"] = scope
        return await self._request("GET", "/api/im/evolution/report", params=params)

    async def list_scopes(self) -> IMResult:
        """List available evolution scopes."""
        return await self._request("GET", "/api/im/evolution/scopes")

    async def get_stories(self, limit=3, since=30) -> IMResult:
        return await self._request("GET", "/api/im/evolution/stories", params={"limit": limit, "since": since})

    async def get_metrics(self) -> IMResult:
        return await self._request("GET", "/api/im/evolution/metrics")

    async def collect_metrics(self, window_hours=1) -> IMResult:
        return await self._request("POST", "/api/im/evolution/metrics/collect", json={"window_hours": window_hours})

    async def search_skills(self, query=None, category=None, limit=None) -> IMResult:
        params: Dict[str, Any] = {}
        if query: params["query"] = query
        if category: params["category"] = category
        if limit is not None: params["limit"] = limit
        return await self._request("GET", "/api/im/skills/search", params=params)

    async def get_skill_stats(self) -> IMResult:
        return await self._request("GET", "/api/im/skills/stats")

    async def install_skill(self, slug_or_id: str) -> IMResult:
        """Install a skill — creates cloud record + Gene, returns content for local install."""
        return await self._request("POST", f"/api/im/skills/{_url_quote(slug_or_id, safe='')}/install")

    async def uninstall_skill(self, slug_or_id: str) -> IMResult:
        """Uninstall a skill."""
        return await self._request("DELETE", f"/api/im/skills/{_url_quote(slug_or_id, safe='')}/install")

    async def installed_skills(self) -> IMResult:
        """List installed skills for this agent."""
        return await self._request("GET", "/api/im/skills/installed")

    async def get_skill_content(self, slug_or_id: str) -> IMResult:
        """Get full skill content (SKILL.md + package info)."""
        return await self._request("GET", f"/api/im/skills/{_url_quote(slug_or_id, safe='')}/content")

    async def install_skill_local(self, slug_or_id: str, platforms: Optional[List[str]] = None, project: bool = False, project_root: Optional[str] = None) -> IMResult:
        """Install a skill and write SKILL.md to local filesystem.

        Combines cloud install + local file sync for Claude Code / OpenClaw / OpenCode / Plugin.

        Args:
            slug_or_id: Skill slug or ID
            platforms: Target platforms (default: all). Options: 'claude-code', 'openclaw', 'opencode', 'plugin'
            project: Write to project-level paths instead of global
            project_root: Project root directory (for project-level installs)
        """
        import os as _os
        from pathlib import Path

        result = await self.install_skill(slug_or_id)
        result.local_paths = []

        if not result.ok or not result.data:
            return result

        skill = result.data.get("skill", {})
        content = skill.get("content", "")
        slug = _safe_slug(skill.get("slug", slug_or_id))
        if not slug:
            return result

        if not content:
            content_result = await self.get_skill_content(slug_or_id)
            if content_result.ok and content_result.data:
                content = content_result.data.get("content", "")

        if not content:
            return result

        home = Path.home()
        plugin_dir = Path(_os.environ.get("PRISMER_PLUGIN_DIR", str(home / ".claude" / "plugins" / "prismer")))
        if project:
            root = Path(project_root) if project_root else Path.cwd()
            platform_paths = {
                "claude-code": root / ".claude" / "skills" / slug,
                "openclaw": root / "skills" / slug,
                "opencode": root / ".opencode" / "skills" / slug,
                "plugin": root / ".claude" / "plugins" / "prismer" / "skills" / slug,
            }
        else:
            platform_paths = {
                "claude-code": home / ".claude" / "skills" / slug,
                "openclaw": home / ".openclaw" / "skills" / slug,
                "opencode": home / ".config" / "opencode" / "skills" / slug,
                "plugin": plugin_dir / "skills" / slug,
            }

        targets = platforms or list(platform_paths.keys())
        local_paths = []

        for platform in targets:
            skill_dir = platform_paths.get(platform)
            if not skill_dir:
                continue
            try:
                skill_dir.mkdir(parents=True, exist_ok=True)
                file_path = skill_dir / "SKILL.md"
                file_path.write_text(content, encoding="utf-8")
                local_paths.append(str(file_path))
            except OSError:
                pass

        result.local_paths = local_paths
        return result

    async def uninstall_skill_local(self, slug_or_id: str) -> IMResult:
        """Uninstall a skill and remove local SKILL.md files."""
        import os as _os
        import shutil
        from pathlib import Path

        result = await self.uninstall_skill(slug_or_id)
        removed = []

        safe = _safe_slug(slug_or_id)
        if not safe:
            result.removed_paths = removed
            return result

        home = Path.home()
        plugin_dir = Path(_os.environ.get("PRISMER_PLUGIN_DIR", str(home / ".claude" / "plugins" / "prismer")))
        dirs = [
            home / ".claude" / "skills" / safe,
            home / ".openclaw" / "skills" / safe,
            home / ".config" / "opencode" / "skills" / safe,
            plugin_dir / "skills" / safe,
        ]

        for d in dirs:
            try:
                if d.exists():
                    shutil.rmtree(d)
                    removed.append(str(d))
            except OSError:
                pass

        result.removed_paths = removed
        return result

    async def sync_skills_local(self, platforms: Optional[List[str]] = None) -> dict:
        """Sync all installed skills to local filesystem."""
        import os as _os
        from pathlib import Path

        installed = await self.installed_skills()
        if not installed.ok or not installed.data:
            return {"synced": 0, "failed": 0, "paths": []}

        synced = 0
        failed = 0
        paths = []

        home = Path.home()
        plugin_dir = Path(_os.environ.get("PRISMER_PLUGIN_DIR", str(home / ".claude" / "plugins" / "prismer")))

        for record in installed.data:
            skill = record.get("skill", {})
            raw_slug = skill.get("slug") if skill else None
            if not raw_slug:
                failed += 1
                continue
            slug = _safe_slug(raw_slug)
            if not slug:
                failed += 1
                continue

            try:
                content_result = await self.get_skill_content(slug)
                content = content_result.data.get("content", "") if content_result.ok and content_result.data else ""
                if not content:
                    failed += 1
                    continue

                platform_paths = {
                    "claude-code": home / ".claude" / "skills" / slug,
                    "openclaw": home / ".openclaw" / "skills" / slug,
                    "opencode": home / ".config" / "opencode" / "skills" / slug,
                    "plugin": plugin_dir / "skills" / slug,
                }

                targets = platforms or list(platform_paths.keys())
                for platform in targets:
                    skill_dir = platform_paths.get(platform)
                    if not skill_dir:
                        continue
                    try:
                        skill_dir.mkdir(parents=True, exist_ok=True)
                        file_path = skill_dir / "SKILL.md"
                        file_path.write_text(content, encoding="utf-8")
                        paths.append(str(file_path))
                    except OSError:
                        pass
                synced += 1
            except Exception:
                failed += 1

        return {"synced": synced, "failed": failed, "paths": paths}

    # ─── P0: Report, Achievements, Sync ──────────────

    async def submit_report(self, raw_context: str, outcome: str, **kwargs) -> IMResult:
        """Submit a raw-context evolution report (auto-creates signals + gene match)."""
        payload: Dict[str, Any] = {"raw_context": raw_context, "outcome": outcome, **kwargs}
        return await self._request("POST", "/api/im/evolution/report", json=payload)

    async def get_report_status(self, trace_id: str) -> IMResult:
        """Get status of a submitted report by traceId."""
        return await self._request("GET", f"/api/im/evolution/report/{trace_id}")

    async def get_achievements(self) -> IMResult:
        """Get evolution achievements for the current agent."""
        return await self._request("GET", "/api/im/evolution/achievements")

    async def get_sync_snapshot(self, since: Optional[int] = None) -> IMResult:
        """Get a sync snapshot (global gene/edge state since a sequence number)."""
        params: Dict[str, Any] = {"scope": "global"}
        if since is not None:
            params["since"] = since
        return await self._request("GET", "/api/im/evolution/sync/snapshot", params=params)

    async def sync(self, push_outcomes: Optional[List] = None, pull_since: Optional[int] = None) -> IMResult:
        """Bidirectional sync: push local outcomes and pull remote updates."""
        payload: Dict[str, Any] = {}
        if push_outcomes:
            payload["push"] = {"outcomes": push_outcomes}
        if pull_since is not None:
            payload["pull"] = {"since": pull_since}
        return await self._request("POST", "/api/im/evolution/sync", json=payload)

    async def export_as_skill(self, gene_id: str, **kwargs) -> IMResult:
        """Export a Gene as a Skill."""
        return await self._request("POST", f"/api/im/evolution/genes/{gene_id}/export-skill", json=kwargs or None)


class AsyncSecurityClient:
    """Async conversation security: E2E encryption settings and key management."""

    def __init__(self, request_fn):
        self._request = request_fn

    async def get_conversation_security(self, conversation_id: str) -> IMResult:
        """Get conversation security settings."""
        return await self._request("GET", f"/api/im/conversations/{conversation_id}/security")

    async def set_conversation_security(self, conversation_id: str, **kwargs) -> IMResult:
        """Update conversation security settings (signingPolicy, encryptionMode)."""
        return await self._request("PATCH", f"/api/im/conversations/{conversation_id}/security", json=kwargs)

    async def upload_key(self, conversation_id: str, public_key: str, algorithm: Optional[str] = None) -> IMResult:
        """Upload a public key for a conversation."""
        payload: Dict[str, Any] = {"publicKey": public_key}
        if algorithm:
            payload["algorithm"] = algorithm
        return await self._request("POST", f"/api/im/conversations/{conversation_id}/keys", json=payload)

    async def get_keys(self, conversation_id: str) -> IMResult:
        """Get keys for a conversation."""
        return await self._request("GET", f"/api/im/conversations/{conversation_id}/keys")

    async def revoke_key(self, conversation_id: str, key_user_id: str) -> IMResult:
        """Revoke a key for a specific user in a conversation."""
        return await self._request("DELETE", f"/api/im/conversations/{conversation_id}/keys/{key_user_id}")


class AsyncFilesClient:
    def __init__(self, request_fn, base_url: str, get_auth_headers: Callable):
        self._request = request_fn
        self._base_url = base_url
        self._get_auth_headers = get_auth_headers

    async def presign(self, file_name: str, file_size: int, mime_type: str) -> IMResult:
        return await self._request("POST", "/api/im/files/presign", json={
            "fileName": file_name, "fileSize": file_size, "mimeType": mime_type,
        })

    async def confirm(self, upload_id: str) -> IMResult:
        return await self._request("POST", "/api/im/files/confirm", json={"uploadId": upload_id})

    async def quota(self) -> IMResult:
        return await self._request("GET", "/api/im/files/quota")

    async def delete(self, upload_id: str) -> IMResult:
        return await self._request("DELETE", f"/api/im/files/{upload_id}")

    async def types(self) -> IMResult:
        return await self._request("GET", "/api/im/files/types")

    async def init_multipart(self, file_name: str, file_size: int, mime_type: str) -> IMResult:
        return await self._request("POST", "/api/im/files/upload/init", json={
            "fileName": file_name, "fileSize": file_size, "mimeType": mime_type,
        })

    async def complete_multipart(self, upload_id: str, parts: List[Dict]) -> IMResult:
        return await self._request("POST", "/api/im/files/upload/complete", json={
            "uploadId": upload_id, "parts": parts,
        })

    async def upload(
        self,
        file: FileInput,
        *,
        file_name: Optional[str] = None,
        mime_type: Optional[str] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Dict[str, Any]:
        """Upload a file (full lifecycle: presign → upload → confirm)."""
        data, file_name = FilesClient._resolve_input(file, file_name)
        file_size = len(data)
        mime_type = mime_type or _guess_mime_type(file_name)

        if file_size > 50 * 1024 * 1024:
            raise ValueError("File exceeds maximum size of 50 MB")

        if file_size <= 10 * 1024 * 1024:
            return await self._upload_simple(data, file_name, file_size, mime_type, on_progress)
        return await self._upload_multipart(data, file_name, file_size, mime_type, on_progress)

    async def send_file(
        self,
        conversation_id: str,
        file: FileInput,
        *,
        content: Optional[str] = None,
        parent_id: Optional[str] = None,
        file_name: Optional[str] = None,
        mime_type: Optional[str] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> Dict[str, Any]:
        """Upload a file and send it as a message in one call."""
        uploaded = await self.upload(file, file_name=file_name, mime_type=mime_type, on_progress=on_progress)

        payload: Dict[str, Any] = {
            "content": content or uploaded["fileName"],
            "type": "file",
            "metadata": {
                "uploadId": uploaded["uploadId"],
                "fileUrl": uploaded["cdnUrl"],
                "fileName": uploaded["fileName"],
                "fileSize": uploaded["fileSize"],
                "mimeType": uploaded["mimeType"],
            },
        }
        if parent_id:
            payload["parentId"] = parent_id

        msg_res = await self._request("POST", f"/api/im/messages/{conversation_id}", json=payload)
        if not msg_res.get("ok"):
            raise RuntimeError(msg_res.get("error", {}).get("message", "Failed to send file message"))
        return {"upload": uploaded, "message": msg_res.get("data")}

    async def _upload_simple(self, data, file_name, file_size, mime_type, on_progress=None):
        res = await self.presign(file_name, file_size, mime_type)
        if not res.get("ok"):
            raise RuntimeError(res.get("error", {}).get("message", "Presign failed"))
        presign = res["data"]
        upload_id, url, fields = presign["uploadId"], presign["url"], presign.get("fields", {})

        is_s3 = url.startswith("http")
        upload_url = url if is_s3 else f"{self._base_url}{url}"

        files_param = {"file": (file_name, data, mime_type)}
        async with httpx.AsyncClient(timeout=60) as http:
            if is_s3:
                resp = await http.post(upload_url, data=fields, files=files_param)
            else:
                resp = await http.post(upload_url, files=files_param, headers=self._get_auth_headers())
            resp.raise_for_status()

        if on_progress:
            on_progress(file_size, file_size)

        confirm_res = await self.confirm(upload_id)
        if not confirm_res.get("ok"):
            raise RuntimeError(confirm_res.get("error", {}).get("message", "Confirm failed"))
        return confirm_res["data"]

    async def _upload_multipart(self, data, file_name, file_size, mime_type, on_progress=None):
        init_res = await self.init_multipart(file_name, file_size, mime_type)
        if not init_res.get("ok"):
            raise RuntimeError(init_res.get("error", {}).get("message", "Multipart init failed"))
        init = init_res["data"]
        upload_id, part_urls = init["uploadId"], init["parts"]

        chunk_size = 5 * 1024 * 1024
        completed: List[Dict] = []
        uploaded = 0

        async with httpx.AsyncClient(timeout=120) as http:
            for part in part_urls:
                start = (part["partNumber"] - 1) * chunk_size
                end = min(start + chunk_size, file_size)
                chunk = data[start:end]

                is_s3 = part["url"].startswith("http")
                part_url = part["url"] if is_s3 else f"{self._base_url}{part['url']}"
                headers = {"Content-Type": mime_type}
                if not is_s3:
                    headers.update(self._get_auth_headers())

                resp = await http.put(part_url, content=chunk, headers=headers)
                resp.raise_for_status()

                etag = resp.headers.get("ETag", f'"part-{part["partNumber"]}"')
                completed.append({"partNumber": part["partNumber"], "etag": etag})
                uploaded += len(chunk)
                if on_progress:
                    on_progress(uploaded, file_size)

        complete_res = await self.complete_multipart(upload_id, completed)
        if not complete_res.get("ok"):
            raise RuntimeError(complete_res.get("error", {}).get("message", "Multipart complete failed"))
        return complete_res["data"]


class AsyncIMRealtimeClient:
    """Async real-time connection factory (WebSocket & SSE)."""

    def __init__(self, base_url: str):
        self._base_url = base_url

    def ws_url(self, token: Optional[str] = None) -> str:
        base = self._base_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{base}/ws?token={token}" if token else f"{base}/ws"

    def sse_url(self, token: Optional[str] = None) -> str:
        return f"{self._base_url}/sse?token={token}" if token else f"{self._base_url}/sse"

    def connect_ws(self, config) -> "AsyncRealtimeWSClient":
        from .realtime import AsyncRealtimeWSClient
        return AsyncRealtimeWSClient(self._base_url, config)

    def connect_sse(self, config) -> "AsyncRealtimeSSEClient":
        from .realtime import AsyncRealtimeSSEClient
        return AsyncRealtimeSSEClient(self._base_url, config)


# ============================================================================
# IM Client (async) — orchestrates sub-modules
# ============================================================================

class AsyncIMClient:
    """Async IM API sub-client with sub-module access pattern. Access via ``client.im``."""

    def __init__(self, request_fn, base_url: str, get_auth_headers: Callable):
        self._request = request_fn
        self.account = AsyncAccountClient(request_fn)
        self.direct = AsyncDirectClient(request_fn)
        self.groups = AsyncGroupsClient(request_fn)
        self.conversations = AsyncConversationsClient(request_fn)
        self.messages = AsyncMessagesClient(request_fn)
        self.contacts = AsyncContactsClient(request_fn)
        self.bindings = AsyncBindingsClient(request_fn)
        self.credits = AsyncCreditsClient(request_fn)
        self.workspace = AsyncWorkspaceClient(request_fn)
        self.files = AsyncFilesClient(request_fn, base_url, get_auth_headers)
        self.tasks = AsyncTasksClient(request_fn)
        self.memory = AsyncMemoryClient(request_fn)
        self.identity = AsyncIdentityClient(request_fn)
        self.security = AsyncSecurityClient(request_fn)
        self.evolution = AsyncEvolutionClient(request_fn)
        self.realtime = AsyncIMRealtimeClient(base_url)

    async def health(self) -> IMResult:
        return await self._request("GET", "/api/im/health")


# ============================================================================
# Prismer Client (sync)
# ============================================================================

class PrismerClient:
    """
    Prismer Cloud API Client.

    Example::

        client = PrismerClient(api_key="sk-prismer-...")

        # Context API
        result = client.load("https://example.com")

        # Parse API
        pdf = client.parse_pdf("https://arxiv.org/pdf/2401.00001.pdf")

        # IM API (sub-module pattern)
        reg = client.im.account.register(type="agent", username="my-agent", displayName="My Agent")
        client.im.direct.send("user-123", "Hello!")
        groups = client.im.groups.list()
        conversations = client.im.conversations.list()
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        environment: str = "production",
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        im_agent: Optional[str] = None,
    ):
        if api_key and not api_key.startswith("sk-prismer-") and not api_key.startswith("eyJ"):
            import warnings
            warnings.warn('API key should start with "sk-prismer-" (or "eyJ" for IM JWT)')

        self._api_key = api_key or ""
        self._im_agent = im_agent
        env_url = ENVIRONMENTS.get(environment, ENVIRONMENTS["production"])
        self._base_url = (base_url or env_url).rstrip("/")

        headers: Dict[str, str] = {
            "Content-Type": "application/json",
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if im_agent:
            headers["X-IM-Agent"] = im_agent

        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            headers=headers,
        )

        self.im = IMClient(self._request, self._base_url, self._get_auth_headers)

    def _get_auth_headers(self) -> Dict[str, str]:
        """Build auth headers for raw HTTP requests (used by file upload)."""
        headers: Dict[str, str] = {}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if self._im_agent:
            headers["X-IM-Agent"] = self._im_agent
        return headers

    def set_token(self, token: str) -> None:
        """Set or update the auth token (API key or IM JWT).
        Useful after anonymous registration to set the returned JWT."""
        self._api_key = token
        self._client.headers["Authorization"] = f"Bearer {token}"

    def __enter__(self) -> "PrismerClient":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Any] = None,
        params: Optional[Dict[str, Any]] = None,
    ):
        try:
            response = self._client.request(method, path, json=json, params=params)
            data = response.json()
            if not response.is_success:
                err = data.get("error", {"code": "HTTP_ERROR", "message": f"HTTP {response.status_code}"})
                data.setdefault("success", False)
                data.setdefault("ok", False)
                data["error"] = err
            return data
        except httpx.TimeoutException:
            return {"success": False, "ok": False, "error": {"code": "TIMEOUT", "message": "Request timed out"}}
        except Exception as e:
            return {"success": False, "ok": False, "error": {"code": "NETWORK_ERROR", "message": str(e)}}

    # --------------------------------------------------------------------------
    # Context API
    # --------------------------------------------------------------------------

    def load(
        self,
        input: Union[str, List[str]],
        *,
        input_type: Optional[str] = None,
        process_uncached: bool = False,
        search: Optional[Dict[str, Any]] = None,
        processing: Optional[Dict[str, Any]] = None,
        return_config: Optional[Dict[str, Any]] = None,
        ranking: Optional[Dict[str, Any]] = None,
    ) -> LoadResult:
        """Load content from URL(s) or search query."""
        payload: Dict[str, Any] = {"input": input}
        if input_type:
            payload["inputType"] = input_type
        if process_uncached:
            payload["processUncached"] = process_uncached
        if search:
            payload["search"] = search
        if processing:
            payload["processing"] = processing
        if return_config:
            payload["return"] = return_config
        if ranking:
            payload["ranking"] = ranking
        data = self._request("POST", "/api/context/load", json=payload)
        return LoadResult(**data)

    def save(
        self,
        url: Optional[str] = None,
        hqcc: Optional[str] = None,
        raw: Optional[str] = None,
        visibility: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
        *,
        items: Optional[List[Dict[str, Any]]] = None,
    ) -> SaveResult:
        """Save content to Prismer cache.

        Args:
            visibility: 'public' | 'private' | 'unlisted' (default: 'private')
        """
        if items is not None:
            payload: Dict[str, Any] = {"items": items}
        else:
            if not url or not hqcc:
                return SaveResult(
                    success=False,
                    error=PrismerError(code="INVALID_INPUT", message="url and hqcc are required for single save"),
                )
            payload = {"url": url, "hqcc": hqcc}
            if raw:
                payload["raw"] = raw
            if visibility:
                payload["visibility"] = visibility
            if meta:
                payload["meta"] = meta
        data = self._request("POST", "/api/context/save", json=payload)
        return SaveResult(**data)

    def save_batch(self, items: List[Dict[str, Any]]) -> SaveResult:
        """Batch save multiple items (max 50)."""
        return self.save(items=items)

    # --------------------------------------------------------------------------
    # Parse API
    # --------------------------------------------------------------------------

    def parse(
        self,
        *,
        url: Optional[str] = None,
        base64: Optional[str] = None,
        filename: Optional[str] = None,
        mode: str = "fast",
        output: str = "markdown",
        image_mode: Optional[str] = None,
        wait: Optional[bool] = None,
    ) -> ParseResult:
        """Parse a document (PDF, image) into structured content."""
        payload: Dict[str, Any] = {"mode": mode, "output": output}
        if url:
            payload["url"] = url
        if base64:
            payload["base64"] = base64
        if filename:
            payload["filename"] = filename
        if image_mode:
            payload["image_mode"] = image_mode
        if wait is not None:
            payload["wait"] = wait
        data = self._request("POST", "/api/parse", json=payload)
        return ParseResult(**data)

    def parse_pdf(self, url: str, mode: str = "fast") -> ParseResult:
        """Convenience: parse a PDF by URL."""
        return self.parse(url=url, mode=mode)

    def parse_status(self, task_id: str) -> ParseResult:
        """Check status of an async parse task."""
        data = self._request("GET", f"/api/parse/status/{task_id}")
        return ParseResult(**data)

    def parse_result(self, task_id: str) -> ParseResult:
        """Get result of a completed async parse task."""
        data = self._request("GET", f"/api/parse/result/{task_id}")
        return ParseResult(**data)

    # --------------------------------------------------------------------------
    # Convenience
    # --------------------------------------------------------------------------

    def search(
        self,
        query: str,
        *,
        top_k: Optional[int] = None,
        return_top_k: Optional[int] = None,
        format: Optional[str] = None,
        ranking: Optional[str] = None,
    ) -> LoadResult:
        """Search for content (convenience wrapper around load with query mode)."""
        return self.load(
            query,
            input_type="query",
            search={"topK": top_k} if top_k else None,
            return_config={"topK": return_top_k, "format": format}
            if (return_top_k or format)
            else None,
            ranking={"preset": ranking} if ranking else None,
        )


# ============================================================================
# Async Prismer Client
# ============================================================================

class AsyncPrismerClient:
    """
    Async Prismer Cloud API Client.

    Example::

        async with AsyncPrismerClient(api_key="sk-prismer-...") as client:
            result = await client.load("https://example.com")
            await client.im.direct.send("user-123", "Hello!")

        # With offline-first mode:
        from prismer.offline import MemoryStorage, OfflineConfig
        async with AsyncPrismerClient(
            api_key="...",
            offline={"storage": MemoryStorage()},
        ) as client:
            await client.init_offline()
            await client.im.direct.send("user-123", "Hello!")  # goes through outbox
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        environment: str = "production",
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        im_agent: Optional[str] = None,
        offline: Optional[Dict[str, Any]] = None,
    ):
        self._api_key = api_key or ""
        self._im_agent = im_agent
        self._offline_config = offline
        env_url = ENVIRONMENTS.get(environment, ENVIRONMENTS["production"])
        self._base_url = (base_url or env_url).rstrip("/")

        headers: Dict[str, str] = {
            "Content-Type": "application/json",
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if im_agent:
            headers["X-IM-Agent"] = im_agent

        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=timeout,
            headers=headers,
        )

        # Offline manager (initialized lazily via init_offline())
        self._offline_manager = None

        # If offline config is provided, create IM client with offline dispatch
        self.im = AsyncIMClient(self._request, self._base_url, self._get_auth_headers)

    def _get_auth_headers(self) -> Dict[str, str]:
        """Build auth headers for raw HTTP requests (used by file upload)."""
        headers: Dict[str, str] = {}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if self._im_agent:
            headers["X-IM-Agent"] = self._im_agent
        return headers

    def set_token(self, token: str) -> None:
        """Set or update the auth token (API key or IM JWT)."""
        self._api_key = token
        self._client.headers["Authorization"] = f"Bearer {token}"

    async def init_offline(self) -> "OfflineManager":
        """Initialize offline-first mode. Must be called after construction if offline config is set.

        Returns the OfflineManager instance for event subscription and direct access.
        """
        if not self._offline_config:
            raise RuntimeError("No offline config provided. Pass offline={...} to constructor.")

        from .offline import OfflineManager, OfflineConfig as OC

        storage = self._offline_config.get("storage")
        if not storage:
            raise RuntimeError("offline.storage is required (e.g., MemoryStorage())")

        config = OC(
            sync_on_connect=self._offline_config.get("sync_on_connect", True),
            outbox_retry_limit=self._offline_config.get("outbox_retry_limit", 5),
            outbox_flush_interval=self._offline_config.get("outbox_flush_interval", 1.0),
            conflict_strategy=self._offline_config.get("conflict_strategy", "server"),
        )

        self._offline_manager = OfflineManager(storage, self._request, config)
        await self._offline_manager.init()

        # Rewire IM client to use offline dispatch for write operations
        self.im = AsyncIMClient(self._offline_dispatch, self._base_url, self._get_auth_headers)

        return self._offline_manager

    @property
    def offline(self) -> Optional["OfflineManager"]:
        """Access the offline manager (None if not initialized)."""
        return self._offline_manager

    async def _offline_dispatch(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Any] = None,
        params: Optional[Dict[str, Any]] = None,
    ):
        """Route requests through offline manager when available."""
        if self._offline_manager:
            return await self._offline_manager.dispatch(method, path, json, params)
        return await self._request(method, path, json=json, params=params)

    async def __aenter__(self) -> "AsyncPrismerClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        if self._offline_manager:
            await self._offline_manager.destroy()
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Optional[Any] = None,
        params: Optional[Dict[str, Any]] = None,
    ):
        try:
            response = await self._client.request(method, path, json=json, params=params)
            data = response.json()
            if not response.is_success:
                err = data.get("error", {"code": "HTTP_ERROR", "message": f"HTTP {response.status_code}"})
                data.setdefault("success", False)
                data.setdefault("ok", False)
                data["error"] = err
            return data
        except httpx.TimeoutException:
            return {"success": False, "ok": False, "error": {"code": "TIMEOUT", "message": "Request timed out"}}
        except Exception as e:
            return {"success": False, "ok": False, "error": {"code": "NETWORK_ERROR", "message": str(e)}}

    # --- Context API ---

    async def load(
        self,
        input: Union[str, List[str]],
        *,
        input_type: Optional[str] = None,
        process_uncached: bool = False,
        search: Optional[Dict[str, Any]] = None,
        processing: Optional[Dict[str, Any]] = None,
        return_config: Optional[Dict[str, Any]] = None,
        ranking: Optional[Dict[str, Any]] = None,
    ) -> LoadResult:
        payload: Dict[str, Any] = {"input": input}
        if input_type:
            payload["inputType"] = input_type
        if process_uncached:
            payload["processUncached"] = process_uncached
        if search:
            payload["search"] = search
        if processing:
            payload["processing"] = processing
        if return_config:
            payload["return"] = return_config
        if ranking:
            payload["ranking"] = ranking
        data = await self._request("POST", "/api/context/load", json=payload)
        return LoadResult(**data)

    async def save(
        self,
        url: Optional[str] = None,
        hqcc: Optional[str] = None,
        raw: Optional[str] = None,
        visibility: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
        *,
        items: Optional[List[Dict[str, Any]]] = None,
    ) -> SaveResult:
        if items is not None:
            payload: Dict[str, Any] = {"items": items}
        else:
            if not url or not hqcc:
                return SaveResult(
                    success=False,
                    error=PrismerError(code="INVALID_INPUT", message="url and hqcc are required"),
                )
            payload = {"url": url, "hqcc": hqcc}
            if raw:
                payload["raw"] = raw
            if visibility:
                payload["visibility"] = visibility
            if meta:
                payload["meta"] = meta
        data = await self._request("POST", "/api/context/save", json=payload)
        return SaveResult(**data)

    async def save_batch(self, items: List[Dict[str, Any]]) -> SaveResult:
        return await self.save(items=items)

    # --- Parse API ---

    async def parse(
        self,
        *,
        url: Optional[str] = None,
        base64: Optional[str] = None,
        filename: Optional[str] = None,
        mode: str = "fast",
        output: str = "markdown",
        image_mode: Optional[str] = None,
        wait: Optional[bool] = None,
    ) -> ParseResult:
        payload: Dict[str, Any] = {"mode": mode, "output": output}
        if url:
            payload["url"] = url
        if base64:
            payload["base64"] = base64
        if filename:
            payload["filename"] = filename
        if image_mode:
            payload["image_mode"] = image_mode
        if wait is not None:
            payload["wait"] = wait
        data = await self._request("POST", "/api/parse", json=payload)
        return ParseResult(**data)

    async def parse_pdf(self, url: str, mode: str = "fast") -> ParseResult:
        return await self.parse(url=url, mode=mode)

    async def parse_status(self, task_id: str) -> ParseResult:
        data = await self._request("GET", f"/api/parse/status/{task_id}")
        return ParseResult(**data)

    async def parse_result(self, task_id: str) -> ParseResult:
        data = await self._request("GET", f"/api/parse/result/{task_id}")
        return ParseResult(**data)

    # --- Convenience ---

    async def search(
        self,
        query: str,
        *,
        top_k: Optional[int] = None,
        return_top_k: Optional[int] = None,
        format: Optional[str] = None,
        ranking: Optional[str] = None,
    ) -> LoadResult:
        return await self.load(
            query,
            input_type="query",
            search={"topK": top_k} if top_k else None,
            return_config={"topK": return_top_k, "format": format}
            if (return_top_k or format)
            else None,
            ranking={"preset": ranking} if ranking else None,
        )

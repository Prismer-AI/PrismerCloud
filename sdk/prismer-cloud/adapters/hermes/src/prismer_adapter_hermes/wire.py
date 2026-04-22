# AUTO-GENERATED FROM @prismer/wire — DO NOT EDIT.
# Regenerate by running `npm run codegen` in sdk/prismer-cloud/wire/
# which will automatically sync this file.
#
# Python 3.10+ compat: quicktype emits bare Any fields without defaults
# between Optional fields, which Python 3.10+ rejects. The field(default=None)
# patch below resolves this at sync time.
# WIRE_SCHEMA_SHA256 = "bfba163a5f5462c1"

from dataclasses import dataclass, field
from enum import Enum

from typing import List, Optional, Any, Union, Dict, TypeVar, Callable, Type, cast


T = TypeVar("T")
EnumT = TypeVar("EnumT", bound=Enum)


def from_str(x: Any) -> str:
    assert isinstance(x, str)
    return x


def from_list(f: Callable[[Any], T], x: Any) -> List[T]:
    assert isinstance(x, list)
    return [f(y) for y in x]


def from_int(x: Any) -> int:
    assert isinstance(x, int) and not isinstance(x, bool)
    return x


def from_none(x: Any) -> Any:
    assert x is None
    return x


def from_union(fs, x):
    for f in fs:
        try:
            return f(x)
        except:
            pass
    assert False


def to_enum(c: Type[EnumT], x: Any) -> EnumT:
    assert isinstance(x, c)
    return x.value


def from_bool(x: Any) -> bool:
    assert isinstance(x, bool)
    return x


def from_float(x: Any) -> float:
    assert isinstance(x, (float, int)) and not isinstance(x, bool)
    return float(x)


def from_dict(f: Callable[[Any], T], x: Any) -> Dict[str, T]:
    assert isinstance(x, dict)
    return { k: f(v) for (k, v) in x.items() }


def to_class(c: Type[T], x: Any) -> dict:
    assert isinstance(x, c)
    return cast(Any, x).to_dict()


def to_float(x: Any) -> float:
    assert isinstance(x, (int, float))
    return x


class Action(Enum):
    ACCEPT = "accept"
    CANCEL = "cancel"
    DECLINE = "decline"


@dataclass
class Agent:
    adapter: str
    capability_tags: List[str]
    id: str
    tiers_supported: List[int]
    version: str
    workspace: str
    workspace_group: Optional[str] = None

    @staticmethod
    def from_dict(obj: Any) -> 'Agent':
        assert isinstance(obj, dict)
        adapter = from_str(obj.get("adapter"))
        capability_tags = from_list(from_str, obj.get("capabilityTags"))
        id = from_str(obj.get("id"))
        tiers_supported = from_list(from_int, obj.get("tiersSupported"))
        version = from_str(obj.get("version"))
        workspace = from_str(obj.get("workspace"))
        workspace_group = from_union([from_str, from_none], obj.get("workspaceGroup"))
        return Agent(adapter=adapter, capability_tags=capability_tags, id=id, tiers_supported=tiers_supported, version=version, workspace=workspace, workspace_group=workspace_group)

    def to_dict(self) -> dict:
        result: dict = {}
        result["adapter"] = from_str(self.adapter)
        result["capabilityTags"] = from_list(from_str, self.capability_tags)
        result["id"] = from_str(self.id)
        result["tiersSupported"] = from_list(from_int, self.tiers_supported)
        result["version"] = from_str(self.version)
        result["workspace"] = from_str(self.workspace)
        if self.workspace_group is not None:
            result["workspaceGroup"] = from_union([from_str, from_none], self.workspace_group)
        return result


class Author(Enum):
    AGENT = "agent"
    USER = "user"


class By(Enum):
    LOCAL = "local"
    REMOTE = "remote"


class ChangeType(Enum):
    ADD = "add"
    MODIFY = "modify"
    REMOVE = "remove"


class CommandKind(Enum):
    NEW = "new"
    OTHER = "other"
    RESET = "reset"
    STOP = "stop"


class ConfigSource(Enum):
    LOCAL_SETTINGS = "local_settings"
    POLICY_SETTINGS = "policy_settings"
    PROJECT_SETTINGS = "project_settings"
    SKILLS = "skills"
    USER_SETTINGS = "user_settings"


class Decision(Enum):
    ALLOW = "allow"
    ASK = "ask"
    DEFER = "defer"
    DENY = "deny"


class ErrorType(Enum):
    AUTH = "auth"
    BILLING = "billing"
    INVALID = "invalid"
    MAX_TOKENS = "max_tokens"
    RATE_LIMIT = "rate_limit"
    SERVER = "server"
    UNKNOWN = "unknown"


class LoadReason(Enum):
    COMPACT = "compact"
    INCLUDE = "include"
    NESTED_TRAVERSAL = "nested_traversal"
    PATH_GLOB_MATCH = "path_glob_match"
    SESSION_START = "session_start"


class NotificationType(Enum):
    AUTH_SUCCESS = "auth_success"
    ELICITATION_DIALOG = "elicitation_dialog"
    IDLE_PROMPT = "idle_prompt"
    OTHER = "other"
    PERMISSION_PROMPT = "permission_prompt"


class Op(Enum):
    DELETE = "delete"
    EXEC = "exec"
    READ = "read"
    WRITE = "write"


class RiskTag(Enum):
    HIGH = "high"
    LOW = "low"
    MID = "mid"


class Role(Enum):
    AGENT = "agent"
    SYSTEM = "system"
    USER = "user"


class Kind(Enum):
    BUNDLED = "bundled"
    PLUGIN = "plugin"
    PROJECT = "project"
    REGISTRY = "registry"
    USER = "user"
    WORKSPACE = "workspace"


class Registry(Enum):
    CLAWHUB = "clawhub"
    GITHUB = "github"
    HERMES_OFFICIAL = "hermes-official"
    PRISMER = "prismer"
    SKILLS_SH = "skills-sh"
    WELL_KNOWN = "well-known"


@dataclass
class SourceClass:
    kind: Kind
    workspace: Optional[str] = None
    plugin_name: Optional[str] = None
    adapter: Optional[str] = None
    ref: Optional[str] = None
    registry: Optional[Registry] = None

    @staticmethod
    def from_dict(obj: Any) -> 'SourceClass':
        assert isinstance(obj, dict)
        kind = Kind(obj.get("kind"))
        workspace = from_union([from_str, from_none], obj.get("workspace"))
        plugin_name = from_union([from_str, from_none], obj.get("pluginName"))
        adapter = from_union([from_str, from_none], obj.get("adapter"))
        ref = from_union([from_str, from_none], obj.get("ref"))
        registry = from_union([Registry, from_none], obj.get("registry"))
        return SourceClass(kind=kind, workspace=workspace, plugin_name=plugin_name, adapter=adapter, ref=ref, registry=registry)

    def to_dict(self) -> dict:
        result: dict = {}
        result["kind"] = to_enum(Kind, self.kind)
        if self.workspace is not None:
            result["workspace"] = from_union([from_str, from_none], self.workspace)
        if self.plugin_name is not None:
            result["pluginName"] = from_union([from_str, from_none], self.plugin_name)
        if self.adapter is not None:
            result["adapter"] = from_union([from_str, from_none], self.adapter)
        if self.ref is not None:
            result["ref"] = from_union([from_str, from_none], self.ref)
        if self.registry is not None:
            result["registry"] = from_union([lambda x: to_enum(Registry, x), from_none], self.registry)
        return result


class Status(Enum):
    AWAITING_APPROVAL = "awaiting_approval"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    ERROR = "error"
    FAILED = "failed"
    IDLE = "idle"
    THINKING = "thinking"
    TOOL = "tool"


class Trigger(Enum):
    AUTO = "auto"
    AUTO_MATCH = "auto-match"
    MANUAL = "manual"
    MODEL_INVOKE = "model-invoke"
    USER_INVOKE = "user-invoke"


class TypeEnum(Enum):
    AGENT_APPROVAL_DENIED = "agent.approval.denied"
    AGENT_APPROVAL_REQUEST = "agent.approval.request"
    AGENT_APPROVAL_RESULT = "agent.approval.result"
    AGENT_BOOTSTRAP_INJECTED = "agent.bootstrap.injected"
    AGENT_CHANNEL_INBOUND = "agent.channel.inbound"
    AGENT_CHANNEL_OUTBOUND_SENT = "agent.channel.outbound.sent"
    AGENT_CHANNEL_PREPROCESSED = "agent.channel.preprocessed"
    AGENT_CHANNEL_TRANSCRIBED = "agent.channel.transcribed"
    AGENT_COMMAND = "agent.command"
    AGENT_COMPACT_POST = "agent.compact.post"
    AGENT_COMPACT_PRE = "agent.compact.pre"
    AGENT_CONFIG_CHANGED = "agent.config.changed"
    AGENT_CWD_CHANGED = "agent.cwd.changed"
    AGENT_ELICITATION_REQUEST = "agent.elicitation.request"
    AGENT_ELICITATION_RESULT = "agent.elicitation.result"
    AGENT_FILE_WATCHED = "agent.file.watched"
    AGENT_FS_OP = "agent.fs.op"
    AGENT_INSTRUCTIONS_LOADED = "agent.instructions.loaded"
    AGENT_LLM_POST = "agent.llm.post"
    AGENT_LLM_PRE = "agent.llm.pre"
    AGENT_MESSAGE = "agent.message"
    AGENT_NOTIFICATION = "agent.notification"
    AGENT_PROMPT_SUBMIT = "agent.prompt.submit"
    AGENT_REGISTER = "agent.register"
    AGENT_SESSION_ENDED = "agent.session.ended"
    AGENT_SESSION_RESET = "agent.session.reset"
    AGENT_SESSION_STARTED = "agent.session.started"
    AGENT_SKILL_ACTIVATED = "agent.skill.activated"
    AGENT_SKILL_DEACTIVATED = "agent.skill.deactivated"
    AGENT_SKILL_INSTALLED = "agent.skill.installed"
    AGENT_SKILL_PROPOSED = "agent.skill.proposed"
    AGENT_SKILL_UNINSTALLED = "agent.skill.uninstalled"
    AGENT_STATE = "agent.state"
    AGENT_SUBAGENT_ENDED = "agent.subagent.ended"
    AGENT_SUBAGENT_STARTED = "agent.subagent.started"
    AGENT_TASK_COMPLETED = "agent.task.completed"
    AGENT_TASK_CREATED = "agent.task.created"
    AGENT_TEAMMATE_IDLE = "agent.teammate.idle"
    AGENT_TIERS_UPDATE = "agent.tiers.update"
    AGENT_TOOL_FAILURE = "agent.tool.failure"
    AGENT_TOOL_POST = "agent.tool.post"
    AGENT_TOOL_PRE = "agent.tool.pre"
    AGENT_TURN_END = "agent.turn.end"
    AGENT_TURN_FAILURE = "agent.turn.failure"
    AGENT_TURN_STEP = "agent.turn.step"
    AGENT_WORKTREE_CREATED = "agent.worktree.created"
    AGENT_WORKTREE_REMOVED = "agent.worktree.removed"


@dataclass
class PrismerWire:
    """Prismer Agent Runtime ABI (PARA) v0.1 wire protocol schemas"""

    type: TypeEnum
    agent: Optional[Agent] = None
    parent_session_id: Optional[str] = None
    scope: Optional[str] = None
    session_id: Optional[str] = None
    reason: Optional[str] = None
    agent_id: Optional[str] = None
    parent_agent_id: Optional[str] = None
    subagent_type: Optional[str] = None
    transcript_path: Optional[str] = None
    status: Optional[Status] = None
    tiers_added: Optional[List[int]] = None
    tiers_removed: Optional[List[int]] = None
    prompt: Optional[str] = None
    source: Optional[Union[SourceClass, str]] = None
    conversation_length: Optional[int] = None
    is_first_turn: Optional[bool] = None
    model: Optional[str] = None
    stop_reason: Optional[str] = None
    tokens_used: Optional[int] = None
    iteration: Optional[int] = None
    tool_names: Optional[List[str]] = None
    last_assistant_message: Optional[str] = None
    error_message: Optional[str] = None
    error_type: Optional[ErrorType] = None
    content: Any = field(default=None)
    role: Optional[Role] = None
    ts: Optional[float] = None
    channel_id: Optional[str] = None
    prismer_wire_from: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    success: Optional[bool] = None
    to: Optional[str] = None
    media_path: Optional[str] = None
    transcript: Optional[str] = None
    body_for_agent: Optional[str] = None
    args: Any = field(default=None)
    call_id: Optional[str] = None
    risk_tag: Optional[RiskTag] = None
    tool: Optional[str] = None
    duration_ms: Optional[float] = None
    ok: Optional[bool] = None
    summary: Optional[str] = None
    updated_mcp_tool_output: Any = field(default=None)
    error: Optional[str] = None
    is_interrupt: Optional[bool] = None
    signal_pattern: Optional[str] = None
    form_schema: Any = field(default=None)
    request_id: Optional[str] = None
    server_name: Optional[str] = None
    action: Optional[Action] = None
    permission_suggestions: Optional[List[Any]] = None
    ttl_ms: Optional[int] = None
    by: Optional[By] = None
    decision: Optional[Decision] = None
    updated_input: Any = field(default=None)
    updated_permissions: Optional[List[Any]] = None
    retry: Optional[bool] = None
    description: Optional[str] = None
    subject: Optional[str] = None
    task_id: Optional[str] = None
    teammate_name: Optional[str] = None
    team_name: Optional[str] = None
    command: Optional[str] = None
    command_kind: Optional[CommandKind] = None
    message_count: Optional[int] = None
    token_count: Optional[int] = None
    trigger: Optional[Trigger] = None
    compacted_count: Optional[int] = None
    tokens_after: Optional[int] = None
    tokens_before: Optional[int] = None
    file_path: Optional[str] = None
    load_reason: Optional[LoadReason] = None
    memory_type: Optional[str] = None
    bootstrap_files: Optional[List[str]] = None
    bytes: Optional[int] = None
    op: Optional[Op] = None
    path: Optional[str] = None
    change_type: Optional[ChangeType] = None
    new_cwd: Optional[str] = None
    old_cwd: Optional[str] = None
    changed_values: Any = field(default=None)
    config_source: Optional[ConfigSource] = None
    branch: Optional[str] = None
    worktree_path: Optional[str] = None
    message: Optional[str] = None
    notification_type: Optional[NotificationType] = None
    title: Optional[str] = None
    skill_name: Optional[str] = None
    author: Optional[Author] = None
    draft_path: Optional[str] = None
    name: Optional[str] = None
    sha256: Optional[str] = None
    version: Optional[str] = None

    @staticmethod
    def from_dict(obj: Any) -> 'PrismerWire':
        assert isinstance(obj, dict)
        type = TypeEnum(obj.get("type"))
        agent = from_union([Agent.from_dict, from_none], obj.get("agent"))
        parent_session_id = from_union([from_str, from_none], obj.get("parentSessionId"))
        scope = from_union([from_str, from_none], obj.get("scope"))
        session_id = from_union([from_str, from_none], obj.get("sessionId"))
        reason = from_union([from_str, from_none], obj.get("reason"))
        agent_id = from_union([from_str, from_none], obj.get("agentId"))
        parent_agent_id = from_union([from_str, from_none], obj.get("parentAgentId"))
        subagent_type = from_union([from_str, from_none], obj.get("subagentType"))
        transcript_path = from_union([from_str, from_none], obj.get("transcriptPath"))
        status = from_union([Status, from_none], obj.get("status"))
        tiers_added = from_union([lambda x: from_list(from_int, x), from_none], obj.get("tiersAdded"))
        tiers_removed = from_union([lambda x: from_list(from_int, x), from_none], obj.get("tiersRemoved"))
        prompt = from_union([from_str, from_none], obj.get("prompt"))
        source = from_union([SourceClass.from_dict, from_str, from_none], obj.get("source"))
        conversation_length = from_union([from_int, from_none], obj.get("conversationLength"))
        is_first_turn = from_union([from_bool, from_none], obj.get("isFirstTurn"))
        model = from_union([from_str, from_none], obj.get("model"))
        stop_reason = from_union([from_str, from_none], obj.get("stopReason"))
        tokens_used = from_union([from_int, from_none], obj.get("tokensUsed"))
        iteration = from_union([from_int, from_none], obj.get("iteration"))
        tool_names = from_union([lambda x: from_list(from_str, x), from_none], obj.get("toolNames"))
        last_assistant_message = from_union([from_str, from_none], obj.get("lastAssistantMessage"))
        error_message = from_union([from_str, from_none], obj.get("errorMessage"))
        error_type = from_union([ErrorType, from_none], obj.get("errorType"))
        content = obj.get("content")
        role = from_union([Role, from_none], obj.get("role"))
        ts = from_union([from_float, from_none], obj.get("ts"))
        channel_id = from_union([from_str, from_none], obj.get("channelId"))
        prismer_wire_from = from_union([from_str, from_none], obj.get("from"))
        metadata = from_union([lambda x: from_dict(lambda x: x, x), from_none], obj.get("metadata"))
        success = from_union([from_bool, from_none], obj.get("success"))
        to = from_union([from_str, from_none], obj.get("to"))
        media_path = from_union([from_str, from_none], obj.get("mediaPath"))
        transcript = from_union([from_str, from_none], obj.get("transcript"))
        body_for_agent = from_union([from_str, from_none], obj.get("bodyForAgent"))
        args = obj.get("args")
        call_id = from_union([from_str, from_none], obj.get("callId"))
        risk_tag = from_union([RiskTag, from_none], obj.get("riskTag"))
        tool = from_union([from_str, from_none], obj.get("tool"))
        duration_ms = from_union([from_float, from_none], obj.get("durationMs"))
        ok = from_union([from_bool, from_none], obj.get("ok"))
        summary = from_union([from_str, from_none], obj.get("summary"))
        updated_mcp_tool_output = obj.get("updatedMCPToolOutput")
        error = from_union([from_str, from_none], obj.get("error"))
        is_interrupt = from_union([from_bool, from_none], obj.get("isInterrupt"))
        signal_pattern = from_union([from_str, from_none], obj.get("signalPattern"))
        form_schema = obj.get("formSchema")
        request_id = from_union([from_str, from_none], obj.get("requestId"))
        server_name = from_union([from_str, from_none], obj.get("serverName"))
        action = from_union([Action, from_none], obj.get("action"))
        permission_suggestions = from_union([lambda x: from_list(lambda x: x, x), from_none], obj.get("permissionSuggestions"))
        ttl_ms = from_union([from_int, from_none], obj.get("ttlMs"))
        by = from_union([By, from_none], obj.get("by"))
        decision = from_union([Decision, from_none], obj.get("decision"))
        updated_input = obj.get("updatedInput")
        updated_permissions = from_union([lambda x: from_list(lambda x: x, x), from_none], obj.get("updatedPermissions"))
        retry = from_union([from_bool, from_none], obj.get("retry"))
        description = from_union([from_str, from_none], obj.get("description"))
        subject = from_union([from_str, from_none], obj.get("subject"))
        task_id = from_union([from_str, from_none], obj.get("taskId"))
        teammate_name = from_union([from_str, from_none], obj.get("teammateName"))
        team_name = from_union([from_str, from_none], obj.get("teamName"))
        command = from_union([from_str, from_none], obj.get("command"))
        command_kind = from_union([CommandKind, from_none], obj.get("commandKind"))
        message_count = from_union([from_int, from_none], obj.get("messageCount"))
        token_count = from_union([from_int, from_none], obj.get("tokenCount"))
        trigger = from_union([Trigger, from_none], obj.get("trigger"))
        compacted_count = from_union([from_int, from_none], obj.get("compactedCount"))
        tokens_after = from_union([from_int, from_none], obj.get("tokensAfter"))
        tokens_before = from_union([from_int, from_none], obj.get("tokensBefore"))
        file_path = from_union([from_str, from_none], obj.get("filePath"))
        load_reason = from_union([LoadReason, from_none], obj.get("loadReason"))
        memory_type = from_union([from_str, from_none], obj.get("memoryType"))
        bootstrap_files = from_union([lambda x: from_list(from_str, x), from_none], obj.get("bootstrapFiles"))
        bytes = from_union([from_int, from_none], obj.get("bytes"))
        op = from_union([Op, from_none], obj.get("op"))
        path = from_union([from_str, from_none], obj.get("path"))
        change_type = from_union([ChangeType, from_none], obj.get("changeType"))
        new_cwd = from_union([from_str, from_none], obj.get("newCwd"))
        old_cwd = from_union([from_str, from_none], obj.get("oldCwd"))
        changed_values = obj.get("changedValues")
        config_source = from_union([ConfigSource, from_none], obj.get("configSource"))
        branch = from_union([from_str, from_none], obj.get("branch"))
        worktree_path = from_union([from_str, from_none], obj.get("worktreePath"))
        message = from_union([from_str, from_none], obj.get("message"))
        notification_type = from_union([NotificationType, from_none], obj.get("notificationType"))
        title = from_union([from_str, from_none], obj.get("title"))
        skill_name = from_union([from_str, from_none], obj.get("skillName"))
        author = from_union([Author, from_none], obj.get("author"))
        draft_path = from_union([from_str, from_none], obj.get("draftPath"))
        name = from_union([from_str, from_none], obj.get("name"))
        sha256 = from_union([from_str, from_none], obj.get("sha256"))
        version = from_union([from_str, from_none], obj.get("version"))
        return PrismerWire(type=type, agent=agent, parent_session_id=parent_session_id, scope=scope, session_id=session_id, reason=reason, agent_id=agent_id, parent_agent_id=parent_agent_id, subagent_type=subagent_type, transcript_path=transcript_path, status=status, tiers_added=tiers_added, tiers_removed=tiers_removed, prompt=prompt, source=source, conversation_length=conversation_length, is_first_turn=is_first_turn, model=model, stop_reason=stop_reason, tokens_used=tokens_used, iteration=iteration, tool_names=tool_names, last_assistant_message=last_assistant_message, error_message=error_message, error_type=error_type, content=content, role=role, ts=ts, channel_id=channel_id, prismer_wire_from=prismer_wire_from, metadata=metadata, success=success, to=to, media_path=media_path, transcript=transcript, body_for_agent=body_for_agent, args=args, call_id=call_id, risk_tag=risk_tag, tool=tool, duration_ms=duration_ms, ok=ok, summary=summary, updated_mcp_tool_output=updated_mcp_tool_output, error=error, is_interrupt=is_interrupt, signal_pattern=signal_pattern, form_schema=form_schema, request_id=request_id, server_name=server_name, action=action, permission_suggestions=permission_suggestions, ttl_ms=ttl_ms, by=by, decision=decision, updated_input=updated_input, updated_permissions=updated_permissions, retry=retry, description=description, subject=subject, task_id=task_id, teammate_name=teammate_name, team_name=team_name, command=command, command_kind=command_kind, message_count=message_count, token_count=token_count, trigger=trigger, compacted_count=compacted_count, tokens_after=tokens_after, tokens_before=tokens_before, file_path=file_path, load_reason=load_reason, memory_type=memory_type, bootstrap_files=bootstrap_files, bytes=bytes, op=op, path=path, change_type=change_type, new_cwd=new_cwd, old_cwd=old_cwd, changed_values=changed_values, config_source=config_source, branch=branch, worktree_path=worktree_path, message=message, notification_type=notification_type, title=title, skill_name=skill_name, author=author, draft_path=draft_path, name=name, sha256=sha256, version=version)

    def to_dict(self) -> dict:
        result: dict = {}
        result["type"] = to_enum(TypeEnum, self.type)
        if self.agent is not None:
            result["agent"] = from_union([lambda x: to_class(Agent, x), from_none], self.agent)
        if self.parent_session_id is not None:
            result["parentSessionId"] = from_union([from_str, from_none], self.parent_session_id)
        if self.scope is not None:
            result["scope"] = from_union([from_str, from_none], self.scope)
        if self.session_id is not None:
            result["sessionId"] = from_union([from_str, from_none], self.session_id)
        if self.reason is not None:
            result["reason"] = from_union([from_str, from_none], self.reason)
        if self.agent_id is not None:
            result["agentId"] = from_union([from_str, from_none], self.agent_id)
        if self.parent_agent_id is not None:
            result["parentAgentId"] = from_union([from_str, from_none], self.parent_agent_id)
        if self.subagent_type is not None:
            result["subagentType"] = from_union([from_str, from_none], self.subagent_type)
        if self.transcript_path is not None:
            result["transcriptPath"] = from_union([from_str, from_none], self.transcript_path)
        if self.status is not None:
            result["status"] = from_union([lambda x: to_enum(Status, x), from_none], self.status)
        if self.tiers_added is not None:
            result["tiersAdded"] = from_union([lambda x: from_list(from_int, x), from_none], self.tiers_added)
        if self.tiers_removed is not None:
            result["tiersRemoved"] = from_union([lambda x: from_list(from_int, x), from_none], self.tiers_removed)
        if self.prompt is not None:
            result["prompt"] = from_union([from_str, from_none], self.prompt)
        if self.source is not None:
            result["source"] = from_union([lambda x: to_class(SourceClass, x), from_str, from_none], self.source)
        if self.conversation_length is not None:
            result["conversationLength"] = from_union([from_int, from_none], self.conversation_length)
        if self.is_first_turn is not None:
            result["isFirstTurn"] = from_union([from_bool, from_none], self.is_first_turn)
        if self.model is not None:
            result["model"] = from_union([from_str, from_none], self.model)
        if self.stop_reason is not None:
            result["stopReason"] = from_union([from_str, from_none], self.stop_reason)
        if self.tokens_used is not None:
            result["tokensUsed"] = from_union([from_int, from_none], self.tokens_used)
        if self.iteration is not None:
            result["iteration"] = from_union([from_int, from_none], self.iteration)
        if self.tool_names is not None:
            result["toolNames"] = from_union([lambda x: from_list(from_str, x), from_none], self.tool_names)
        if self.last_assistant_message is not None:
            result["lastAssistantMessage"] = from_union([from_str, from_none], self.last_assistant_message)
        if self.error_message is not None:
            result["errorMessage"] = from_union([from_str, from_none], self.error_message)
        if self.error_type is not None:
            result["errorType"] = from_union([lambda x: to_enum(ErrorType, x), from_none], self.error_type)
        if self.content is not None:
            result["content"] = self.content
        if self.role is not None:
            result["role"] = from_union([lambda x: to_enum(Role, x), from_none], self.role)
        if self.ts is not None:
            result["ts"] = from_union([to_float, from_none], self.ts)
        if self.channel_id is not None:
            result["channelId"] = from_union([from_str, from_none], self.channel_id)
        if self.prismer_wire_from is not None:
            result["from"] = from_union([from_str, from_none], self.prismer_wire_from)
        if self.metadata is not None:
            result["metadata"] = from_union([lambda x: from_dict(lambda x: x, x), from_none], self.metadata)
        if self.success is not None:
            result["success"] = from_union([from_bool, from_none], self.success)
        if self.to is not None:
            result["to"] = from_union([from_str, from_none], self.to)
        if self.media_path is not None:
            result["mediaPath"] = from_union([from_str, from_none], self.media_path)
        if self.transcript is not None:
            result["transcript"] = from_union([from_str, from_none], self.transcript)
        if self.body_for_agent is not None:
            result["bodyForAgent"] = from_union([from_str, from_none], self.body_for_agent)
        if self.args is not None:
            result["args"] = self.args
        if self.call_id is not None:
            result["callId"] = from_union([from_str, from_none], self.call_id)
        if self.risk_tag is not None:
            result["riskTag"] = from_union([lambda x: to_enum(RiskTag, x), from_none], self.risk_tag)
        if self.tool is not None:
            result["tool"] = from_union([from_str, from_none], self.tool)
        if self.duration_ms is not None:
            result["durationMs"] = from_union([to_float, from_none], self.duration_ms)
        if self.ok is not None:
            result["ok"] = from_union([from_bool, from_none], self.ok)
        if self.summary is not None:
            result["summary"] = from_union([from_str, from_none], self.summary)
        if self.updated_mcp_tool_output is not None:
            result["updatedMCPToolOutput"] = self.updated_mcp_tool_output
        if self.error is not None:
            result["error"] = from_union([from_str, from_none], self.error)
        if self.is_interrupt is not None:
            result["isInterrupt"] = from_union([from_bool, from_none], self.is_interrupt)
        if self.signal_pattern is not None:
            result["signalPattern"] = from_union([from_str, from_none], self.signal_pattern)
        if self.form_schema is not None:
            result["formSchema"] = self.form_schema
        if self.request_id is not None:
            result["requestId"] = from_union([from_str, from_none], self.request_id)
        if self.server_name is not None:
            result["serverName"] = from_union([from_str, from_none], self.server_name)
        if self.action is not None:
            result["action"] = from_union([lambda x: to_enum(Action, x), from_none], self.action)
        if self.permission_suggestions is not None:
            result["permissionSuggestions"] = from_union([lambda x: from_list(lambda x: x, x), from_none], self.permission_suggestions)
        if self.ttl_ms is not None:
            result["ttlMs"] = from_union([from_int, from_none], self.ttl_ms)
        if self.by is not None:
            result["by"] = from_union([lambda x: to_enum(By, x), from_none], self.by)
        if self.decision is not None:
            result["decision"] = from_union([lambda x: to_enum(Decision, x), from_none], self.decision)
        if self.updated_input is not None:
            result["updatedInput"] = self.updated_input
        if self.updated_permissions is not None:
            result["updatedPermissions"] = from_union([lambda x: from_list(lambda x: x, x), from_none], self.updated_permissions)
        if self.retry is not None:
            result["retry"] = from_union([from_bool, from_none], self.retry)
        if self.description is not None:
            result["description"] = from_union([from_str, from_none], self.description)
        if self.subject is not None:
            result["subject"] = from_union([from_str, from_none], self.subject)
        if self.task_id is not None:
            result["taskId"] = from_union([from_str, from_none], self.task_id)
        if self.teammate_name is not None:
            result["teammateName"] = from_union([from_str, from_none], self.teammate_name)
        if self.team_name is not None:
            result["teamName"] = from_union([from_str, from_none], self.team_name)
        if self.command is not None:
            result["command"] = from_union([from_str, from_none], self.command)
        if self.command_kind is not None:
            result["commandKind"] = from_union([lambda x: to_enum(CommandKind, x), from_none], self.command_kind)
        if self.message_count is not None:
            result["messageCount"] = from_union([from_int, from_none], self.message_count)
        if self.token_count is not None:
            result["tokenCount"] = from_union([from_int, from_none], self.token_count)
        if self.trigger is not None:
            result["trigger"] = from_union([lambda x: to_enum(Trigger, x), from_none], self.trigger)
        if self.compacted_count is not None:
            result["compactedCount"] = from_union([from_int, from_none], self.compacted_count)
        if self.tokens_after is not None:
            result["tokensAfter"] = from_union([from_int, from_none], self.tokens_after)
        if self.tokens_before is not None:
            result["tokensBefore"] = from_union([from_int, from_none], self.tokens_before)
        if self.file_path is not None:
            result["filePath"] = from_union([from_str, from_none], self.file_path)
        if self.load_reason is not None:
            result["loadReason"] = from_union([lambda x: to_enum(LoadReason, x), from_none], self.load_reason)
        if self.memory_type is not None:
            result["memoryType"] = from_union([from_str, from_none], self.memory_type)
        if self.bootstrap_files is not None:
            result["bootstrapFiles"] = from_union([lambda x: from_list(from_str, x), from_none], self.bootstrap_files)
        if self.bytes is not None:
            result["bytes"] = from_union([from_int, from_none], self.bytes)
        if self.op is not None:
            result["op"] = from_union([lambda x: to_enum(Op, x), from_none], self.op)
        if self.path is not None:
            result["path"] = from_union([from_str, from_none], self.path)
        if self.change_type is not None:
            result["changeType"] = from_union([lambda x: to_enum(ChangeType, x), from_none], self.change_type)
        if self.new_cwd is not None:
            result["newCwd"] = from_union([from_str, from_none], self.new_cwd)
        if self.old_cwd is not None:
            result["oldCwd"] = from_union([from_str, from_none], self.old_cwd)
        if self.changed_values is not None:
            result["changedValues"] = self.changed_values
        if self.config_source is not None:
            result["configSource"] = from_union([lambda x: to_enum(ConfigSource, x), from_none], self.config_source)
        if self.branch is not None:
            result["branch"] = from_union([from_str, from_none], self.branch)
        if self.worktree_path is not None:
            result["worktreePath"] = from_union([from_str, from_none], self.worktree_path)
        if self.message is not None:
            result["message"] = from_union([from_str, from_none], self.message)
        if self.notification_type is not None:
            result["notificationType"] = from_union([lambda x: to_enum(NotificationType, x), from_none], self.notification_type)
        if self.title is not None:
            result["title"] = from_union([from_str, from_none], self.title)
        if self.skill_name is not None:
            result["skillName"] = from_union([from_str, from_none], self.skill_name)
        if self.author is not None:
            result["author"] = from_union([lambda x: to_enum(Author, x), from_none], self.author)
        if self.draft_path is not None:
            result["draftPath"] = from_union([from_str, from_none], self.draft_path)
        if self.name is not None:
            result["name"] = from_union([from_str, from_none], self.name)
        if self.sha256 is not None:
            result["sha256"] = from_union([from_str, from_none], self.sha256)
        if self.version is not None:
            result["version"] = from_union([from_str, from_none], self.version)
        return result


def prismer_wire_from_dict(s: Any) -> PrismerWire:
    return PrismerWire.from_dict(s)


def prismer_wire_to_dict(x: PrismerWire) -> Any:
    return to_class(PrismerWire, x)

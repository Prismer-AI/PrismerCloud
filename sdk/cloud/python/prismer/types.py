"""Type definitions for Prismer SDK — covers Context, Parse, and IM APIs."""

from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field


# ============================================================================
# Environment
# ============================================================================

ENVIRONMENTS: Dict[str, str] = {
    "production": "https://prod.docbrew.cn",
}

# ============================================================================
# Shared
# ============================================================================

class PrismerError(BaseModel):
    """Error information."""
    code: str
    message: str


# ============================================================================
# IM Message Types (v1.8.2)
# ============================================================================

MessageType = Literal[
    "text",
    "markdown",
    "code",
    "image",
    "file",
    "voice",       # v1.8.2
    "location",    # v1.8.2
    "artifact",    # v1.8.2
    "tool_call",
    "tool_result",
    "system_event",  # deprecated — use "system" with metadata.action
    "system",      # v1.8.2
    "thinking",
]

ArtifactType = Literal[
    "pdf", "code", "document", "dataset", "chart", "notebook", "latex", "other",
]


# ============================================================================
# Context API Types
# ============================================================================

class RankingFactors(BaseModel):
    cache: float = 0
    relevance: float = 0
    freshness: float = 0
    quality: float = 0


class RankingInfo(BaseModel):
    score: float
    factors: RankingFactors = Field(default_factory=RankingFactors)


class LoadResultItem(BaseModel):
    rank: Optional[int] = None
    url: str
    title: Optional[str] = None
    hqcc: Optional[str] = None
    raw: Optional[str] = None
    cached: bool = False
    cached_at: Optional[str] = Field(default=None, alias="cachedAt")
    processed: Optional[bool] = None
    found: Optional[bool] = None
    error: Optional[str] = None
    ranking: Optional[RankingInfo] = None
    meta: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class LoadResult(BaseModel):
    success: bool
    request_id: Optional[str] = Field(default=None, alias="requestId")
    mode: Optional[Literal["single_url", "batch_urls", "query"]] = None
    result: Optional[LoadResultItem] = None
    results: Optional[List[LoadResultItem]] = None
    summary: Optional[Dict[str, Any]] = None
    cost: Optional[Dict[str, Any]] = None
    processing_time: Optional[int] = Field(default=None, alias="processingTime")
    error: Optional[PrismerError] = None

    class Config:
        populate_by_name = True


class SaveOptions(BaseModel):
    url: str
    hqcc: str
    raw: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None


class SaveBatchOptions(BaseModel):
    items: List[SaveOptions]


class SaveResult(BaseModel):
    success: bool
    status: Optional[str] = None
    url: Optional[str] = None
    results: Optional[List[Dict[str, str]]] = None
    summary: Optional[Dict[str, int]] = None
    error: Optional[PrismerError] = None


# ============================================================================
# Parse API Types
# ============================================================================

class ParseOptions(BaseModel):
    url: Optional[str] = None
    base64: Optional[str] = None
    filename: Optional[str] = None
    mode: Optional[Literal["fast", "hires", "auto"]] = None
    output: Optional[Literal["markdown", "json"]] = None
    image_mode: Optional[Literal["embedded", "s3"]] = None
    wait: Optional[bool] = None


class ParseDocumentImage(BaseModel):
    page: int
    url: str
    caption: Optional[str] = None


class ParseDocument(BaseModel):
    markdown: Optional[str] = None
    text: Optional[str] = None
    page_count: int = Field(alias="pageCount")
    metadata: Optional[Dict[str, Any]] = None
    images: Optional[List[ParseDocumentImage]] = None
    estimated_time: Optional[float] = Field(default=None, alias="estimatedTime")

    class Config:
        populate_by_name = True


class ParseUsage(BaseModel):
    input_pages: int = Field(alias="inputPages")
    input_images: int = Field(alias="inputImages")
    output_chars: int = Field(alias="outputChars")
    output_tokens: int = Field(alias="outputTokens")

    class Config:
        populate_by_name = True


class ParseCostBreakdown(BaseModel):
    pages: float = 0
    images: float = 0

    class Config:
        populate_by_name = True


class ParseCost(BaseModel):
    credits: float = 0
    breakdown: Optional[ParseCostBreakdown] = None

    class Config:
        populate_by_name = True


class ParseEndpoints(BaseModel):
    status: str
    result: str
    stream: str


class ParseResult(BaseModel):
    success: bool
    request_id: Optional[str] = Field(default=None, alias="requestId")
    mode: Optional[str] = None
    async_: Optional[bool] = Field(default=None, alias="async")
    document: Optional[ParseDocument] = None
    usage: Optional[ParseUsage] = None
    cost: Optional[ParseCost] = None
    task_id: Optional[str] = Field(default=None, alias="taskId")
    status: Optional[str] = None
    endpoints: Optional[ParseEndpoints] = None
    processing_time: Optional[int] = Field(default=None, alias="processingTime")
    error: Optional[PrismerError] = None

    class Config:
        populate_by_name = True


# ============================================================================
# IM API Types
# ============================================================================

class IMRegisterOptions(BaseModel):
    type: Literal["agent", "human"]
    username: str
    display_name: str = Field(alias="displayName")
    agent_type: Optional[Literal["assistant", "specialist", "orchestrator", "tool", "bot"]] = Field(
        default=None, alias="agentType"
    )
    capabilities: Optional[List[str]] = None
    description: Optional[str] = None
    endpoint: Optional[str] = None

    class Config:
        populate_by_name = True


class IMRegisterData(BaseModel):
    im_user_id: str = Field(alias="imUserId")
    username: str
    display_name: str = Field(alias="displayName")
    role: str
    token: str
    expires_in: str = Field(alias="expiresIn")
    capabilities: Optional[List[str]] = None
    is_new: bool = Field(alias="isNew")

    class Config:
        populate_by_name = True


class IMUser(BaseModel):
    id: str
    username: str
    display_name: str = Field(alias="displayName")
    role: str
    agent_type: Optional[str] = Field(default=None, alias="agentType")

    class Config:
        populate_by_name = True


class IMAgentCard(BaseModel):
    agent_type: str = Field(alias="agentType")
    capabilities: List[str]
    description: Optional[str] = None
    status: str

    class Config:
        populate_by_name = True


class IMStats(BaseModel):
    conversation_count: int = Field(alias="conversationCount")
    direct_count: Optional[int] = Field(default=None, alias="directCount")
    group_count: Optional[int] = Field(default=None, alias="groupCount")
    contact_count: int = Field(alias="contactCount")
    messages_sent: int = Field(alias="messagesSent")
    unread_count: int = Field(alias="unreadCount")

    class Config:
        populate_by_name = True


class IMBindingInfo(BaseModel):
    platform: str
    status: str
    external_name: Optional[str] = Field(default=None, alias="externalName")

    class Config:
        populate_by_name = True


class IMCreditsInfo(BaseModel):
    balance: float
    total_spent: float = Field(alias="totalSpent")

    class Config:
        populate_by_name = True


class IMMeData(BaseModel):
    user: IMUser
    agent_card: Optional[IMAgentCard] = Field(default=None, alias="agentCard")
    stats: IMStats
    bindings: List[IMBindingInfo]
    credits: IMCreditsInfo

    class Config:
        populate_by_name = True


class IMTokenData(BaseModel):
    token: str
    expires_in: str = Field(alias="expiresIn")

    class Config:
        populate_by_name = True


# ────────────────────────────────────────────────────────────────────────────
# v2.0 §4.6 ContentBlock — multimodal protocol-layer typing
#
# Anthropic-shape discriminated union with `kind` tag. NOT OpenAI's
# `{"type": "image_url", "image_url": {...}}` shape — adapters translate to
# vendor-specific wire format at dispatch time. See
# docs/release200/14-messaging-state-machine-reliability.md §4.6 +
# 14b "与 14 主文档的关系" for the source-of-truth definition.
# ────────────────────────────────────────────────────────────────────────────


class ContentBlockText(BaseModel):
    kind: Literal["text"] = "text"
    text: str


class ContentBlockImage(BaseModel):
    kind: Literal["image"] = "image"
    asset_id: str = Field(alias="assetId")
    media_type: str = Field(alias="mediaType")  # e.g. "image/png" | "image/jpeg" | …
    alt: Optional[str] = None

    class Config:
        populate_by_name = True


class ContentBlockAudio(BaseModel):
    kind: Literal["audio"] = "audio"
    asset_id: str = Field(alias="assetId")
    media_type: str = Field(alias="mediaType")
    duration_ms: Optional[int] = Field(default=None, alias="durationMs")

    class Config:
        populate_by_name = True


class ContentBlockVideo(BaseModel):
    kind: Literal["video"] = "video"
    asset_id: str = Field(alias="assetId")
    media_type: str = Field(alias="mediaType")
    duration_ms: Optional[int] = Field(default=None, alias="durationMs")
    thumbnail_url: Optional[str] = Field(default=None, alias="thumbnailUrl")

    class Config:
        populate_by_name = True


class ContentBlockFile(BaseModel):
    kind: Literal["file"] = "file"
    asset_id: str = Field(alias="assetId")
    media_type: str = Field(alias="mediaType")
    filename: str

    class Config:
        populate_by_name = True


class ContentBlockToolUse(BaseModel):
    kind: Literal["tool_use"] = "tool_use"
    tool_call_id: str = Field(alias="toolCallId")
    tool_name: str = Field(alias="toolName")
    input_json: Any = Field(alias="inputJson")

    class Config:
        populate_by_name = True


class ContentBlockToolResult(BaseModel):
    kind: Literal["tool_result"] = "tool_result"
    tool_call_id: str = Field(alias="toolCallId")
    # recursive — resolved by Pydantic via forward-ref update_forward_refs below
    output: List["ContentBlock"]

    class Config:
        populate_by_name = True


class ContentBlockReasoning(BaseModel):
    kind: Literal["reasoning"] = "reasoning"
    text: str
    redacted: Optional[bool] = None


class ContentBlockPkf(BaseModel):
    """product209 — canonical inline PKF source; message text is its projection."""

    kind: Literal["pkf"] = "pkf"
    source: str
    title: Optional[str] = None
    block_id: Optional[str] = Field(default=None, alias="blockId")
    block_revision: Optional[int] = Field(default=None, alias="blockRevision")
    source_hash: Optional[str] = Field(default=None, alias="sourceHash")

    class Config:
        populate_by_name = True


#: v2.0 §4.6 + product209 — 9-variant ContentBlock discriminated union
ContentBlock = Union[
    ContentBlockText,
    ContentBlockImage,
    ContentBlockAudio,
    ContentBlockVideo,
    ContentBlockFile,
    ContentBlockToolUse,
    ContentBlockToolResult,
    ContentBlockReasoning,
    ContentBlockPkf,
]

ContentBlockToolResult.model_rebuild()


class ChatMessage(BaseModel):
    """v2.0 §4.6 — multi-turn dispatch message with optional ContentBlock[]."""

    role: Literal["system", "user", "assistant", "tool"]
    content: Union[str, List[ContentBlock]]
    name: Optional[str] = None
    tool_call_id: Optional[str] = Field(default=None, alias="toolCallId")

    class Config:
        populate_by_name = True


class TaskInput(BaseModel):
    """v2.0 §4.6 — task input. `messages` preferred for multimodal."""

    prompt: Optional[str] = None
    messages: Optional[List[ChatMessage]] = None

    # extra capability-specific fields allowed
    class Config:
        extra = "allow"
        populate_by_name = True


class IMMessage(BaseModel):
    id: str
    conversation_id: Optional[str] = Field(default=None, alias="conversationId")
    content: str
    type: str
    sender_id: str = Field(alias="senderId")
    parent_id: Optional[str] = Field(default=None, alias="parentId")
    quoted_message_id: Optional[str] = Field(default=None, alias="quotedMessageId")
    status: Optional[str] = None
    created_at: str = Field(alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")
    metadata: Optional[Any] = None
    # v2.0 §4.6 — multimodal content blocks (coexists with `content` during
    # the 6-sprint double-write window).
    content_blocks: Optional[List[ContentBlock]] = Field(default=None, alias="contentBlocks")
    # v2.0 §4.1 — per-conversation strict-monotonic seq (Wave 2-B1 server).
    boundary_seq: Optional[int] = Field(default=None, alias="boundarySeq")

    class Config:
        populate_by_name = True


class IMRoutingTarget(BaseModel):
    user_id: str = Field(alias="userId")
    username: Optional[str] = None

    class Config:
        populate_by_name = True


class IMRouting(BaseModel):
    mode: str
    targets: List[IMRoutingTarget]


class IMMessageData(BaseModel):
    conversation_id: str = Field(alias="conversationId")
    message: IMMessage
    routing: Optional[IMRouting] = None

    class Config:
        populate_by_name = True


class IMGroupMember(BaseModel):
    user_id: str = Field(alias="userId")
    username: str
    display_name: Optional[str] = Field(default=None, alias="displayName")
    role: str

    class Config:
        populate_by_name = True


class IMGroupData(BaseModel):
    group_id: str = Field(alias="groupId")
    title: str
    members: List[IMGroupMember]

    class Config:
        populate_by_name = True


class IMContact(BaseModel):
    username: str
    display_name: str = Field(alias="displayName")
    role: str
    last_message_at: Optional[str] = Field(default=None, alias="lastMessageAt")
    unread_count: int = Field(alias="unreadCount")
    conversation_id: str = Field(alias="conversationId")

    class Config:
        populate_by_name = True


class IMDiscoverAgent(BaseModel):
    username: str
    display_name: str = Field(alias="displayName")
    agent_type: Optional[str] = Field(default=None, alias="agentType")
    capabilities: Optional[List[str]] = None
    status: str

    class Config:
        populate_by_name = True


class IMBindingData(BaseModel):
    binding_id: str = Field(alias="bindingId")
    platform: str
    status: str
    verification_code: str = Field(alias="verificationCode")

    class Config:
        populate_by_name = True


class IMBinding(BaseModel):
    binding_id: str = Field(alias="bindingId")
    platform: str
    status: str
    external_name: Optional[str] = Field(default=None, alias="externalName")

    class Config:
        populate_by_name = True


class IMCreditsData(BaseModel):
    balance: float
    total_earned: float = Field(alias="totalEarned")
    total_spent: float = Field(alias="totalSpent")

    class Config:
        populate_by_name = True


class IMTransaction(BaseModel):
    id: str
    type: str
    amount: float
    balance_after: float = Field(alias="balanceAfter")
    description: str
    created_at: str = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class IMConversation(BaseModel):
    """Conversation object."""
    id: str
    type: str
    title: Optional[str] = None
    last_message: Optional[IMMessage] = Field(default=None, alias="lastMessage")
    unread_count: Optional[int] = Field(default=None, alias="unreadCount")
    members: Optional[List[IMGroupMember]] = None
    created_at: str = Field(alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")

    class Config:
        populate_by_name = True


class IMWorkspaceData(BaseModel):
    """Workspace initialization result."""
    workspace_id: str = Field(alias="workspaceId")
    conversation_id: str = Field(alias="conversationId")

    class Config:
        populate_by_name = True


class IMAutocompleteResult(BaseModel):
    """@mention autocomplete result."""
    user_id: str = Field(alias="userId")
    username: str
    display_name: str = Field(alias="displayName")
    role: str

    class Config:
        populate_by_name = True


# ============================================================================
# v1.9.3 Refactor Surface — Workspaces / Workspace-Files / Assets / Runtime
# ============================================================================

class WorkspaceDTO(BaseModel):
    """v1.9.3 IM Workspace (mounted at /api/im/workspaces)."""
    id: str
    owner_im_user_id: str = Field(alias="ownerImUserId")
    name: str
    slug: str
    is_default: bool = Field(alias="isDefault")
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class WorkspaceFileDTO(BaseModel):
    """v1.9.3 Workspace File (binding of relative path -> assetId)."""
    id: str
    workspace_id: str = Field(alias="workspaceId")
    path: str
    asset_id: str = Field(alias="assetId")
    content_hash: Optional[str] = Field(default=None, alias="contentHash")
    version: int
    parent_version_id: Optional[str] = Field(default=None, alias="parentVersionId")
    modifier_im_user_id: str = Field(alias="modifierImUserId")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    deleted_at: Optional[str] = Field(default=None, alias="deletedAt")

    class Config:
        populate_by_name = True


class AssetPreviewDerivativeDTO(BaseModel):
    type: str
    asset_id: Optional[str] = Field(default=None, alias="assetId")
    url: Optional[str] = None
    endpoint: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        populate_by_name = True


class AssetPreviewMessageDTO(BaseModel):
    code: str
    message: str


class AssetPreviewContractDTO(BaseModel):
    kind: str
    status: str
    max_inline_bytes: int = Field(alias="maxInlineBytes")
    content_length: Optional[int] = Field(default=None, alias="contentLength")
    byte_range_supported: Optional[bool] = Field(default=None, alias="byteRangeSupported")
    preferred_renderer: Optional[str] = Field(default=None, alias="preferredRenderer")
    inline_policy: Optional[str] = Field(default=None, alias="inlinePolicy")
    page_count: Optional[int] = Field(default=None, alias="pageCount")
    row_count_approx: Optional[int] = Field(default=None, alias="rowCountApprox")
    sheet_count: Optional[int] = Field(default=None, alias="sheetCount")
    extractor_version: Optional[str] = Field(default=None, alias="extractorVersion")
    etag: Optional[str] = None
    derivatives: List[AssetPreviewDerivativeDTO] = Field(default_factory=list)
    warnings: List[AssetPreviewMessageDTO] = Field(default_factory=list)
    security_warnings: List[AssetPreviewMessageDTO] = Field(default_factory=list, alias="securityWarnings")

    class Config:
        populate_by_name = True


class AssetDTO(BaseModel):
    """v1.9.3 Asset (content-addressed immutable blob)."""
    id: str
    workspace_id: str = Field(alias="workspaceId")
    owner_im_user_id: str = Field(alias="ownerImUserId")
    content_hash: str = Field(alias="contentHash")
    storage_uri: str = Field(alias="storageUri")
    size_bytes: Optional[int] = Field(default=None, alias="sizeBytes")
    mime: Optional[str] = None
    kind: str
    source_agent_im_user_id: Optional[str] = Field(default=None, alias="sourceAgentImUserId")
    source_task_id: Optional[str] = Field(default=None, alias="sourceTaskId")
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: str = Field(alias="createdAt")
    preview: Optional[AssetPreviewContractDTO] = None

    class Config:
        populate_by_name = True


class AgentProfileDTO(BaseModel):
    """v1.9.3 Agent Profile (adapter-local config: cwd / model / MCP / env / prompt)."""
    id: str
    workspace_id: str = Field(alias="workspaceId")
    agent_im_user_id: str = Field(alias="agentImUserId")
    adapter_name: str = Field(alias="adapterName")
    name: str
    config: Dict[str, Any] = Field(default_factory=dict)
    version: int
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class RuntimeInstallationResources(BaseModel):
    cpu_request: Optional[str] = Field(default=None, alias="cpuRequest")
    cpu_limit: Optional[str] = Field(default=None, alias="cpuLimit")
    memory_request: Optional[str] = Field(default=None, alias="memoryRequest")
    memory_limit: Optional[str] = Field(default=None, alias="memoryLimit")

    class Config:
        populate_by_name = True


class RuntimeInstallationDTO(BaseModel):
    """v1.9.3 Workspace Runtime Installation (long-running daemon host)."""
    id: str
    workspace_id: str = Field(alias="workspaceId")
    runtime_instance_id: Optional[str] = Field(default=None, alias="runtimeInstanceId")
    daemon_id: Optional[str] = Field(default=None, alias="daemonId")
    pod_name: Optional[str] = Field(default=None, alias="podName")
    namespace: Optional[str] = None
    phase: str
    desired_state: Optional[str] = Field(default=None, alias="desiredState")
    status: Optional[str] = None
    image: Optional[str] = None
    image_tag: Optional[str] = Field(default=None, alias="imageTag")
    warm_pool_hit: Optional[bool] = Field(default=None, alias="warmPoolHit")
    resources: Optional[RuntimeInstallationResources] = None
    gateway_url: Optional[str] = Field(default=None, alias="gatewayUrl")
    started_at: Optional[str] = Field(default=None, alias="startedAt")
    stopped_at: Optional[str] = Field(default=None, alias="stoppedAt")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
    metrics: Optional[Dict[str, Any]] = None
    observability: Optional[Dict[str, Any]] = None
    events: Optional[List[Dict[str, Any]]] = None

    class Config:
        populate_by_name = True


# ============================================================================
# v1.8.2 / v1.9.3 Task Enrichment + kind enum
# ============================================================================

# Task runtime route — controls where a task executes (v1.9.x).
TaskRuntimeRoute = Literal["agent", "sandbox", "shell"]

# Task kind — semantic classifier (v1.8.2 enriched DTO).
TaskKind = Literal[
    "general",
    "code",
    "research",
    "analysis",
    "automation",
    "longrun",
]


class EnrichedTaskDTO(BaseModel):
    """v1.8.2 enriched task DTO returned by /api/im/tasks endpoints.

    All v1.8.2 enrichment fields are optional; this is a forward-compatible shape.
    Older fields (id, title, status, ...) are accepted but not strictly typed here —
    callers should index ``data`` directly when they need the legacy shape.
    """
    id: str
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    progress: Optional[float] = None
    status_message: Optional[str] = Field(default=None, alias="statusMessage")
    capability: Optional[str] = None
    creator_id: Optional[str] = Field(default=None, alias="creatorId")
    assignee_id: Optional[str] = Field(default=None, alias="assigneeId")
    workspace_id: Optional[str] = Field(default=None, alias="workspaceId")
    conversation_id: Optional[str] = Field(default=None, alias="conversationId")
    runtime_route: Optional[TaskRuntimeRoute] = Field(default=None, alias="runtimeRoute")
    kind: Optional[TaskKind] = None
    # Enrichment additions (v1.8.2)
    owner_id: Optional[str] = Field(default=None, alias="ownerId")
    owner_type: Optional[Literal["human", "agent"]] = Field(default=None, alias="ownerType")
    owner_name: Optional[str] = Field(default=None, alias="ownerName")
    assignee_type: Optional[Literal["human", "agent"]] = Field(default=None, alias="assigneeType")
    assignee_name: Optional[str] = Field(default=None, alias="assigneeName")
    metadata: Optional[Dict[str, Any]] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")
    completed_at: Optional[str] = Field(default=None, alias="completedAt")

    class Config:
        populate_by_name = True


class TaskEvent(BaseModel):
    """SSE event payload from GET /api/im/tasks/events.

    Wire shape: ``{ id, event, retry?, data }`` (raw SSE record).
    See r1 §IM Tasks for event-specific data shapes.
    """
    id: Optional[str] = None
    event: str
    data: Optional[Dict[str, Any]] = None


class IMResult(BaseModel):
    """Generic IM API response wrapper."""
    ok: bool
    data: Optional[Any] = None
    meta: Optional[Dict[str, Any]] = None
    error: Optional[PrismerError] = None
    local_paths: Optional[List[str]] = None
    removed_paths: Optional[List[str]] = None


# ============================================================================
# Realtime Event Payloads
# ============================================================================

class MessageNewPayload(BaseModel):
    id: str
    conversation_id: str = Field(alias="conversationId")
    content: str
    type: str
    sender_id: str = Field(alias="senderId")
    routing: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None
    created_at: str = Field(alias="createdAt")
    class Config:
        populate_by_name = True

class MessageEditPayload(BaseModel):
    id: str
    conversation_id: str = Field(alias="conversationId")
    content: str
    type: str
    edited_at: str = Field(alias="editedAt")
    edited_by: str = Field(alias="editedBy")
    metadata: Optional[Dict[str, Any]] = None
    class Config:
        populate_by_name = True

class MessageDeletedPayload(BaseModel):
    id: str
    conversation_id: str = Field(alias="conversationId")
    class Config:
        populate_by_name = True

REALTIME_EVENT_AUTHENTICATED = "authenticated"
REALTIME_EVENT_MESSAGE_NEW = "message.new"
REALTIME_EVENT_MESSAGE_EDIT = "message.edit"
REALTIME_EVENT_MESSAGE_DELETED = "message.deleted"
REALTIME_EVENT_TYPING_INDICATOR = "typing.indicator"
REALTIME_EVENT_PRESENCE_CHANGED = "presence.changed"
REALTIME_EVENT_PONG = "pong"
REALTIME_EVENT_ERROR = "error"
REALTIME_EVENT_CONNECTED = "connected"
REALTIME_EVENT_DISCONNECTED = "disconnected"
REALTIME_EVENT_RECONNECTING = "reconnecting"


# ============================================================================
# EaaS tenant bounded context — contract mirror
# (eaas-gate-a Task 12 / eaas-gate-b Task 15 — `/api/v1/environments/*` +
#  `/api/v1/projects/:id/warm-pool`)
#
# ⚠️ SOURCE OF TRUTH: cloud `src/tenant/contract.ts` (+ `src/tenant/errors.ts`
# envelope). This module deliberately does NOT import cloud src/ — every field
# below is a hand-maintained mirror of the TS SDK mirror
# `sdk/cloud/src/environment-contract.ts`, and the two sides must stay
# field-identical. 改两头必须同步：any change to a field, union member or error
# code on the server contract must be applied here AND to the TS mirror in the
# same change (the unit tests pin the error-code set exactly).
#
# The EaaS clients return the raw response envelope as a plain dict (same
# convention as the `im.*` surface); these models are the typed mirror for
# callers who want validation, e.g.
# ``EnvironmentStatus.model_validate(res["data"])``.
#
# No new dependency — pydantic only.
# ============================================================================

# ── Error codes（Global Constraint 5 精确集合，code → HTTP status）──────────
#
# `not_owned` carries 404（资源不存在与不属于本租户统一 404，零数据泄漏）；
# 403 留给 scope_denied；503 warm_capacity_unavailable 由调用方决定降级或重试，
# SDK 绝不自动转 cold（见 EnvironmentsClient/WarmPoolClient 文档）。
EAAS_ERROR_CODES: Dict[str, int] = {
    "invalid_policy": 400,
    "invalid_request": 400,
    "invalid_token": 401,
    # Gate B T5 sessions face（publishable key / identityToken / principal token）。
    "invalid_session": 401,
    "publishable_key_invalid": 401,
    "session_expired": 401,
    "budget_exhausted": 402,
    "scope_denied": 403,
    # Gate B T7 conversation face（匿名 principal 无 IM 会话宿主）。
    "capability_denied": 403,
    # 多模态输入面：contentBlocks 引用的 image asset 不可读/不属于本 env（可见失败）。
    # 伴 `runtime_unavailable` 于 Gate B+ Task 7 一并补齐（与 src/tenant/contract.ts 同步）。
    "invalid_asset": 400,
    "not_owned": 404,
    "state_conflict": 409,
    "idempotency_conflict": 409,
    "revision_conflict": 412,
    "template_unavailable": 422,
    "capability_unavailable": 422,
    "quota_exceeded": 429,
    "rate_limited": 429,
    "warm_capacity_unavailable": 503,
    "provider_unavailable": 503,
    "pricing_unavailable": 503,
    # Gate B+ Task 7（2026-09-17）：环境内 Runtime turn 面不可用（载体 daemon 未就绪 /
    # bundle turn 入口缺失 / exec 控制面失败 / exec 硬超时）。turn 是 fire-and-forget
    # 派发，故只出现在 run 与线程内 status 事件面。
    "runtime_unavailable": 503,
}

EaasErrorCode = str

# ── Client-side error carrier (`wait_until_ready()` + stream 连接失败) ──────


class EaasClientError(Exception):
    """`code` 取 EAAS_ERROR_CODES 键或 ``'timeout'``（及客户端合成 ``http_error``）。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def new_idempotency_key() -> str:
    """UUID v4 幂等键。SDK 不自动重试：安全重试 = 调用方携带同一 key 再发。"""
    import uuid

    return str(uuid.uuid4())


# ── Response envelope（src/tenant/errors.ts 镜像）───────────────────────────


class EaasErrorBody(BaseModel):
    """服务端承诺 `code` ∈ EAAS_ERROR_CODES 精确集合；`details` 键恒存在（无详情 → null）。"""

    code: str
    message: str
    details: Optional[Any] = None
    retryable: Optional[bool] = None


class EaasSuccessEnvelope(BaseModel):
    success: Literal[True]
    data: Any
    request_id: str = Field(alias="requestId")

    class Config:
        populate_by_name = True


class EaasFailEnvelope(BaseModel):
    success: Literal[False]
    error: EaasErrorBody
    request_id: str = Field(alias="requestId")

    class Config:
        populate_by_name = True


def is_eaas_error_envelope(value: Any) -> bool:
    """轻量判别：任意值是否为 EaaS 失败 envelope（dict 形态，与 TS guard 同语义）。"""
    if not isinstance(value, dict):
        return False
    if value.get("success") is not False:
        return False
    error = value.get("error")
    if not isinstance(error, dict):
        return False
    code = error.get("code")
    message = error.get("message")
    return isinstance(code, str) and len(code) > 0 and isinstance(message, str)


# ── Protocol types（src/tenant/contract.ts 逐字镜像）────────────────────────


class EaasMilestone(BaseModel):
    name: str
    at: str
    duration_ms: Optional[int] = Field(default=None, alias="durationMs")

    class Config:
        populate_by_name = True


class EaasReadiness(BaseModel):
    sandbox: bool
    services: bool
    agent: Optional[bool] = None


class EnvironmentCreateSpec(BaseModel):
    """创建 spec。project/template/profile 可由 project key 与服务端默认值推导。

    `startup.on_warm_miss`：create 只能收紧项目策略——cold→fail 可以，fail→cold 拒 400
    （Global Constraint 8）。`env` 敏感值仅身份绑定后注入，不写事件或预热模板（spec §4）。
    """

    project_id: Optional[str] = Field(default=None, alias="projectId")
    template: Optional[str] = None
    profile: Optional[str] = None
    pool_id: Optional[str] = Field(default=None, alias="poolId")
    placement_id: Optional[str] = Field(default=None, alias="placementId")
    ttl_seconds: Optional[int] = Field(default=None, alias="ttlSeconds")
    metadata: Optional[Dict[str, str]] = None
    env: Optional[Dict[str, str]] = None
    startup: Optional[Dict[str, Literal["cold", "fail"]]] = None

    class Config:
        populate_by_name = True


class EnvironmentStatus(BaseModel):
    """环境状态投影（API 草案逐字；Global Constraint 14 状态机）。"""

    environment_id: str = Field(alias="environmentId")
    state: Literal[
        "pending",
        "provisioning",
        "running",
        "degraded",
        "paused",
        "stopping",
        "stopped",
        "errored",
    ]
    revision: int
    epoch: int
    readiness: EaasReadiness
    startup_path: Optional[Literal["warm", "cold", "wake", "restore"]] = Field(
        default=None, alias="startupPath"
    )
    template_version: str = Field(alias="templateVersion")
    mapping_revision: Optional[str] = Field(default=None, alias="mappingRevision")
    profile_revision: Optional[str] = Field(default=None, alias="profileRevision")
    network_policy_revision: Optional[str] = Field(default=None, alias="networkPolicyRevision")
    storage_policy_revision: Optional[str] = Field(default=None, alias="storagePolicyRevision")
    expires_at: str = Field(alias="expiresAt")
    milestones: List[EaasMilestone] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class EnvironmentListPage(BaseModel):
    """`list()` data 面（cloud ListEnvironmentsResult 镜像）。"""

    environments: List[EnvironmentStatus]
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")

    class Config:
        populate_by_name = True


class EaasLifecycleResult(BaseModel):
    """lifecycle 面（pause/wake/suspend/delete/restore）data 镜像（LifecycleResult）。"""

    environment_id: str = Field(alias="environmentId")
    state: str
    epoch: int
    revision: int
    operation_id: Optional[str] = Field(default=None, alias="operationId")

    class Config:
        populate_by_name = True


class EaasExecExited(BaseModel):
    exec_id: str = Field(alias="execId")
    status: Literal["exited"]
    exit_code: int = Field(alias="exitCode")
    stdout: str
    stderr: str
    started_at: str = Field(alias="startedAt")
    finished_at: str = Field(alias="finishedAt")

    class Config:
        populate_by_name = True


class EaasExecRunning(BaseModel):
    exec_id: str = Field(alias="execId")
    status: Literal["running"]
    command: List[str]
    started_at: str = Field(alias="startedAt")

    class Config:
        populate_by_name = True


# 同步窗或 A1 句柄（ExecServiceResult body 镜像）；判别键 `status`。
EaasExecView = Union[EaasExecExited, EaasExecRunning]


class EaasExecReadView(BaseModel):
    """`get_exec()` data 面（A1 句柄读；cursor=stdout 字节偏移，单响应 ≤64KB）。"""

    exec_id: str = Field(alias="execId")
    command: List[str]
    status: str
    exit_code: Optional[int] = Field(default=None, alias="exitCode")
    stdout: str
    stderr: str
    error: Optional[str] = None
    started_at: str = Field(alias="startedAt")
    finished_at: Optional[str] = Field(default=None, alias="finishedAt")
    next_cursor: Optional[int] = Field(default=None, alias="nextCursor")

    class Config:
        populate_by_name = True


class EaasSnapshotCreated(BaseModel):
    """`create_snapshot()` data 面（pending op 形；执行在 reconcile）。"""

    environment_id: str = Field(alias="environmentId")
    snapshot_id: str = Field(alias="snapshotId")
    state: Literal["pending"]
    operation_id: str = Field(alias="operationId")

    class Config:
        populate_by_name = True


class EaasSnapshotEntry(BaseModel):
    snapshot_id: str = Field(alias="snapshotId")
    created_at: str = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class EaasSnapshotList(BaseModel):
    """`list_snapshots()` data 面（本环境 succeeded snapshot ops，createdAt asc）。"""

    environment_id: str = Field(alias="environmentId")
    snapshots: List[EaasSnapshotEntry] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class EaasServiceEntry(BaseModel):
    name: str
    state: str
    last_checked_at: Optional[str] = Field(default=None, alias="lastCheckedAt")

    class Config:
        populate_by_name = True


class EaasServicesProjection(BaseModel):
    """`list_services()` data 面。gatewayUrl = 授权 gateway URL（Gate B W5 签发面）；
    绝不暴露 Pod IP。"""

    environment_id: str = Field(alias="environmentId")
    services: List[EaasServiceEntry] = Field(default_factory=list)
    gateway_url: str = Field(alias="gatewayUrl")

    class Config:
        populate_by_name = True


class EaasFilePutView(BaseModel):
    """`put_file()` data 面（cloud PutFileResult 镜像）。"""

    environment_id: str = Field(alias="environmentId")
    path: str
    size: int
    sha256: str

    class Config:
        populate_by_name = True


class EaasEventEnvelope(BaseModel):
    """事件 envelope（Global Constraint 13；eventId = ``<tenantId>:<seq>``，cursor 为 seq 字符串）。

    Python realtime 面（SSE/WS 消费）是 Gate B+ 交付；此模型先镜像 wire 形状。
    """

    v: Literal[1]
    event_id: str = Field(alias="eventId")
    cursor: str
    type: str
    at: str
    environment_id: Optional[str] = Field(default=None, alias="environmentId")
    project_id: Optional[str] = Field(default=None, alias="projectId")
    payload: Dict[str, Any] = Field(default_factory=dict)

    class Config:
        populate_by_name = True


class EaasPrincipalBudgetView(BaseModel):
    period_start: str = Field(alias="periodStart")
    limit_credits: Optional[str] = Field(default=None, alias="limitCredits")
    spent_credits: str = Field(alias="spentCredits")
    remaining_credits: Optional[str] = Field(default=None, alias="remainingCredits")

    class Config:
        populate_by_name = True


class EaasIssuedSession(BaseModel):
    principal_id: str = Field(alias="principalId")
    token: str
    expires_at: str = Field(alias="expiresAt")
    effective_scopes: List[str] = Field(alias="effectiveScopes")
    effective_budget: EaasPrincipalBudgetView = Field(alias="effectiveBudget")

    class Config:
        populate_by_name = True


class EaasConversationView(BaseModel):
    conversation_id: str = Field(alias="conversationId")
    agent_im_user_id: Optional[str] = Field(default=None, alias="agentImUserId")
    agent_name: str = Field(alias="agentName")
    created: Optional[bool] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    last_message_at: Optional[str] = Field(default=None, alias="lastMessageAt")
    message_count: Optional[int] = Field(default=None, alias="messageCount")

    class Config:
        populate_by_name = True


class EaasTextBlock(BaseModel):
    """多模态输入块 — text 形（EaaS v1 wire 子集，对齐 server src/tenant/message-content.ts）。"""

    kind: Literal["text"]
    text: str

    class Config:
        populate_by_name = True


class EaasImageBlock(BaseModel):
    """多模态输入块 — image 形（以 IM assetId 引用；mediaType 为声明型，服务端按字节派生 canonical 形）。"""

    kind: Literal["image"]
    asset_id: str = Field(alias="assetId")
    media_type: str = Field(alias="mediaType")
    alt: Optional[str] = None

    class Config:
        populate_by_name = True


EaasContentBlockInput = Union[EaasTextBlock, EaasImageBlock]
# discriminated on `kind` (pydantic resolves the Union by field set); the
# list form is what `send_message(content_blocks=...)` takes on the wire.


class EaasQuestionOption(BaseModel):
    id: str
    label: str


class EaasMessageQuestion(BaseModel):
    """agent_question 消息的结构化提问（其他消息为 null）。"""

    question_id: str = Field(alias="questionId")
    text: str
    options: List[EaasQuestionOption] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class EaasMessageAnswer(BaseModel):
    """principal_answer 消息钉住的回答（其他消息为 null）。"""

    question_id: str = Field(alias="questionId")
    option_id: Optional[str] = Field(default=None, alias="optionId")

    class Config:
        populate_by_name = True


class EaasPrincipalMessageView(BaseModel):
    id: str
    role: Literal["principal", "agent", "system"]
    content: str
    created_at: str = Field(alias="createdAt")
    kind: Optional[str] = None
    model: Optional[str] = None
    # 消息携带的多模态块（text/image 白名单投影；无块 = null）。
    content_blocks: Optional[List[EaasContentBlockInput]] = Field(
        default=None, alias="contentBlocks"
    )
    # agent_question 消息的结构化提问（其他消息为 null）。
    question: Optional[EaasMessageQuestion] = None
    # principal_answer 消息钉住的回答（其他消息为 null）。
    answer: Optional[EaasMessageAnswer] = None
    spans: Optional[Any] = None

    class Config:
        populate_by_name = True



class EaasBillingLineItem(BaseModel):
    usage_id: str = Field(alias="usageId")
    settlement_key: str = Field(alias="settlementKey")
    status: str
    interval_start: str = Field(alias="intervalStart")
    dimension: str
    seconds: int
    credits: str
    rate_version: str = Field(alias="rateVersion")
    resource_id: str = Field(alias="resourceId")
    environment_id: Optional[str] = Field(default=None, alias="environmentId")

    class Config:
        populate_by_name = True


class EaasBillingPage(BaseModel):
    items: List[EaasBillingLineItem] = Field(default_factory=list)
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")
    totals: Dict[str, str]
    settlement: Dict[str, str]

    class Config:
        populate_by_name = True


class EaasSendMessageResult(BaseModel):
    conversation_id: str = Field(alias="conversationId")
    message_id: str = Field(alias="messageId")
    run_id: Optional[str] = Field(default=None, alias="runId")
    deduplicated: bool

    class Config:
        populate_by_name = True


class EaasRunEvent(BaseModel):
    id: str
    type: str
    at: str
    message: Optional[str] = None
    payload: Any = None


class EaasRunView(BaseModel):
    run_id: str = Field(alias="runId")
    status: str
    recovery_state: str = Field(alias="recoveryState")
    message: Dict[str, Optional[str]]
    artifact_refs: List[Dict[str, Any]] = Field(default_factory=list, alias="artifactRefs")
    durability: Dict[str, bool]
    usage: Dict[str, Optional[int]]
    created_at: str = Field(alias="createdAt")
    started_at: Optional[str] = Field(default=None, alias="startedAt")
    completed_at: Optional[str] = Field(default=None, alias="completedAt")

    class Config:
        populate_by_name = True


class EaasRunEventPage(BaseModel):
    events: List[EaasRunEvent] = Field(default_factory=list)
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")
    truncated: bool = False

    class Config:
        populate_by_name = True


class EaasPublishableKeyView(BaseModel):
    id: str
    name: str = ""
    key_prefix: str = Field(alias="keyPrefix")
    project_id: str = Field(alias="projectId")
    scopes: List[str] = Field(default_factory=list)
    version: int
    created_at: str = Field(alias="createdAt")
    revoked_at: Optional[str] = Field(default=None, alias="revokedAt")

    class Config:
        populate_by_name = True


class EaasCreatedPublishableKey(BaseModel):
    id: str
    key: str
    key_prefix: str = Field(alias="keyPrefix")
    name: str = ""
    version: int
    scopes: List[str] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class EaasPrincipalSessionView(BaseModel):
    id: str
    principal_id: str = Field(alias="principalId")
    project_id: str = Field(alias="projectId")
    environment_id: Optional[str] = Field(default=None, alias="environmentId")
    provider: Literal["anonymous", "identity", "delegated"]
    scopes: List[str] = Field(default_factory=list)
    expires_at: str = Field(alias="expiresAt")
    revoked_at: Optional[str] = Field(default=None, alias="revokedAt")
    created_at: str = Field(alias="createdAt")

    class Config:
        populate_by_name = True


# ── Artifacts（Gate B Task 9 — principal turn 产物取回面）────────────────────


class EaasArtifactView(BaseModel):
    """`list_artifacts()` 单行（cloud src/tenant/artifacts.ts EaasArtifactView 镜像）。"""

    artifact_id: str = Field(alias="artifactId")
    filename: str
    mime: str
    # sha256 hex（内容寻址；下载面 hash header 同源值）。
    content_hash: str = Field(alias="contentHash")
    size_bytes: int = Field(alias="sizeBytes")
    conversation_id: str = Field(alias="conversationId")
    message_id: str = Field(alias="messageId")
    created_at: str = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class EaasArtifactList(BaseModel):
    """`list_artifacts()` data 面（scoped 到 session 直绑 env ∧ 本 principal，旧→新；limit 1..200 缺省 50）。"""

    environment_id: str = Field(alias="environmentId")
    artifacts: List[EaasArtifactView] = Field(default_factory=list)
    truncated: bool = False

    class Config:
        populate_by_name = True


# ── Events JSON replay（GET /api/v1/events，缺省 Accept）──────────────────────


class EaasEventReplayPage(BaseModel):
    """`list_events()` data 面。nextCursor 为 seq 字符串——uint64 走 JSON number 不安全。"""

    events: List[EaasEventEnvelope] = Field(default_factory=list)
    next_cursor: str = Field(alias="nextCursor")
    truncated: bool = False

    class Config:
        populate_by_name = True


# ── Tenant-private skill catalog（Gate B T8 — /api/v1/skills，operator-only）──


class EaasPrivateSkillView(BaseModel):
    """管理面行投影（不含 content 全文——list 面零必要不回传）。"""

    skill_id: str = Field(alias="skillId")
    tenant_id: str = Field(alias="tenantId")
    slug: str
    name: str
    description: str = ""
    license: str = ""
    status: Literal["private", "published"]
    content_manifest: Optional[List[Dict[str, Any]]] = Field(
        default=None, alias="contentManifest"
    )
    approval_id: Optional[str] = Field(default=None, alias="approvalId")
    published_at: Optional[str] = Field(default=None, alias="publishedAt")
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")

    class Config:
        populate_by_name = True


class EaasPrivateSkillDetail(EaasPrivateSkillView):
    """`get()` data 面（list 投影 + content 全文）。"""

    content: str = ""


class EaasPrivateSkillList(BaseModel):
    """`list()` data 面（createdAt desc，服务端 take 200）。"""

    skills: List[EaasPrivateSkillView] = Field(default_factory=list)

    class Config:
        populate_by_name = True


class EaasSkillPublishPublished(BaseModel):
    status: Literal["published"]
    approval_id: None = Field(default=None, alias="approvalId")
    already_published: bool = Field(alias="alreadyPublished")

    class Config:
        populate_by_name = True


class EaasSkillPublishPending(BaseModel):
    """202 形——owner DM 审批受理（skill 保持 private）。"""

    status: Literal["pending_approval"]
    approval_id: str = Field(alias="approvalId")
    skill_status: Literal["private"] = Field(alias="skillStatus")

    class Config:
        populate_by_name = True


EaasSkillPublishResult = Union[EaasSkillPublishPublished, EaasSkillPublishPending]


# ── Warm pool（spec §4 逐字）────────────────────────────────────────────────


class PoolPreference(BaseModel):
    pool_id: str = Field(alias="poolId")
    enabled: bool
    min_ready: int = Field(alias="minReady", ge=0, le=5)
    max_ready: int = Field(alias="maxReady", ge=0, le=5)
    idle_retention_seconds: int = Field(alias="idleRetentionSeconds", ge=0, le=1800)
    priority: int = Field(ge=0, le=1000)
    on_miss: Literal["cold", "reject"] = Field(alias="onMiss")

    class Config:
        populate_by_name = True


class ProjectPoolManagement(BaseModel):
    """Full replacement; cross-field and platform ceilings validated by Cloud."""
    max_ready: int = Field(alias="maxReady", ge=0, le=5)
    daily_budget_credits: str = Field(alias="dailyBudgetCredits")
    default_pool_id: str = Field(alias="defaultPoolId")
    fallback_pool_ids: List[str] = Field(alias="fallbackPoolIds")
    pools: List[PoolPreference]

    class Config:
        populate_by_name = True


class PoolPolicyStatus(BaseModel):
    revision: int
    observed_revision: int = Field(alias="observedRevision")
    config_revision: str = Field(alias="configRevision")
    allowed_pool_ids: List[str] = Field(alias="allowedPoolIds")
    policy: ProjectPoolManagement

    class Config:
        populate_by_name = True


class ProjectPoolInventory(BaseModel):
    known: bool
    source: Literal["eaas", "provider"]
    ready: Optional[int]
    provisioning: Optional[int]
    terminating: Optional[int]
    observed_at: Optional[str] = Field(alias="observedAt")

    class Config:
        populate_by_name = True


class ProjectPoolTarget(BaseModel):
    min_ready: int = Field(alias="minReady")
    max_ready: int = Field(alias="maxReady")

    class Config:
        populate_by_name = True


class EaasProfileResources(BaseModel):
    cpu_request: str = Field(alias="cpuRequest")
    cpu_limit: str = Field(alias="cpuLimit")
    memory_request: str = Field(alias="memoryRequest")
    memory_limit: str = Field(alias="memoryLimit")

    class Config:
        populate_by_name = True


class ProjectPoolStatus(BaseModel):
    pool_id: str = Field(alias="poolId")
    placement_id: str = Field(alias="placementId")
    provider_kind: str = Field(alias="providerKind")
    mode: Literal["cold", "warm", "provider-managed"]
    default: bool
    available: Optional[bool] = None
    mapping_revision: Optional[str] = Field(default=None, alias="mappingRevision")
    template_version: Optional[str] = Field(default=None, alias="templateVersion")
    profile_revision: Optional[str] = Field(default=None, alias="profileRevision")
    resources: Optional[EaasProfileResources] = None
    network_policy_revision: Optional[str] = Field(default=None, alias="networkPolicyRevision")
    storage_policy_revision: Optional[str] = Field(default=None, alias="storagePolicyRevision")
    desired: ProjectPoolTarget
    effective_target: Optional[int] = Field(alias="effectiveTarget")
    state: Literal["draining", "disabled", "unknown", "degraded", "reconciling", "ready"]
    inventory: ProjectPoolInventory
    retired_inventory: int = Field(alias="retiredInventory")
    reason: Optional[Literal[
        "budget_exhausted", "capacity_limited", "provider_inventory_unknown",
        "mapping_not_activated", "template_binding_required", "pricing_unavailable",
    ]]

    class Config:
        populate_by_name = True


class PoolActivationStatus(BaseModel):
    desired_revision: Optional[str] = Field(alias="desiredRevision")
    observed_revision: Optional[str] = Field(alias="observedRevision")
    phase: str
    fresh_until: Optional[str] = Field(alias="freshUntil")

    class Config:
        populate_by_name = True


class ProjectPoolsPage(BaseModel):
    pools: List[ProjectPoolStatus]
    next_cursor: Optional[str] = Field(alias="nextCursor")
    activation: PoolActivationStatus
    policy_revision: int = Field(alias="policyRevision")
    observed_at: str = Field(alias="observedAt")

    class Config:
        populate_by_name = True


class WarmPoolPolicy(BaseModel):
    """desired state，挂在 project 上。"""

    min_ready: int = Field(default=0, alias="minReady")
    max_ready: int = Field(default=0, alias="maxReady")
    idle_retention_seconds: int = Field(default=0, alias="idleRetentionSeconds")
    daily_budget_credits: str = Field(default="0", alias="dailyBudgetCredits")
    on_miss: Literal["cold", "fail"] = Field(default="cold", alias="onMiss")

    class Config:
        populate_by_name = True


class WarmPoolEffective(BaseModel):
    state: Literal["disabled", "reconciling", "ready", "degraded"]
    ready: int
    provisioning: int
    terminating: int
    reason: Optional[
        Literal[
            "budget_exhausted",
            "quota_exceeded",
            "provider_unavailable",
            "template_changed",
        ]
    ] = None


class WarmPoolCost(BaseModel):
    rate_version: Optional[str] = Field(default=None, alias="rateVersion")
    estimated_hourly_credits: str = Field(alias="estimatedHourlyCredits")
    spent_today_credits: str = Field(alias="spentTodayCredits")
    reserved_credits: str = Field(alias="reservedCredits")
    remaining_today_credits: str = Field(alias="remainingTodayCredits")
    period_start: str = Field(alias="periodStart")
    period_end: str = Field(alias="periodEnd")

    class Config:
        populate_by_name = True


class WarmPoolStatus(BaseModel):
    """GET/PATCH/dryRun 统一返回（API 草案逐字）。"""

    revision: int
    observed_revision: int = Field(alias="observedRevision")
    desired: WarmPoolPolicy
    effective: WarmPoolEffective
    cost: WarmPoolCost

    class Config:
        populate_by_name = True

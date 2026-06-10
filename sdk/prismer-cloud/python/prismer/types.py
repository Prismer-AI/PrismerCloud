"""Type definitions for Prismer SDK — covers Context, Parse, and IM APIs."""

from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field


# ============================================================================
# Environment
# ============================================================================

ENVIRONMENTS: Dict[str, str] = {
    "production": "https://prismer.cloud",
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


#: v2.0 §4.6 — 8-variant ContentBlock discriminated union
ContentBlock = Union[
    ContentBlockText,
    ContentBlockImage,
    ContentBlockAudio,
    ContentBlockVideo,
    ContentBlockFile,
    ContentBlockToolUse,
    ContentBlockToolResult,
    ContentBlockReasoning,
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

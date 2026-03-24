"""Type definitions for Prismer SDK — covers Context, Parse, and IM APIs."""

from typing import Any, Dict, List, Literal, Optional
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
    estimated_time: Optional[int] = Field(default=None, alias="estimatedTime")

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


class IMMessage(BaseModel):
    id: str
    conversation_id: Optional[str] = Field(default=None, alias="conversationId")
    content: str
    type: str
    sender_id: str = Field(alias="senderId")
    parent_id: Optional[str] = Field(default=None, alias="parentId")
    status: Optional[str] = None
    created_at: str = Field(alias="createdAt")
    updated_at: Optional[str] = Field(default=None, alias="updatedAt")
    metadata: Optional[Any] = None

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


class IMResult(BaseModel):
    """Generic IM API response wrapper."""
    ok: bool
    data: Optional[Any] = None
    meta: Optional[Dict[str, Any]] = None
    error: Optional[PrismerError] = None


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

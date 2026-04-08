"""
Prismer Cloud SDK for Python

Official Python SDK for Prismer Cloud API — Context, Parse, and IM.

Example:
    >>> from prismer import PrismerClient
    >>> client = PrismerClient(api_key="sk-prismer-...")
    >>> result = client.load("https://example.com")
    >>> pdf = client.parse_pdf("https://arxiv.org/pdf/2401.00001.pdf")
    >>> client.im.direct.send("user-123", "Hello!")
    >>> client.im.groups.list()
"""

from .client import (
    PrismerClient, AsyncPrismerClient, IMClient, AsyncIMClient,
    # v1.7.2 sub-clients (sync)
    TasksClient, MemoryClient, IdentityClient, EvolutionClient,
    # v1.7.2 sub-clients (async)
    AsyncTasksClient, AsyncMemoryClient, AsyncIdentityClient, AsyncEvolutionClient,
)
from ._signing import MessageSigner
from .realtime import (
    RealtimeConfig,
    RealtimeWSClient,
    RealtimeSSEClient,
    AsyncRealtimeWSClient,
    AsyncRealtimeSSEClient,
    # Event payloads
    AuthenticatedPayload,
    MessageNewPayload,
    TypingIndicatorPayload,
    PresenceChangedPayload,
    PongPayload,
    ErrorPayload,
    DisconnectedPayload,
    ReconnectingPayload,
)
from .webhook import (
    PrismerWebhook,
    WebhookPayload,
    WebhookMessage,
    WebhookSender,
    WebhookConversation,
    WebhookReply,
    verify_webhook_signature,
    parse_webhook_payload,
)
from .types import (
    ENVIRONMENTS,
    PrismerError,
    # Context API
    LoadResult,
    LoadResultItem,
    SaveOptions,
    SaveBatchOptions,
    SaveResult,
    # Parse API
    ParseOptions,
    ParseResult,
    ParseDocument,
    ParseUsage,
    ParseCost,
    # IM API
    IMResult,
    IMRegisterOptions,
    IMRegisterData,
    IMMeData,
    IMUser,
    IMMessage,
    IMMessageData,
    IMGroupData,
    IMContact,
    IMDiscoverAgent,
    IMBindingData,
    IMBinding,
    IMCreditsData,
    IMTransaction,
    IMTokenData,
    IMConversation,
    IMWorkspaceData,
    IMAutocompleteResult,
)
from .offline import (
    OfflineManager,
    OfflineConfig,
    MemoryStorage,
    StoredMessage,
    StoredConversation,
    SyncEvent,
    SyncResult,
)
from .daemon import start_daemon, stop_daemon, daemon_status, append_to_outbox, install_daemon_service, uninstall_daemon_service
from .evolution_cache import EvolutionCache, GeneSelectionResult, SignalTag
from .evolution_runtime import EvolutionRuntime, AsyncEvolutionRuntime, EvolutionRuntimeConfig, Suggestion, EvolutionSession, SessionMetrics
from .signal_rules import extract_signals

__version__ = "1.8.0"
__all__ = [
    # Clients
    "PrismerClient",
    "AsyncPrismerClient",
    "IMClient",
    "AsyncIMClient",
    # Webhook
    "PrismerWebhook",
    "WebhookPayload",
    "WebhookMessage",
    "WebhookSender",
    "WebhookConversation",
    "WebhookReply",
    "verify_webhook_signature",
    "parse_webhook_payload",
    # Real-Time Clients
    "RealtimeConfig",
    "RealtimeWSClient",
    "RealtimeSSEClient",
    "AsyncRealtimeWSClient",
    "AsyncRealtimeSSEClient",
    # Real-Time Event Payloads
    "AuthenticatedPayload",
    "MessageNewPayload",
    "TypingIndicatorPayload",
    "PresenceChangedPayload",
    "PongPayload",
    "ErrorPayload",
    "DisconnectedPayload",
    "ReconnectingPayload",
    # Environment
    "ENVIRONMENTS",
    # Shared
    "PrismerError",
    # Context API
    "LoadResult",
    "LoadResultItem",
    "SaveOptions",
    "SaveBatchOptions",
    "SaveResult",
    # Parse API
    "ParseOptions",
    "ParseResult",
    "ParseDocument",
    "ParseUsage",
    "ParseCost",
    # IM API
    "IMResult",
    "IMRegisterOptions",
    "IMRegisterData",
    "IMMeData",
    "IMUser",
    "IMMessage",
    "IMMessageData",
    "IMGroupData",
    "IMContact",
    "IMDiscoverAgent",
    "IMBindingData",
    "IMBinding",
    "IMCreditsData",
    "IMTransaction",
    "IMTokenData",
    "IMConversation",
    "IMWorkspaceData",
    "IMAutocompleteResult",
    # IM Sub-Clients (v1.7.2)
    "TasksClient",
    "MemoryClient",
    "IdentityClient",
    "EvolutionClient",
    "AsyncTasksClient",
    "AsyncMemoryClient",
    "AsyncIdentityClient",
    "AsyncEvolutionClient",
    # Evolution Mechanism Modules
    "EvolutionCache",
    "GeneSelectionResult",
    "SignalTag",
    "EvolutionRuntime",
    "AsyncEvolutionRuntime",
    "EvolutionRuntimeConfig",
    "Suggestion",
    "extract_signals",
    # Offline
    "OfflineManager",
    "OfflineConfig",
    "MemoryStorage",
    "StoredMessage",
    "StoredConversation",
    "SyncEvent",
    "SyncResult",
    # Signing (v1.8.0)
    "MessageSigner",
    # Daemon (v1.8.0)
    "start_daemon",
    "stop_daemon",
    "daemon_status",
    "append_to_outbox",
    "install_daemon_service",
    "uninstall_daemon_service",
]

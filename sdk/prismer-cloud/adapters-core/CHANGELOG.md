# @prismer/adapters-core — Changelog

## v0.1.0 (2026-04-22)

### Added — **Initial Release**

#### Adapter Base Classes
- **`BaseAdapter`**: Abstract base class for all PARA adapters
  - `initialize()`: Adapter initialization lifecycle hook
  - `connect()`: Establish connection to runtime
  - `disconnect()`: Clean shutdown and cleanup
  - `sendEvent()`: Send PARA events to runtime
  - `onEvent()`: Event handler registration
  - `getStatus()`: Query adapter status
  - `getCapabilities()`: Discover adapter capabilities

#### Runtime Adapter (`RuntimeAdapter`)
- **`RuntimeAdapter`**: Concrete implementation for runtime-daemon communication
  - **Connection Management**: WebSocket-based persistent connection with auto-reconnect
  - **Event Streaming**: Bidirectional PARA event streaming with buffering
  - **Command Execution**: Execute commands on runtime with response handling
  - **Heartbeat Monitoring**: Keep-alive mechanism with configurable intervals
  - **Error Recovery**: Automatic error detection and recovery strategies
  - **Capability Discovery**: Query and cache runtime capabilities
  - **Session Management**: Session lifecycle management (start/heartbeat/end)
  - **Logging**: Structured logging with context and correlation IDs

#### Cloud Adapter (`CloudAdapter`)
- **`CloudAdapter`**: Concrete implementation for cloud relay communication
  - **REST API Client**: Type-safe HTTP client for cloud APIs
  - **Pairing Flow**: Complete QR-based pairing flow implementation
  - **Binding Management**: CRUD operations for agent-to-runtime bindings
  - **Command Queue**: Fetch and manage pending remote commands
  - **Push Notification**: Register APNS/FCM tokens for push notifications
  - **Task Routing**: Route tasks to appropriate agents via runtime
  - **Relay Service**: WebSocket relay for cloud-to-runtime communication
  - **Authentication**: JWT-based auth with token refresh

#### Agent Adapter (`AgentAdapter`)
- **`AgentAdapter`**: Base class for agent-specific PARA adapters
  - **Tool Registration**: Register tool capabilities with runtime
  - **Tool Execution**: Execute tools via runtime with marshaling
  - **Capability Declaration**: Declare agent capabilities for discovery
  - **Event Publishing**: Publish agent events to PARA event bus
  - **Session Context**: Maintain session context across tool calls
  - **Error Handling**: Structured error reporting and recovery
  - **Metrics Collection**: Track execution metrics (latency, success rate)

#### Event Handling
- **`EventHandler`**: Type-safe event handler registration system
  - Event routing by type with discriminated unions
  - Async event processing with backpressure handling
  - Event filtering and transformation middleware
  - Error boundaries for event handlers
  - Event replay capability for debugging

#### Serialization & Deserialization
- **`EventSerializer`**: PARA event serialization utilities
  - JSON serialization with Zod validation
  - Type-safe deserialization with runtime type guards
  - Binary serialization support (MessagePack, optional)
  - Version-aware serialization for protocol evolution
  - Compression support (gzip, optional)

#### Configuration
- **`AdapterConfig`**: Centralized configuration management
  - Runtime endpoint configuration
  - Cloud API configuration
  - Authentication credentials management
  - Timeout and retry configuration
  - Feature flags and capability toggles
  - Environment-specific config resolution

#### Logging & Monitoring
- **`AdapterLogger`**: Structured logging adapter
  - Correlation ID propagation across events
  - Structured log levels (debug, info, warn, error)
  - Log aggregation hooks for external services
  - Performance metrics tracking
  - Error tracking and alerting

#### Security
- **Signature Verification**: Ed25519 signature validation for all incoming events
- **Authentication**: JWT token validation and refresh
- **Authorization**: Capability-based access control
- **Secure Communication**: TLS enforcement for all network connections
- **Secret Management**: Secure storage of API keys and credentials

#### Utilities
- **`RetryPolicy`**: Configurable retry logic with exponential backoff
- **`BackoffStrategy`**: Multiple backoff strategies (exponential, linear, fixed)
- **`CircuitBreaker`**: Circuit breaker pattern for fault tolerance
- **`RateLimiter`**: Token bucket rate limiting for API calls
- **`TimeoutManager`**: Configurable timeout handling with cancellation

#### TypeScript Types
- Full TypeScript type definitions for all adapter interfaces
- Generic type parameters for extensibility
- Strict type guards for runtime validation
- Exported types for use in adapter implementations

#### Tests
- Comprehensive test suite covering:
  - Base adapter lifecycle (initialize, connect, disconnect)
  - Runtime adapter connection management
  - Runtime adapter event streaming
  - Runtime adapter command execution
  - Cloud adapter pairing flow
  - Cloud adapter binding management
  - Cloud adapter task routing
  - Agent adapter tool registration
  - Agent adapter tool execution
  - Event handling and routing
  - Serialization and deserialization
  - Error handling and recovery
  - Configuration management
  - Security (signature verification, auth)

#### Documentation
- Complete API reference with examples
- Adapter implementation guide in `ADAPTERS.md`
- Protocol integration guide in `INTEGRATION.md`
- Type definitions with JSDoc comments
- Migration guide for future versions

### Notes
- This package provides shared utilities for all PARA adapters
- Runtime, Cloud, and Agent adapters extend base classes from this package
- Breaking changes will bump major version (0.2.0, 1.0.0, etc.)
- Backward-compatible additions bump minor version (0.1.1, 0.1.2, etc.)
- All adapters must implement the `BaseAdapter` interface for consistency

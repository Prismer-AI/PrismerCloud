# @prismer/wire — Changelog

## v0.1.0 (2026-04-22)

### Added — **Initial Release**

#### PARA Wire Protocol Schemas
- **Event Schemas**: `PARAEvent` base type with 13 event variants
  - `ToolCallEvent`: Tool invocation with name, arguments, and metadata
  - `ToolResultEvent`: Tool execution result with success/failure status
  - `ToolErrorEvent`: Tool execution error with stack trace
  - `CapabilityDeclareEvent`: Agent capability registration
  - `HeartbeatEvent`: Runtime health and status
  - `CommandEvent`: Remote command execution request
  - `CommandResultEvent`: Command execution response
  - `SessionStartEvent`: Session initialization with context
  - `SessionEndEvent`: Session termination with metrics
  - `StatusEvent`: Runtime status update
  - `ConfigEvent`: Configuration change notification
  - `LogEvent`: Structured logging event
  - `ErrorEvent`: Critical error notification

#### Capability Descriptor Schemas
- **`CapabilityDescriptor`**: Complete agent capability definition
  - `name`: Unique capability identifier
  - `description`: Human-readable description
  - `inputSchema`: JSON Schema for input validation
  - `outputSchema`: JSON Schema for output validation
  - `tier`: Performance tier (L1/L2/L3)
  - `tags`: Capability tags for discovery
  - `metadata`: Additional key-value metadata

#### Message Envelope Schemas
- **`PARAEnvelope`**: Wire format for PARA messages
  - `version`: Protocol version (current: "0.1.0")
  - `type`: Message type identifier
  - `timestamp`: Unix timestamp (ms)
  - `agentId`: Sending agent identifier
  - `sessionId`: Session identifier (optional)
  - `eventId`: Unique event identifier
  - `signature`: Ed25519 signature for authenticity
  - `payload`: Event-specific data (variant type)

#### Validation & Utilities
- **Schema Validation**: Zod schemas for all PARA wire types
- **Signature Verification**: Ed25519 signature validation utilities
- **Event Serialization**: JSON serialization/deserialization with type safety
- **Event Builder**: Fluent API for constructing PARA events
- **Version Compatibility**: Protocol version negotiation utilities

#### TypeScript Types
- Full TypeScript type definitions for all PARA wire schemas
- Union types for event variants with discriminated unions
- Strict type guards for runtime type checking
- Exported types for use across PARA ecosystem

#### Tests
- Comprehensive test suite covering:
  - Event schema validation (all 13 event types)
  - Capability descriptor validation
  - Message envelope construction and parsing
  - Signature verification
  - Version compatibility
  - Edge cases and error handling
  - Round-trip serialization/deserialization

#### Documentation
- Complete API reference with examples
- Protocol specification in `PROTOCOL.md`
- Type definitions with JSDoc comments
- Migration guide for future versions

### Notes
- This is the canonical source of truth for PARA wire protocol schemas
- All PARA adapters (runtime, cloud, agent) must implement this spec
- Breaking changes will bump major version (0.2.0, 1.0.0, etc.)
- Backward-compatible additions bump minor version (0.1.1, 0.1.2, etc.)

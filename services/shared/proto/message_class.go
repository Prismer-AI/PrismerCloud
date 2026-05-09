// Package proto defines the Phase A WebSocket envelope v2 and message
// classification rules. The authoritative spec lives in
// docs/phase_a_protocol_contract.md; this file MUST stay byte-exact aligned
// with §1 / §2 / §3 of that document, as enforced by
// scripts/phase_a/schema_contract_guard.sh in CI.
package proto

// MessageClass distinguishes state-machine messages from event-stream
// messages. Drives idempotency strategy:
//   - Stateful: CAS on (execution_id, state_version) — linearized state transitions
//   - Stream:   monotonic seq per (execution_id, stream_id) — append-only dedup
//   - Legacy:   pre-v2 envelope, best-effort, no dedup
type MessageClass string

const (
	// MessageClassStateful covers messages that trigger a state transition.
	// claim/finish/cancel/approve/push are stateful.
	// Use (execution_id, state_version) CAS, see contract §2.2.
	MessageClassStateful MessageClass = "stateful"

	// MessageClassStream covers high-frequency append-only messages.
	// log/output/heartbeat are stream class.
	// Use per-stream monotonic seq; no CAS, see contract §2.3.
	MessageClassStream MessageClass = "stream"

	// MessageClassLegacy is assigned when a pre-v2 envelope arrives without a
	// message_class field. Legacy messages bypass dedup entirely and route to
	// a best-effort handler. After all daemon fleet upgrades to v2, this
	// branch goes cold and can be removed in V4. See contract §2.4 / §2.4.1.
	MessageClassLegacy MessageClass = "legacy"
)

// AckType determines whether the server must ack and how the client retries.
// See contract §4.
type AckType string

const (
	// AckTypeRequired: server MUST ack; client retries with exponential backoff
	// (200ms initial, 5s max, 5 attempts) on missing ack. Used for state
	// transitions.
	AckTypeRequired AckType = "required"

	// AckTypeBestEffort: server MAY ack; client does not retry. Used for
	// log/heartbeat.
	AckTypeBestEffort AckType = "best_effort"

	// AckTypeNone: no ack semantics. Used for server-initiated push mirrors.
	AckTypeNone AckType = "none"
)

// statefulMessageTypes lists the message types that belong to the stateful
// class. Mirror of contract §3.
var statefulMessageTypes = map[string]bool{
	"runtime.hello":             true,
	"runtime.capability_report": true,
	"task.push":                 true,
	"task.accepted":             true,
	"task.rejected":             true,
	"task.finished":             true,
	"task.cancel":               true,
	"approval.request":          true,
	"approval.decision":         true,
	"stream.resume_request":     true, // contract §2.3.1
	"stream.resume_ack":         true,
}

// streamMessageTypes lists the message types that belong to the stream class.
// Mirror of contract §3.
var streamMessageTypes = map[string]bool{
	"runtime.heartbeat":     true,
	"runtime.heartbeat_ack": true,
	"task.log_chunk":        true,
	"task.progress":         true,
}

// ClassifyMessage returns the MessageClass for a given message type.
// Falls back to MessageClassStateful for unknown types (safe default for
// state-mutating semantics).
func ClassifyMessage(msgType string) MessageClass {
	if streamMessageTypes[msgType] {
		return MessageClassStream
	}
	if statefulMessageTypes[msgType] {
		return MessageClassStateful
	}
	return MessageClassStateful
}

// IsKnownMessageType reports whether the message type is in the Phase A
// contract §3 matrix. Unknown types should be rejected with code=400.
func IsKnownMessageType(msgType string) bool {
	return statefulMessageTypes[msgType] || streamMessageTypes[msgType]
}

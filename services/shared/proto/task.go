package proto

import "encoding/json"

type TaskPushPayload struct {
	TaskID           string          `json:"task_id"`
	ExecutionID      string          `json:"execution_id"`
	Title            string          `json:"title"`
	Capability       string          `json:"capability"`
	Input            json.RawMessage `json:"input"`
	ContextURI       string          `json:"context_uri,omitempty"`
	TimeoutMs        int64           `json:"timeout_ms,omitempty"`
	RequiresApproval bool            `json:"requires_approval"`
	CreatorDid       string          `json:"creator_did,omitempty"`
}

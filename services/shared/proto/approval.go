package proto

import "encoding/json"

type ApprovalRequestPayload struct {
	ApprovalID       string          `json:"approval_id"`
	TaskID           string          `json:"task_id"`
	Kind             string          `json:"kind"`
	Action           string          `json:"action"`
	Payload          json.RawMessage `json:"payload"`
	ApproverDID      string          `json:"approver_did,omitempty"`
	ApproverIMUserID string          `json:"approver_im_user_id,omitempty"`
	RequestSignature string          `json:"request_signature"`
	Metadata         json.RawMessage `json:"metadata,omitempty"`
}

type ApprovalDecisionPayload struct {
	ApprovalID          string `json:"approval_id"`
	TaskID              string `json:"task_id,omitempty"`
	Decision            string `json:"decision"`
	ApproverDID         string `json:"approver_did,omitempty"`
	DecisionSignature   string `json:"decision_signature,omitempty"`
	DecisionReason      string `json:"decision_reason,omitempty"`
	DelegationProof     string `json:"delegation_proof,omitempty"`
	DecidedAtMs         int64  `json:"decided_at"`
	RequestSignature    string `json:"request_signature,omitempty"`
	ApprovalExpiresAtMs int64  `json:"approval_expires_at,omitempty"`
}

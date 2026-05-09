package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	dispatcherpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/dispatcher"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

var debugTaskSeq uint64
var debugStateSeq int64

type createTaskRequest struct {
	ID               string          `json:"id"`
	Title            string          `json:"title"`
	Description      string          `json:"description"`
	Capability       string          `json:"capability"`
	Input            json.RawMessage `json:"input"`
	ContextURI       string          `json:"context_uri"`
	CreatorID        string          `json:"creator_id"`
	CreatorDid       string          `json:"creator_did"`
	TimeoutMs        int64           `json:"timeout_ms"`
	MaxRetries       int64           `json:"max_retries"`
	RetryDelayMs     int64           `json:"retry_delay_ms"`
	RequiresApproval bool            `json:"requires_approval"`
	Metadata         json.RawMessage `json:"metadata"`
	AutoDispatch     bool            `json:"auto_dispatch"`
}

type dispatchTaskRequest struct {
	TaskID string `json:"task_id"`
}

type createSigningKeyRequest struct {
	ID         string `json:"id"`
	DID        string `json:"did"`
	KeyVersion int64  `json:"key_version"`
	PublicKey  string `json:"public_key"`
	Algorithm  string `json:"algorithm"`
	KeyID      string `json:"key_id"`
	Metadata   string `json:"metadata"`
}

type createApprovalRequest struct {
	ID               string `json:"id"`
	TaskID           string `json:"task_id"`
	Kind             string `json:"kind"`
	Action           string `json:"action"`
	Payload          string `json:"payload"`
	RequestedByDid   string `json:"requested_by_did"`
	ApproverDid      string `json:"approver_did"`
	ApproverIMUserID string `json:"approver_im_user_id"`
	RequestSignature string `json:"request_signature"`
	Metadata         string `json:"metadata"`
}

type decideApprovalRequest struct {
	ApprovalID        string `json:"approval_id"`
	Status            string `json:"status"`
	DecisionReason    string `json:"decision_reason"`
	DecisionSignature string `json:"decision_signature"`
	DelegationProof   string `json:"delegation_proof"`
}

type createTaskResponse struct {
	Task       shareddb.Task                 `json:"task"`
	Dispatched *dispatcherpkg.DispatchResult `json:"dispatched,omitempty"`
}

type RuntimeMessageSender interface {
	Send(ctx context.Context, runtimeID string, message []byte) error
}

func registerDebugHandlers(mux *http.ServeMux, store shareddb.Store, taskDispatcher TaskDispatcher, runtimeSender RuntimeMessageSender) {
	mux.HandleFunc("/debug/tasks", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			http.Error(w, "task id required", http.StatusBadRequest)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleCreateTask(w, r, store, taskDispatcher)
	})
	mux.HandleFunc("/debug/tasks/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleGetTask(w, r, store)
	})
	mux.HandleFunc("/debug/tasks/dispatch", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleDispatchTask(w, r, taskDispatcher)
	})
	mux.HandleFunc("/debug/signing-keys", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleCreateSigningKey(w, r, store)
	})
	mux.HandleFunc("/debug/approvals", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleCreateApproval(w, r, store)
	})
	mux.HandleFunc("/debug/approvals/decide", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleDecideApproval(w, r, store, runtimeSender)
	})
}

func handleGetTask(w http.ResponseWriter, r *http.Request, store shareddb.Store) {
	taskID := strings.TrimSpace(strings.TrimPrefix(r.URL.Path, "/debug/tasks/"))
	if taskID == "" {
		http.Error(w, "task id required", http.StatusBadRequest)
		return
	}
	task, err := store.GetTask(r.Context(), taskID)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, shareddb.ErrTaskNotFound) {
			status = http.StatusNotFound
		}
		http.Error(w, fmt.Sprintf("get task: %v", err), status)
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func handleCreateTask(w http.ResponseWriter, r *http.Request, store shareddb.Store, taskDispatcher TaskDispatcher) {
	var req createTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("decode request: %v", err), http.StatusBadRequest)
		return
	}
	req.Capability = strings.TrimSpace(req.Capability)
	if req.Capability == "" {
		http.Error(w, "capability required", http.StatusBadRequest)
		return
	}

	taskID := strings.TrimSpace(req.ID)
	if taskID == "" {
		taskID = nextDebugID("task")
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = req.Capability
	}
	creatorID := strings.TrimSpace(req.CreatorID)
	if creatorID == "" {
		creatorID = "debug"
	}

	task, err := store.CreateTask(r.Context(), shareddb.CreateTaskParams{
		ID:               taskID,
		Title:            title,
		Description:      req.Description,
		Capability:       req.Capability,
		Input:            defaultRawJSON(req.Input, `{}`),
		ContextURI:       req.ContextURI,
		CreatorID:        creatorID,
		CreatorDid:       req.CreatorDid,
		Status:           "pending",
		RequiresApproval: req.RequiresApproval,
		TimeoutMs:        req.TimeoutMs,
		MaxRetries:       req.MaxRetries,
		RetryDelayMs:     req.RetryDelayMs,
		Metadata:         defaultRawJSON(req.Metadata, `{}`),
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("create task: %v", err), http.StatusInternalServerError)
		return
	}

	response := createTaskResponse{Task: task}
	if req.AutoDispatch {
		dispatched, err := taskDispatcher.DispatchTask(r.Context(), task.ID)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, dispatcherpkg.ErrNoMatchingRuntime) || errors.Is(err, dispatcherpkg.ErrTaskApprovalRequired) || errors.Is(err, dispatcherpkg.ErrTaskNotDispatchable) {
				status = http.StatusConflict
			}
			http.Error(w, fmt.Sprintf("dispatch task: %v", err), status)
			return
		}
		response.Dispatched = &dispatched
	}

	writeJSON(w, http.StatusCreated, response)
}

func handleDispatchTask(w http.ResponseWriter, r *http.Request, taskDispatcher TaskDispatcher) {
	var req dispatchTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("decode request: %v", err), http.StatusBadRequest)
		return
	}
	req.TaskID = strings.TrimSpace(req.TaskID)
	if req.TaskID == "" {
		http.Error(w, "task_id required", http.StatusBadRequest)
		return
	}

	result, err := taskDispatcher.DispatchTask(r.Context(), req.TaskID)
	if err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, dispatcherpkg.ErrNoMatchingRuntime):
			status = http.StatusConflict
		case errors.Is(err, dispatcherpkg.ErrTaskApprovalRequired):
			status = http.StatusConflict
		case errors.Is(err, dispatcherpkg.ErrTaskNotDispatchable):
			status = http.StatusConflict
		case errors.Is(err, shareddb.ErrTaskNotFound):
			status = http.StatusNotFound
		}
		http.Error(w, fmt.Sprintf("dispatch task: %v", err), status)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func handleCreateSigningKey(w http.ResponseWriter, r *http.Request, store shareddb.Store) {
	var req createSigningKeyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("decode request: %v", err), http.StatusBadRequest)
		return
	}
	req.DID = strings.TrimSpace(req.DID)
	req.PublicKey = strings.TrimSpace(req.PublicKey)
	req.KeyID = strings.TrimSpace(req.KeyID)
	if req.DID == "" || req.PublicKey == "" || req.KeyID == "" {
		http.Error(w, "did, public_key, and key_id required", http.StatusBadRequest)
		return
	}

	key, err := store.CreateSigningKey(r.Context(), shareddb.CreateSigningKeyParams{
		ID:         strings.TrimSpace(req.ID),
		DID:        req.DID,
		KeyVersion: req.KeyVersion,
		PublicKey:  req.PublicKey,
		Algorithm:  strings.TrimSpace(req.Algorithm),
		KeyID:      req.KeyID,
		Metadata:   req.Metadata,
	})
	if err != nil {
		http.Error(w, fmt.Sprintf("create signing key: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, key)
}

func handleCreateApproval(w http.ResponseWriter, r *http.Request, store shareddb.Store) {
	var req createApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("decode request: %v", err), http.StatusBadRequest)
		return
	}
	req.TaskID = strings.TrimSpace(req.TaskID)
	req.Kind = strings.TrimSpace(req.Kind)
	req.Action = strings.TrimSpace(req.Action)
	req.RequestedByDid = strings.TrimSpace(req.RequestedByDid)
	req.RequestSignature = strings.TrimSpace(req.RequestSignature)
	if req.TaskID == "" || req.Kind == "" || req.Action == "" || req.RequestedByDid == "" || req.RequestSignature == "" {
		http.Error(w, "task_id, kind, action, requested_by_did, and request_signature required", http.StatusBadRequest)
		return
	}

	approvalID := strings.TrimSpace(req.ID)
	if approvalID == "" {
		approvalID = nextDebugID("approval")
	}
	approval, err := store.CreateTaskApproval(r.Context(), shareddb.CreateTaskApprovalParams{
		ID:               approvalID,
		TaskID:           req.TaskID,
		Kind:             req.Kind,
		Action:           req.Action,
		Payload:          defaultString(req.Payload, `{}`),
		RequestedByDid:   req.RequestedByDid,
		ApproverDid:      strings.TrimSpace(req.ApproverDid),
		ApproverIMUserID: strings.TrimSpace(req.ApproverIMUserID),
		RequestSignature: req.RequestSignature,
		Metadata:         defaultString(req.Metadata, `{}`),
	})
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, shareddb.ErrTaskNotFound) {
			status = http.StatusNotFound
		}
		http.Error(w, fmt.Sprintf("create approval: %v", err), status)
		return
	}
	writeJSON(w, http.StatusCreated, approval)
}

func handleDecideApproval(w http.ResponseWriter, r *http.Request, store shareddb.Store, runtimeSender RuntimeMessageSender) {
	var req decideApprovalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("decode request: %v", err), http.StatusBadRequest)
		return
	}
	req.ApprovalID = strings.TrimSpace(req.ApprovalID)
	req.Status = strings.TrimSpace(req.Status)
	if req.ApprovalID == "" || (req.Status != "approved" && req.Status != "rejected") {
		http.Error(w, "approval_id and status=approved|rejected required", http.StatusBadRequest)
		return
	}
	pendingApproval, pendingErr := store.GetPendingApproval(r.Context(), req.ApprovalID)
	if err := store.DecideTaskApproval(r.Context(), shareddb.DecideTaskApprovalParams{
		ApprovalID:        req.ApprovalID,
		Status:            req.Status,
		DecisionReason:    req.DecisionReason,
		DecisionSignature: req.DecisionSignature,
		DelegationProof:   req.DelegationProof,
	}); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, shareddb.ErrApprovalNotFound) {
			status = http.StatusNotFound
		}
		if errors.Is(err, shareddb.ErrApprovalAlreadyDecided) {
			status = http.StatusConflict
		}
		http.Error(w, fmt.Sprintf("decide approval: %v", err), status)
		return
	}
	delivered := false
	if pendingErr == nil {
		delivered = sendApprovalDecision(r, store, runtimeSender, pendingApproval, req)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"approval_id": req.ApprovalID,
		"status":      req.Status,
		"delivered":   delivered,
	})
}

func sendApprovalDecision(r *http.Request, store shareddb.Store, runtimeSender RuntimeMessageSender, approval shareddb.TaskApproval, req decideApprovalRequest) bool {
	if runtimeSender == nil {
		return false
	}
	task, err := store.GetTask(r.Context(), approval.TaskID)
	if err != nil || task.RuntimeID == "" {
		return false
	}

	envelope, err := buildDebugStatefulEnvelope(
		approval.TaskID,
		"approval.decision",
		proto.ApprovalDecisionPayload{
			ApprovalID:        approval.ID,
			TaskID:            approval.TaskID,
			Decision:          req.Status,
			ApproverDID:       approval.ApproverDid,
			DecisionSignature: req.DecisionSignature,
			DecisionReason:    req.DecisionReason,
			DelegationProof:   req.DelegationProof,
			DecidedAtMs:       time.Now().UnixMilli(),
			RequestSignature:  approval.RequestSignature,
		},
	)
	if err != nil {
		return false
	}
	wire, err := json.Marshal(envelope)
	if err != nil {
		return false
	}
	return runtimeSender.Send(r.Context(), task.RuntimeID, wire) == nil
}

func buildDebugStatefulEnvelope(executionID string, messageType string, payload any) (proto.Envelope, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return proto.Envelope{}, err
	}
	sum := sha256.Sum256(payloadBytes)
	return proto.Envelope{
		V:            proto.ProtocolVersionV2,
		ID:           nextDebugID("msg"),
		ExecutionID:  executionID,
		Type:         messageType,
		MessageClass: proto.MessageClassStateful,
		TimestampMs:  time.Now().UnixMilli(),
		StateVersion: atomic.AddInt64(&debugStateSeq, 1),
		PayloadHash:  base64.RawURLEncoding.EncodeToString(sum[:]),
		AckType:      proto.AckTypeRequired,
		Payload:      payloadBytes,
	}, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func nextDebugID(prefix string) string {
	n := atomic.AddUint64(&debugTaskSeq, 1)
	return fmt.Sprintf("%s_%d_%d", prefix, time.Now().UnixMilli(), n)
}

func defaultRawJSON(raw json.RawMessage, fallback string) string {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return fallback
	}
	return string(raw)
}

func defaultString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

package db

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"
)

var (
	ErrRuntimeNotFound        = errors.New("runtime not found")
	ErrSessionNotFound        = errors.New("daemon session not found")
	ErrTaskNotFound           = errors.New("task not found")
	ErrTaskLogExists          = errors.New("task log already exists")
	ErrApprovalNotFound       = errors.New("approval not found")
	ErrApprovalAlreadyDecided = errors.New("approval already decided")
	ErrSigningKeyNotFound     = errors.New("signing key not found")
)

type Runtime struct {
	ID              string
	OwnerDid        string
	OwnerIMUserID   string
	Type            string
	Did             string
	PublicKey       string
	Hostname        string
	OS              string
	Arch            string
	Version         string
	Endpoint        string
	Capabilities    string
	Status          string
	Load            float64
	LastHeartbeatAt time.Time
	RegisteredAt    time.Time
	UpdatedAt       time.Time
}

type DaemonSession struct {
	ID                string
	RuntimeID         string
	StartedAt         time.Time
	TerminatedAt      *time.Time
	TerminationReason string
	Version           string
	PID               *int64
	RemoteAddr        string
	UserAgent         string
	TaskCount         int64
	LogBytes          int64
}

type Task struct {
	ID                string
	Title             string
	Description       string
	Capability        string
	Input             string
	ContextURI        string
	CreatorID         string
	CreatorDid        string
	AssigneeID        string
	AssigneeDid       string
	AssigneeType      string
	Scope             string
	ConversationID    string
	Status            string
	RuntimeID         string
	RequiresApproval  bool
	PendingApprovalID string
	TimeoutMs         int64
	Deadline          *time.Time
	MaxRetries        int64
	RetryDelayMs      int64
	RetryCount        int64
	NextRunAt         *time.Time
	Metadata          string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type TaskExecution struct {
	ID             string
	TaskID         string
	RuntimeID      string
	Attempt        int64
	Status         string
	StartedAt      time.Time
	AcceptedAt     *time.Time
	CompletedAt    *time.Time
	ExitCode       *int64
	DurationMs     *int64
	CapabilityUsed string
	CLIPath        string
	CLIVersion     string
	LogsRef        string
	ResultRef      string
	CPUSeconds     *float64
	MemoryBytes    *int64
}

type TaskLog struct {
	ID        string
	TaskID    string
	ActorID   string
	Action    string
	Message   string
	Metadata  string
	CreatedAt time.Time
}

type TaskApproval struct {
	ID                string
	TaskID            string
	Kind              string
	Action            string
	Payload           string
	RequestedByDid    string
	RequestedAt       time.Time
	ApproverDid       string
	ApproverIMUserID  string
	Status            string
	DecidedAt         *time.Time
	DecisionReason    string
	RequestSignature  string
	DecisionSignature string
	DelegationProof   string
	ExpiresAt         *time.Time
	Metadata          string
}

type SigningKey struct {
	ID         string
	DID        string
	KeyVersion int64
	PublicKey  string
	Algorithm  string
	KeyID      string
	RevokedAt  *time.Time
	ExpiresAt  *time.Time
	CreatedAt  time.Time
	Metadata   string
}

type StreamCursor struct {
	ExecutionID      string
	StreamID         string
	LastCommittedSeq int64
	UpdatedAt        time.Time
}

type RegisterRuntimeParams struct {
	ID            string
	OwnerDid      string
	OwnerIMUserID string
	Type          string
	Did           string
	PublicKey     string
	Hostname      string
	OS            string
	Arch          string
	Version       string
	Endpoint      string
	Capabilities  string
	Status        string
	Load          float64
}

type HeartbeatRuntimeParams struct {
	RuntimeID string
	Status    string
	Load      float64
}

type SetRuntimeStatusParams struct {
	RuntimeID string
	Status    string
}

type StartDaemonSessionParams struct {
	ID         string
	RuntimeID  string
	Version    string
	PID        *int64
	RemoteAddr string
	UserAgent  string
}

type ClaimTaskParams struct {
	TaskID       string
	AssigneeID   string
	AssigneeDid  string
	AssigneeType string
	RuntimeID    string
	Status       string
}

type CreateTaskParams struct {
	ID                string
	Title             string
	Description       string
	Capability        string
	Input             string
	ContextURI        string
	CreatorID         string
	CreatorDid        string
	AssigneeID        string
	AssigneeDid       string
	AssigneeType      string
	Scope             string
	ConversationID    string
	Status            string
	RequiresApproval  bool
	PendingApprovalID string
	TimeoutMs         int64
	Deadline          *time.Time
	MaxRetries        int64
	RetryDelayMs      int64
	RetryCount        int64
	NextRunAt         *time.Time
	Metadata          string
}

type InsertTaskExecutionParams struct {
	ID             string
	TaskID         string
	RuntimeID      string
	Attempt        int64
	Status         string
	CapabilityUsed string
	CLIPath        string
	CLIVersion     string
}

type CompleteTaskExecutionParams struct {
	ExecutionID string
	Status      string
	AcceptedAt  *time.Time
	CompletedAt *time.Time
	ExitCode    *int64
	DurationMs  *int64
	LogsRef     string
	ResultRef   string
	CPUSeconds  *float64
	MemoryBytes *int64
}

type SetTaskStatusParams struct {
	TaskID            string
	Status            string
	RuntimeID         string
	PendingApprovalID string
}

type SetTaskRetryStateParams struct {
	TaskID     string
	Status     string
	RetryCount int64
	NextRunAt  *time.Time
	RuntimeID  string
}

type SetTaskExecutionStatusParams struct {
	ExecutionID    string
	Status         string
	AcceptedAt     *time.Time
	CompletedAt    *time.Time
	ExitCode       *int64
	DurationMs     *int64
	CapabilityUsed string
	CLIPath        string
	CLIVersion     string
	LogsRef        string
	ResultRef      string
	CPUSeconds     *float64
	MemoryBytes    *int64
}

type InsertTaskLogParams struct {
	ID       string
	TaskID   string
	ActorID  string
	Action   string
	Message  string
	Metadata string
}

type CreateTaskApprovalParams struct {
	ID               string
	TaskID           string
	Kind             string
	Action           string
	Payload          string
	RequestedByDid   string
	ApproverDid      string
	ApproverIMUserID string
	RequestSignature string
	ExpiresAt        *time.Time
	Metadata         string
}

type CreateSigningKeyParams struct {
	ID         string
	DID        string
	KeyVersion int64
	PublicKey  string
	Algorithm  string
	KeyID      string
	RevokedAt  *time.Time
	ExpiresAt  *time.Time
	Metadata   string
}

type UpsertStreamCursorParams struct {
	ExecutionID      string
	StreamID         string
	LastCommittedSeq int64
}

type DecideTaskApprovalParams struct {
	ApprovalID        string
	Status            string
	DecisionReason    string
	DecisionSignature string
	DelegationProof   string
}

type Store interface {
	RegisterRuntime(ctx context.Context, params RegisterRuntimeParams) (Runtime, error)
	HeartbeatRuntime(ctx context.Context, params HeartbeatRuntimeParams) error
	SetRuntimeStatus(ctx context.Context, params SetRuntimeStatusParams) error
	SetRuntimeCapabilities(ctx context.Context, runtimeID string, capabilities string) error
	ListOnlineRuntimes(ctx context.Context) ([]Runtime, error)
	StartDaemonSession(ctx context.Context, params StartDaemonSessionParams) (DaemonSession, error)
	TerminateDaemonSession(ctx context.Context, sessionID string, terminationReason string) error
	CreateTask(ctx context.Context, params CreateTaskParams) (Task, error)
	GetTask(ctx context.Context, taskID string) (Task, error)
	SetTaskStatus(ctx context.Context, params SetTaskStatusParams) error
	SetTaskRetryState(ctx context.Context, params SetTaskRetryStateParams) error
	ListPendingTasksForCapability(ctx context.Context, capability string) ([]Task, error)
	ClaimTask(ctx context.Context, params ClaimTaskParams) (Task, error)
	GetTaskExecution(ctx context.Context, executionID string) (TaskExecution, error)
	InsertTaskExecution(ctx context.Context, params InsertTaskExecutionParams) (TaskExecution, error)
	SetTaskExecutionStatus(ctx context.Context, params SetTaskExecutionStatusParams) error
	CompleteTaskExecution(ctx context.Context, params CompleteTaskExecutionParams) error
	InsertTaskLog(ctx context.Context, params InsertTaskLogParams) (TaskLog, error)
	CreateTaskApproval(ctx context.Context, params CreateTaskApprovalParams) (TaskApproval, error)
	GetPendingApproval(ctx context.Context, approvalID string) (TaskApproval, error)
	DecideTaskApproval(ctx context.Context, params DecideTaskApprovalParams) error
	CreateSigningKey(ctx context.Context, params CreateSigningKeyParams) (SigningKey, error)
	GetSigningKeyByKeyID(ctx context.Context, keyID string) (SigningKey, error)
	UpsertStreamCursor(ctx context.Context, params UpsertStreamCursorParams) error
	GetStreamCursors(ctx context.Context, executionID string, streamIDs []string) ([]StreamCursor, error)
}

type MemoryStore struct {
	mu             sync.RWMutex
	runtimes       map[string]Runtime
	runtimeByDID   map[string]string
	sessions       map[string]DaemonSession
	tasks          map[string]Task
	taskExecutions map[string]TaskExecution
	taskLogs       map[string]TaskLog
	approvals      map[string]TaskApproval
	signingKeys    map[string]SigningKey
	streamCursors  map[string]StreamCursor
	now            func() time.Time
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		runtimes:       make(map[string]Runtime),
		runtimeByDID:   make(map[string]string),
		sessions:       make(map[string]DaemonSession),
		tasks:          make(map[string]Task),
		taskExecutions: make(map[string]TaskExecution),
		taskLogs:       make(map[string]TaskLog),
		approvals:      make(map[string]TaskApproval),
		signingKeys:    make(map[string]SigningKey),
		streamCursors:  make(map[string]StreamCursor),
		now:            time.Now,
	}
}

func (s *MemoryStore) PutTask(task Task) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if task.CreatedAt.IsZero() {
		task.CreatedAt = s.now()
	}
	if task.UpdatedAt.IsZero() {
		task.UpdatedAt = task.CreatedAt
	}
	s.tasks[task.ID] = task
}

func (s *MemoryStore) PutRuntimeForTest(runtime Runtime) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runtimes[runtime.ID] = runtime
	if runtime.Did != "" {
		s.runtimeByDID[runtime.Did] = runtime.ID
	}
}

func (s *MemoryStore) GetRuntime(runtimeID string) (Runtime, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	runtime, ok := s.runtimes[runtimeID]
	return runtime, ok
}

func (s *MemoryStore) GetSession(sessionID string) (DaemonSession, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[sessionID]
	return session, ok
}

func (s *MemoryStore) LookupTask(taskID string) (Task, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	task, ok := s.tasks[taskID]
	return task, ok
}

func (s *MemoryStore) LookupTaskExecution(executionID string) (TaskExecution, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	exec, ok := s.taskExecutions[executionID]
	return exec, ok
}

func (s *MemoryStore) GetTaskLog(logID string) (TaskLog, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	log, ok := s.taskLogs[logID]
	return log, ok
}

func (s *MemoryStore) GetSigningKeyForTest(keyID string) (SigningKey, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	key, ok := s.signingKeys[keyID]
	return key, ok
}

func (s *MemoryStore) GetStreamCursorForTest(executionID, streamID string) (StreamCursor, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cursor, ok := s.streamCursors[streamCursorKey(executionID, streamID)]
	return cursor, ok
}

func (s *MemoryStore) RegisterRuntime(_ context.Context, params RegisterRuntimeParams) (Runtime, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	runtime := Runtime{
		ID:              params.ID,
		OwnerDid:        params.OwnerDid,
		OwnerIMUserID:   params.OwnerIMUserID,
		Type:            params.Type,
		Did:             params.Did,
		PublicKey:       params.PublicKey,
		Hostname:        params.Hostname,
		OS:              params.OS,
		Arch:            params.Arch,
		Version:         params.Version,
		Endpoint:        params.Endpoint,
		Capabilities:    params.Capabilities,
		Status:          params.Status,
		Load:            params.Load,
		LastHeartbeatAt: now,
		UpdatedAt:       now,
	}

	if existingID, ok := s.runtimeByDID[params.Did]; ok {
		existing := s.runtimes[existingID]
		runtime.RegisteredAt = existing.RegisteredAt
	} else {
		runtime.RegisteredAt = now
	}

	s.runtimes[runtime.ID] = runtime
	s.runtimeByDID[runtime.Did] = runtime.ID
	return runtime, nil
}

func (s *MemoryStore) HeartbeatRuntime(_ context.Context, params HeartbeatRuntimeParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	runtime, ok := s.runtimes[params.RuntimeID]
	if !ok {
		return ErrRuntimeNotFound
	}
	runtime.Status = params.Status
	runtime.Load = params.Load
	runtime.LastHeartbeatAt = s.now()
	runtime.UpdatedAt = runtime.LastHeartbeatAt
	s.runtimes[params.RuntimeID] = runtime
	return nil
}

func (s *MemoryStore) SetRuntimeStatus(_ context.Context, params SetRuntimeStatusParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	runtime, ok := s.runtimes[params.RuntimeID]
	if !ok {
		return ErrRuntimeNotFound
	}
	runtime.Status = params.Status
	runtime.UpdatedAt = s.now()
	s.runtimes[params.RuntimeID] = runtime
	return nil
}

func (s *MemoryStore) SetRuntimeCapabilities(_ context.Context, runtimeID string, capabilities string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	runtime, ok := s.runtimes[runtimeID]
	if !ok {
		return ErrRuntimeNotFound
	}
	runtime.Capabilities = capabilities
	runtime.UpdatedAt = s.now()
	s.runtimes[runtimeID] = runtime
	return nil
}

func (s *MemoryStore) ListOnlineRuntimes(_ context.Context) ([]Runtime, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var runtimes []Runtime
	for _, runtime := range s.runtimes {
		switch runtime.Status {
		case "online", "idle", "busy":
			runtimes = append(runtimes, runtime)
		}
	}

	sort.Slice(runtimes, func(i, j int) bool {
		if runtimes[i].Load == runtimes[j].Load {
			return runtimes[i].LastHeartbeatAt.After(runtimes[j].LastHeartbeatAt)
		}
		return runtimes[i].Load < runtimes[j].Load
	})
	return runtimes, nil
}

func (s *MemoryStore) StartDaemonSession(_ context.Context, params StartDaemonSessionParams) (DaemonSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.runtimes[params.RuntimeID]; !ok {
		return DaemonSession{}, ErrRuntimeNotFound
	}
	session := DaemonSession{
		ID:         params.ID,
		RuntimeID:  params.RuntimeID,
		StartedAt:  s.now(),
		Version:    params.Version,
		PID:        params.PID,
		RemoteAddr: params.RemoteAddr,
		UserAgent:  params.UserAgent,
	}
	s.sessions[session.ID] = session
	return session, nil
}

func (s *MemoryStore) CreateTask(_ context.Context, params CreateTaskParams) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	task := Task{
		ID:                params.ID,
		Title:             params.Title,
		Description:       params.Description,
		Capability:        params.Capability,
		Input:             defaultJSONString(params.Input, `{}`),
		ContextURI:        params.ContextURI,
		CreatorID:         params.CreatorID,
		CreatorDid:        params.CreatorDid,
		AssigneeID:        params.AssigneeID,
		AssigneeDid:       params.AssigneeDid,
		AssigneeType:      params.AssigneeType,
		Scope:             defaultString(params.Scope, "global"),
		ConversationID:    params.ConversationID,
		Status:            defaultString(params.Status, "pending"),
		RequiresApproval:  params.RequiresApproval,
		PendingApprovalID: params.PendingApprovalID,
		TimeoutMs:         defaultInt64(params.TimeoutMs, 300000),
		Deadline:          params.Deadline,
		MaxRetries:        params.MaxRetries,
		RetryDelayMs:      defaultInt64(params.RetryDelayMs, 60000),
		RetryCount:        params.RetryCount,
		NextRunAt:         params.NextRunAt,
		Metadata:          defaultJSONString(params.Metadata, `{}`),
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	s.tasks[task.ID] = task
	return task, nil
}

func (s *MemoryStore) GetTask(ctx context.Context, taskID string) (Task, error) {
	_ = ctx
	s.mu.RLock()
	defer s.mu.RUnlock()
	task, ok := s.tasks[taskID]
	if !ok {
		return Task{}, ErrTaskNotFound
	}
	return task, nil
}

func (s *MemoryStore) SetTaskStatus(ctx context.Context, params SetTaskStatusParams) error {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	task, ok := s.tasks[params.TaskID]
	if !ok {
		return ErrTaskNotFound
	}
	task.Status = params.Status
	if params.RuntimeID != "" {
		task.RuntimeID = params.RuntimeID
	}
	if params.Status != "pending" {
		task.NextRunAt = nil
	}
	task.PendingApprovalID = params.PendingApprovalID
	task.UpdatedAt = s.now()
	s.tasks[params.TaskID] = task
	return nil
}

func (s *MemoryStore) SetTaskRetryState(ctx context.Context, params SetTaskRetryStateParams) error {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()

	task, ok := s.tasks[params.TaskID]
	if !ok {
		return ErrTaskNotFound
	}
	task.Status = params.Status
	task.RetryCount = params.RetryCount
	task.NextRunAt = params.NextRunAt
	if params.RuntimeID != "" {
		task.RuntimeID = params.RuntimeID
	}
	task.UpdatedAt = s.now()
	s.tasks[task.ID] = task
	return nil
}

func (s *MemoryStore) ListPendingTasksForCapability(ctx context.Context, capability string) ([]Task, error) {
	_ = ctx
	s.mu.RLock()
	defer s.mu.RUnlock()

	var tasks []Task
	for _, task := range s.tasks {
		if task.Status == "pending" && task.Capability == capability && (task.NextRunAt == nil || !task.NextRunAt.After(s.now())) {
			tasks = append(tasks, task)
		}
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	return tasks, nil
}

func (s *MemoryStore) GetTaskExecution(ctx context.Context, executionID string) (TaskExecution, error) {
	_ = ctx
	s.mu.RLock()
	defer s.mu.RUnlock()
	exec, ok := s.taskExecutions[executionID]
	if !ok {
		return TaskExecution{}, ErrTaskNotFound
	}
	return exec, nil
}

func (s *MemoryStore) TerminateDaemonSession(_ context.Context, sessionID string, terminationReason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.sessions[sessionID]
	if !ok {
		return ErrSessionNotFound
	}
	now := s.now()
	session.TerminatedAt = &now
	session.TerminationReason = terminationReason
	s.sessions[sessionID] = session
	return nil
}

func (s *MemoryStore) ClaimTask(_ context.Context, params ClaimTaskParams) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	task, ok := s.tasks[params.TaskID]
	if !ok {
		return Task{}, ErrTaskNotFound
	}
	task.AssigneeID = params.AssigneeID
	task.AssigneeDid = params.AssigneeDid
	task.AssigneeType = params.AssigneeType
	task.RuntimeID = params.RuntimeID
	task.Status = params.Status
	task.NextRunAt = nil
	task.UpdatedAt = s.now()
	s.tasks[params.TaskID] = task
	return task, nil
}

func (s *MemoryStore) InsertTaskExecution(_ context.Context, params InsertTaskExecutionParams) (TaskExecution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.tasks[params.TaskID]; !ok {
		return TaskExecution{}, ErrTaskNotFound
	}
	if _, ok := s.runtimes[params.RuntimeID]; !ok {
		return TaskExecution{}, ErrRuntimeNotFound
	}
	exec := TaskExecution{
		ID:             params.ID,
		TaskID:         params.TaskID,
		RuntimeID:      params.RuntimeID,
		Attempt:        params.Attempt,
		Status:         params.Status,
		StartedAt:      s.now(),
		CapabilityUsed: params.CapabilityUsed,
		CLIPath:        params.CLIPath,
		CLIVersion:     params.CLIVersion,
	}
	s.taskExecutions[exec.ID] = exec
	return exec, nil
}

func (s *MemoryStore) SetTaskExecutionStatus(_ context.Context, params SetTaskExecutionStatusParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	exec, ok := s.taskExecutions[params.ExecutionID]
	if !ok {
		return ErrTaskNotFound
	}
	exec.Status = params.Status
	if params.AcceptedAt != nil {
		exec.AcceptedAt = params.AcceptedAt
	}
	if params.CompletedAt != nil {
		exec.CompletedAt = params.CompletedAt
	}
	exec.ExitCode = params.ExitCode
	exec.DurationMs = params.DurationMs
	if params.CapabilityUsed != "" {
		exec.CapabilityUsed = params.CapabilityUsed
	}
	if params.CLIPath != "" {
		exec.CLIPath = params.CLIPath
	}
	if params.CLIVersion != "" {
		exec.CLIVersion = params.CLIVersion
	}
	if params.LogsRef != "" {
		exec.LogsRef = params.LogsRef
	}
	if params.ResultRef != "" {
		exec.ResultRef = params.ResultRef
	}
	exec.CPUSeconds = params.CPUSeconds
	exec.MemoryBytes = params.MemoryBytes
	s.taskExecutions[params.ExecutionID] = exec
	return nil
}

func (s *MemoryStore) CompleteTaskExecution(_ context.Context, params CompleteTaskExecutionParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	exec, ok := s.taskExecutions[params.ExecutionID]
	if !ok {
		return ErrTaskNotFound
	}
	exec.Status = params.Status
	exec.AcceptedAt = params.AcceptedAt
	if params.CompletedAt != nil {
		exec.CompletedAt = params.CompletedAt
	} else {
		now := s.now()
		exec.CompletedAt = &now
	}
	exec.ExitCode = params.ExitCode
	exec.DurationMs = params.DurationMs
	exec.LogsRef = params.LogsRef
	exec.ResultRef = params.ResultRef
	exec.CPUSeconds = params.CPUSeconds
	exec.MemoryBytes = params.MemoryBytes
	s.taskExecutions[params.ExecutionID] = exec
	return nil
}

func (s *MemoryStore) InsertTaskLog(_ context.Context, params InsertTaskLogParams) (TaskLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.tasks[params.TaskID]; !ok {
		return TaskLog{}, ErrTaskNotFound
	}
	log := TaskLog{
		ID:        params.ID,
		TaskID:    params.TaskID,
		ActorID:   params.ActorID,
		Action:    params.Action,
		Message:   params.Message,
		Metadata:  params.Metadata,
		CreatedAt: s.now(),
	}
	s.taskLogs[log.ID] = log
	return log, nil
}

func (s *MemoryStore) CreateTaskApproval(_ context.Context, params CreateTaskApprovalParams) (TaskApproval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if params.TaskID != "" {
		task, ok := s.tasks[params.TaskID]
		if !ok {
			return TaskApproval{}, ErrTaskNotFound
		}
		task.PendingApprovalID = params.ID
		task.RequiresApproval = true
		task.UpdatedAt = s.now()
		s.tasks[task.ID] = task
	}

	approval := TaskApproval{
		ID:               params.ID,
		TaskID:           params.TaskID,
		Kind:             params.Kind,
		Action:           params.Action,
		Payload:          params.Payload,
		RequestedByDid:   params.RequestedByDid,
		RequestedAt:      s.now(),
		ApproverDid:      params.ApproverDid,
		ApproverIMUserID: params.ApproverIMUserID,
		Status:           "pending",
		RequestSignature: params.RequestSignature,
		ExpiresAt:        params.ExpiresAt,
		Metadata:         params.Metadata,
	}
	s.approvals[approval.ID] = approval
	return approval, nil
}

func (s *MemoryStore) GetPendingApproval(_ context.Context, approvalID string) (TaskApproval, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	approval, ok := s.approvals[approvalID]
	if !ok || approval.Status != "pending" {
		return TaskApproval{}, ErrApprovalNotFound
	}
	return approval, nil
}

func (s *MemoryStore) DecideTaskApproval(_ context.Context, params DecideTaskApprovalParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	approval, ok := s.approvals[params.ApprovalID]
	if !ok {
		return ErrApprovalNotFound
	}
	if approval.Status != "pending" {
		if approval.Status == params.Status {
			return nil
		}
		return ErrApprovalAlreadyDecided
	}
	now := s.now()
	approval.Status = params.Status
	approval.DecidedAt = &now
	approval.DecisionReason = params.DecisionReason
	approval.DecisionSignature = params.DecisionSignature
	approval.DelegationProof = params.DelegationProof
	s.approvals[approval.ID] = approval

	if approval.TaskID != "" {
		if task, ok := s.tasks[approval.TaskID]; ok {
			task.PendingApprovalID = ""
			task.UpdatedAt = now
			if params.Status == "approved" {
				task.RequiresApproval = false
			}
			if params.Status == "rejected" {
				task.RequiresApproval = false
				task.Status = "cancelled"
				task.NextRunAt = nil
			}
			s.tasks[task.ID] = task

			logID := "log_" + approval.ID + "_approval_" + params.Status
			s.taskLogs[logID] = TaskLog{
				ID:        logID,
				TaskID:    task.ID,
				Action:    "approval." + params.Status,
				Message:   params.DecisionReason,
				Metadata:  `{"approval_id":"` + approval.ID + `"}`,
				CreatedAt: now,
			}
		}
	}
	return nil
}

func (s *MemoryStore) CreateSigningKey(_ context.Context, params CreateSigningKeyParams) (SigningKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	key := SigningKey{
		ID:         params.ID,
		DID:        params.DID,
		KeyVersion: defaultInt64(params.KeyVersion, 1),
		PublicKey:  params.PublicKey,
		Algorithm:  defaultString(params.Algorithm, "ed25519"),
		KeyID:      params.KeyID,
		RevokedAt:  params.RevokedAt,
		ExpiresAt:  params.ExpiresAt,
		CreatedAt:  now,
		Metadata:   defaultJSONString(params.Metadata, `{}`),
	}
	s.signingKeys[key.KeyID] = key
	return key, nil
}

func (s *MemoryStore) GetSigningKeyByKeyID(_ context.Context, keyID string) (SigningKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	key, ok := s.signingKeys[keyID]
	if !ok {
		return SigningKey{}, ErrSigningKeyNotFound
	}
	return key, nil
}

func (s *MemoryStore) UpsertStreamCursor(_ context.Context, params UpsertStreamCursorParams) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := streamCursorKey(params.ExecutionID, params.StreamID)
	existing, ok := s.streamCursors[key]
	if ok && existing.LastCommittedSeq >= params.LastCommittedSeq {
		return nil
	}
	s.streamCursors[key] = StreamCursor{
		ExecutionID:      params.ExecutionID,
		StreamID:         params.StreamID,
		LastCommittedSeq: params.LastCommittedSeq,
		UpdatedAt:        s.now(),
	}
	return nil
}

func (s *MemoryStore) GetStreamCursors(_ context.Context, executionID string, streamIDs []string) ([]StreamCursor, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	cursors := make([]StreamCursor, 0, len(streamIDs))
	for _, streamID := range streamIDs {
		cursor, ok := s.streamCursors[streamCursorKey(executionID, streamID)]
		if !ok {
			continue
		}
		cursors = append(cursors, cursor)
	}
	return cursors, nil
}

func defaultString(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func defaultJSONString(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func defaultInt64(value int64, fallback int64) int64 {
	if value == 0 {
		return fallback
	}
	return value
}

func streamCursorKey(executionID, streamID string) string {
	return executionID + "\x00" + streamID
}

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	dispatcherpkg "github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/dispatcher"
	"github.com/Prismer-AI/PrismerCloud/services/orchestrator/internal/transport"
	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

func TestNewAppRegistersHealthzAndRuntimeWS(t *testing.T) {
	app := NewApp(Config{
		ProtocolEnforce:   ProtocolEnforceStrict,
		SignatureFallback: SignatureFallbackNone,
	}, Dependencies{})

	healthReq := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	healthRec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(healthRec, healthReq)
	if healthRec.Code != http.StatusOK || healthRec.Body.String() != "ok" {
		t.Fatalf("unexpected health response: code=%d body=%q", healthRec.Code, healthRec.Body.String())
	}

	wsReq := httptest.NewRequest(http.MethodGet, "/ws/runtime", nil)
	wsRec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(wsRec, wsReq)
	if wsRec.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501 without upgrader, got %d", wsRec.Code)
	}
}

func TestNewAppReusesInjectedDependencies(t *testing.T) {
	store := shareddb.NewMemoryStore()
	upgrader := &appFakeUpgrader{}
	dispatcher := &appFakeDispatcher{}

	app := NewApp(Config{
		ProtocolEnforce:   ProtocolEnforceMixed,
		SignatureFallback: SignatureFallbackNone,
	}, Dependencies{
		Store:      store,
		Dispatcher: dispatcher,
		WSUpgrader: upgrader,
	})

	if app.Store != store {
		t.Fatal("expected injected store to be reused")
	}
	if app.Dispatcher != dispatcher {
		t.Fatal("expected injected dispatcher to be reused")
	}
	if app.Hub == nil || app.Tracker == nil || app.RuntimeWSHandler == nil || app.HTTPHandler == nil {
		t.Fatalf("expected app dependencies to be initialized: %+v", app)
	}

	wsReq := httptest.NewRequest(http.MethodGet, "/ws/runtime", nil)
	wsRec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(wsRec, wsReq)
	if wsRec.Code == http.StatusNotImplemented {
		t.Fatalf("expected configured upgrader path, got %d", wsRec.Code)
	}
}

func TestDebugCreateTaskCreatesTask(t *testing.T) {
	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		Dispatcher: &appFakeDispatcher{},
	})

	req := httptest.NewRequest(http.MethodPost, "/debug/tasks", strings.NewReader(`{"title":"Test task","capability":"noop","input":{"prompt":"hi"}}`))
	rec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%q", rec.Code, rec.Body.String())
	}

	var response struct {
		Task shareddb.Task `json:"task"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal create task response: %v", err)
	}
	if response.Task.ID == "" || response.Task.Capability != "noop" || response.Task.Input != `{"prompt":"hi"}` {
		t.Fatalf("unexpected task response: %+v", response.Task)
	}
	stored, err := store.GetTask(context.Background(), response.Task.ID)
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if stored.Title != "Test task" {
		t.Fatalf("unexpected stored task: %+v", stored)
	}
}

func TestDebugGetTaskReturnsStoredTask(t *testing.T) {
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:         "task_get_1",
		Title:      "Fetched",
		Capability: "noop",
		Status:     "pending",
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	})
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		Dispatcher: &appFakeDispatcher{},
	})

	req := httptest.NewRequest(http.MethodGet, "/debug/tasks/task_get_1", nil)
	rec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%q", rec.Code, rec.Body.String())
	}

	var task shareddb.Task
	if err := json.Unmarshal(rec.Body.Bytes(), &task); err != nil {
		t.Fatalf("json.Unmarshal(task) error = %v", err)
	}
	if task.ID != "task_get_1" || task.Title != "Fetched" {
		t.Fatalf("unexpected task payload: %+v", task)
	}
}

func TestDebugDispatchTaskCallsDispatcher(t *testing.T) {
	store := shareddb.NewMemoryStore()
	dispatcher := &appFakeDispatcher{
		result: dispatcherpkg.DispatchResult{
			RuntimeID:   "rt_1",
			ExecutionID: "exec_1",
			MessageID:   "msg_1",
		},
	}
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		Dispatcher: dispatcher,
	})

	req := httptest.NewRequest(http.MethodPost, "/debug/tasks/dispatch", strings.NewReader(`{"task_id":"task_1"}`))
	rec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%q", rec.Code, rec.Body.String())
	}
	if dispatcher.taskID != "task_1" {
		t.Fatalf("expected dispatcher to receive task_1, got %q", dispatcher.taskID)
	}
}

func TestDebugCreateSigningKeyCreatesKey(t *testing.T) {
	store := shareddb.NewMemoryStore()
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		Dispatcher: &appFakeDispatcher{},
	})

	req := httptest.NewRequest(http.MethodPost, "/debug/signing-keys", strings.NewReader(`{"did":"did:key:test","public_key":"pub","key_id":"did:key:test#k1"}`))
	rec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%q", rec.Code, rec.Body.String())
	}

	key, err := store.GetSigningKeyByKeyID(context.Background(), "did:key:test#k1")
	if err != nil {
		t.Fatalf("GetSigningKeyByKeyID() error = %v", err)
	}
	if key.DID != "did:key:test" {
		t.Fatalf("unexpected signing key: %+v", key)
	}
}

func TestDebugCreateAndDecideApproval(t *testing.T) {
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:        "task_approval",
		Title:     "approval",
		Status:    "pending",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	app := NewApp(Config{}, Dependencies{
		Store:      store,
		Dispatcher: &appFakeDispatcher{},
	})

	createReq := httptest.NewRequest(http.MethodPost, "/debug/approvals", strings.NewReader(`{"task_id":"task_approval","kind":"dangerous_action","action":"git_push_force","requested_by_did":"did:key:req","request_signature":"sig"}`))
	createRec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d body=%q", createRec.Code, createRec.Body.String())
	}

	var approval shareddb.TaskApproval
	if err := json.Unmarshal(createRec.Body.Bytes(), &approval); err != nil {
		t.Fatalf("unmarshal create approval response: %v", err)
	}
	if approval.ID == "" || approval.TaskID != "task_approval" {
		t.Fatalf("unexpected approval response: %+v", approval)
	}
	task, err := store.GetTask(context.Background(), "task_approval")
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if !task.RequiresApproval || task.PendingApprovalID != approval.ID {
		t.Fatalf("expected task approval gate to be set, got %+v", task)
	}

	decideReq := httptest.NewRequest(http.MethodPost, "/debug/approvals/decide", strings.NewReader(`{"approval_id":"`+approval.ID+`","status":"approved","decision_reason":"ok"}`))
	decideRec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(decideRec, decideReq)
	if decideRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%q", decideRec.Code, decideRec.Body.String())
	}

	task, err = store.GetTask(context.Background(), "task_approval")
	if err != nil {
		t.Fatalf("GetTask() second error = %v", err)
	}
	if task.RequiresApproval || task.PendingApprovalID != "" {
		t.Fatalf("expected task approval gate to be cleared, got %+v", task)
	}
}

func TestDebugDecideApprovalConflictingDuplicateReturnsConflict(t *testing.T) {
	store := shareddb.NewMemoryStore()
	store.PutTask(shareddb.Task{
		ID:        "task_approval",
		Title:     "approval",
		Status:    "pending",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	})
	if _, err := store.CreateTaskApproval(context.Background(), shareddb.CreateTaskApprovalParams{
		ID:               "appr_dup",
		TaskID:           "task_approval",
		Kind:             "dangerous_action",
		Action:           "deploy",
		Payload:          `{}`,
		RequestedByDid:   "did:key:req",
		RequestSignature: "sig",
		Metadata:         `{}`,
	}); err != nil {
		t.Fatalf("CreateTaskApproval() error = %v", err)
	}
	if err := store.DecideTaskApproval(context.Background(), shareddb.DecideTaskApprovalParams{
		ApprovalID: "appr_dup",
		Status:     "approved",
	}); err != nil {
		t.Fatalf("first DecideTaskApproval() error = %v", err)
	}

	app := NewApp(Config{}, Dependencies{
		Store:      store,
		Dispatcher: &appFakeDispatcher{},
	})

	req := httptest.NewRequest(http.MethodPost, "/debug/approvals/decide", strings.NewReader(`{"approval_id":"appr_dup","status":"rejected","decision_reason":"late no"}`))
	rec := httptest.NewRecorder()
	app.HTTPHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%q", rec.Code, rec.Body.String())
	}
}

type appFakeUpgrader struct{}

type appFakeDispatcher struct {
	taskID string
	result dispatcherpkg.DispatchResult
	err    error
}

func (d *appFakeDispatcher) DispatchTask(_ context.Context, taskID string) (dispatcherpkg.DispatchResult, error) {
	d.taskID = taskID
	return d.result, d.err
}

func (u *appFakeUpgrader) Upgrade(w http.ResponseWriter, _ *http.Request) (transport.SocketConn, error) {
	w.WriteHeader(http.StatusSwitchingProtocols)
	return &appFakeSocket{}, nil
}

type appFakeSocket struct{}

func (s *appFakeSocket) ReadMessage(_ context.Context) ([]byte, error) {
	return nil, io.EOF
}

func (s *appFakeSocket) WriteMessage(_ context.Context, _ []byte) error {
	return nil
}

func (s *appFakeSocket) Close() error {
	return nil
}

package approval

import (
	"encoding/json"
	"testing"

	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

func TestPolicyEvaluateDangerousAction(t *testing.T) {
	policy := Policy{
		Enforce: true,
		DangerousActions: map[string]struct{}{
			"git_push_force": {},
		},
		TaskCreateBudgetOver: 1000,
	}

	requirement, err := policy.Evaluate(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
		Input:       json.RawMessage(`{"action":"git_push_force","branch":"main"}`),
	})
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if requirement == nil || requirement.Kind != "dangerous_action" || requirement.Action != "git_push_force" {
		t.Fatalf("unexpected requirement: %+v", requirement)
	}
}

func TestPolicyEvaluateBudgetThreshold(t *testing.T) {
	policy := Policy{
		Enforce:              true,
		DangerousActions:     map[string]struct{}{},
		TaskCreateBudgetOver: 1000,
	}

	requirement, err := policy.Evaluate(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
		Input:       json.RawMessage(`{"budget":1500}`),
	})
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if requirement == nil || requirement.Kind != "task_create" || requirement.Action != "task_create" {
		t.Fatalf("unexpected requirement: %+v", requirement)
	}
}

func TestPolicyEvaluateDisabledReturnsNil(t *testing.T) {
	policy := Policy{
		Enforce: true,
		DangerousActions: map[string]struct{}{
			"git_push_force": {},
		},
		TaskCreateBudgetOver: 1000,
	}

	requirement, err := Policy{}.Evaluate(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
		Input:       json.RawMessage(`{"action":"git_push_force","budget":1500}`),
	})
	if err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
	if requirement != nil {
		t.Fatalf("expected nil requirement when policy disabled, got %+v", requirement)
	}

	requirement, err = policy.Evaluate(proto.TaskPushPayload{
		TaskID:      "task_1",
		ExecutionID: "exec_1",
		Input:       json.RawMessage(`{"action":"safe_echo","budget":10}`),
	})
	if err != nil {
		t.Fatalf("Evaluate() safe error = %v", err)
	}
	if requirement != nil {
		t.Fatalf("expected nil requirement for safe input, got %+v", requirement)
	}
}

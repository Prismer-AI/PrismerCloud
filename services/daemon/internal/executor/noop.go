package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/approval"
	"github.com/Prismer-AI/PrismerCloud/services/daemon/internal/runner"
	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type NoopExecutor struct {
	supported map[string]proto.RuntimeCapability
	policy    approval.Policy
}

type noopInput struct {
	Approval *noopApprovalInput `json:"approval,omitempty"`
}

type noopApprovalInput struct {
	Kind        string          `json:"kind"`
	Action      string          `json:"action"`
	Payload     json.RawMessage `json:"payload"`
	ApproverDID string          `json:"approver_did,omitempty"`
}

func NewNoop(capabilities []proto.RuntimeCapability, policy approval.Policy) *NoopExecutor {
	supported := make(map[string]proto.RuntimeCapability, len(capabilities))
	for _, capability := range capabilities {
		if capability.Key == "" {
			continue
		}
		supported[capability.Key] = capability
	}
	return &NoopExecutor{supported: supported, policy: policy}
}

func (e *NoopExecutor) Execute(ctx context.Context, task proto.TaskPushPayload, reporter runner.Reporter) (runner.ExecutionResult, error) {
	if task.Capability == "" {
		return runner.ExecutionResult{}, &runner.RejectError{
			Reason:    "missing task capability",
			Retryable: false,
		}
	}
	if len(e.supported) > 0 {
		if _, ok := e.supported[task.Capability]; !ok {
			return runner.ExecutionResult{}, &runner.RejectError{
				Reason:    fmt.Sprintf("unsupported capability: %s (supported: %s)", task.Capability, strings.Join(e.supportedKeys(), ", ")),
				Retryable: false,
			}
		}
	}

	parsedInput, err := parseNoopInput(task.Input)
	if err != nil {
		return runner.ExecutionResult{}, err
	}
	requirement, err := e.policy.Evaluate(task)
	if err != nil {
		return runner.ExecutionResult{}, err
	}
	if parsedInput.Approval != nil || requirement != nil {
		approvalRequest := runner.ApprovalRequest{
			RequestSignature: "noop-executor",
		}
		if parsedInput.Approval != nil {
			approvalRequest.Kind = parsedInput.Approval.Kind
			approvalRequest.Action = parsedInput.Approval.Action
			approvalRequest.Payload = defaultApprovalPayload(parsedInput.Approval.Payload)
			approvalRequest.ApproverDID = parsedInput.Approval.ApproverDID
		} else {
			approvalRequest.Kind = requirement.Kind
			approvalRequest.Action = requirement.Action
			approvalRequest.Payload = defaultApprovalPayload(requirement.Payload)
		}
		decision, err := reporter.RequestApproval(ctx, runner.ApprovalRequest{
			Kind:             approvalRequest.Kind,
			Action:           approvalRequest.Action,
			Payload:          approvalRequest.Payload,
			ApproverDID:      approvalRequest.ApproverDID,
			RequestSignature: approvalRequest.RequestSignature,
		})
		if err != nil {
			return runner.ExecutionResult{}, err
		}
		if decision.Decision != "approved" {
			return runner.ExecutionResult{}, &runner.RejectError{
				Reason:    "approval rejected",
				Retryable: false,
			}
		}
		if err := reporter.Log(ctx, "stdout", "approval granted\n"); err != nil {
			return runner.ExecutionResult{}, err
		}
	}

	if err := reporter.Log(ctx, "stdout", fmt.Sprintf("starting task %s: %s\n", task.TaskID, task.Title)); err != nil {
		return runner.ExecutionResult{}, err
	}
	if len(task.Input) > 0 && string(task.Input) != "{}" {
		prettyInput, err := formatInput(task.Input)
		if err != nil {
			return runner.ExecutionResult{}, err
		}
		if err := reporter.Log(ctx, "stdout", "input: "+prettyInput+"\n"); err != nil {
			return runner.ExecutionResult{}, err
		}
	}
	if err := reporter.Log(ctx, "stdout", "noop executor completed\n"); err != nil {
		return runner.ExecutionResult{}, err
	}

	return runner.ExecutionResult{
		ExitCode:   0,
		Summary:    "noop executor completed",
		DurationMs: 1,
	}, nil
}

func (e *NoopExecutor) supportedKeys() []string {
	keys := make([]string, 0, len(e.supported))
	for key := range e.supported {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func formatInput(raw json.RawMessage) (string, error) {
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return "", err
	}
	pretty, err := json.Marshal(generic)
	if err != nil {
		return "", err
	}
	return string(pretty), nil
}

func parseNoopInput(raw json.RawMessage) (noopInput, error) {
	if len(raw) == 0 || string(raw) == "{}" {
		return noopInput{}, nil
	}
	var parsed noopInput
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return noopInput{}, err
	}
	return parsed, nil
}

func defaultApprovalPayload(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}

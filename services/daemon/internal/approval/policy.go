package approval

import (
	"encoding/json"
	"strings"

	"github.com/Prismer-AI/PrismerCloud/services/shared/proto"
)

type Policy struct {
	Enforce              bool
	DangerousActions     map[string]struct{}
	TaskCreateBudgetOver float64
}

type Requirement struct {
	Kind    string
	Action  string
	Payload json.RawMessage
}

type taskInput struct {
	Action string   `json:"action"`
	Budget *float64 `json:"budget"`
}

func (p Policy) Evaluate(task proto.TaskPushPayload) (*Requirement, error) {
	if !p.Enforce || len(task.Input) == 0 || string(task.Input) == "{}" {
		return nil, nil
	}

	var input taskInput
	if err := json.Unmarshal(task.Input, &input); err != nil {
		return nil, err
	}

	actionKey := normalizeAction(input.Action)
	if actionKey != "" {
		if _, ok := p.DangerousActions[actionKey]; ok {
			return &Requirement{
				Kind:    "dangerous_action",
				Action:  actionKey,
				Payload: task.Input,
			}, nil
		}
	}

	if input.Budget != nil && p.TaskCreateBudgetOver > 0 && *input.Budget >= p.TaskCreateBudgetOver {
		return &Requirement{
			Kind:    "task_create",
			Action:  "task_create",
			Payload: task.Input,
		}, nil
	}

	return nil, nil
}

func normalizeAction(value string) string {
	return strings.TrimSpace(strings.ToLower(value))
}

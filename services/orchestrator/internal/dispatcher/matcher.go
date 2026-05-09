package dispatcher

import (
	"encoding/json"
	"sort"
	"time"

	shareddb "github.com/Prismer-AI/PrismerCloud/services/shared/db"
)

type Match struct {
	Runtime shareddb.Runtime
	Score   int
}

type capabilityDescriptor struct {
	Key string `json:"key"`
}

func MatchRuntime(task shareddb.Task, runtimes []shareddb.Runtime, now time.Time) (Match, bool) {
	var matches []Match
	for _, runtime := range runtimes {
		if !runtimeSupportsCapability(runtime, task.Capability) {
			continue
		}
		score := 0
		if task.CreatorDid != "" && task.CreatorDid == runtime.OwnerDid {
			score += 100
		}
		if !runtime.LastHeartbeatAt.IsZero() && runtime.LastHeartbeatAt.After(now.Add(-30*time.Second)) {
			score += 10
		}
		score -= int(runtime.Load * 100)
		matches = append(matches, Match{
			Runtime: runtime,
			Score:   score,
		})
	}

	if len(matches) == 0 {
		return Match{}, false
	}

	sort.Slice(matches, func(i, j int) bool {
		if matches[i].Score == matches[j].Score {
			if matches[i].Runtime.Load == matches[j].Runtime.Load {
				return matches[i].Runtime.LastHeartbeatAt.After(matches[j].Runtime.LastHeartbeatAt)
			}
			return matches[i].Runtime.Load < matches[j].Runtime.Load
		}
		return matches[i].Score > matches[j].Score
	})
	return matches[0], true
}

func runtimeSupportsCapability(runtime shareddb.Runtime, capability string) bool {
	if capability == "" {
		return true
	}
	var capabilities []capabilityDescriptor
	if err := json.Unmarshal([]byte(runtime.Capabilities), &capabilities); err != nil {
		return false
	}
	for _, candidate := range capabilities {
		if candidate.Key == capability {
			return true
		}
	}
	return false
}

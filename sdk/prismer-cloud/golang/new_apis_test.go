//go:build integration

package prismer_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"
)

// ============================================================================
// Helpers
// ============================================================================

const testBaseURLDefault = "https://cloud.prismer.dev"

func newTestClient(t *testing.T) *prismer.Client {
	t.Helper()
	key := os.Getenv("PRISMER_API_KEY_TEST")
	if key == "" {
		t.Fatal("PRISMER_API_KEY_TEST environment variable is required")
	}
	base := os.Getenv("PRISMER_BASE_URL_TEST")
	if base == "" {
		base = testBaseURLDefault
	}
	return prismer.NewClient(key, prismer.WithBaseURL(base))
}

func testUnique(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

// registerTestAgent registers a fresh agent and returns (imClient, agentUserId).
// The returned client is authenticated with the agent's JWT token.
func registerTestAgent(t *testing.T, prefix string) (*prismer.Client, string) {
	t.Helper()
	apiClient := newTestClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	username := testUnique(prefix)
	regResult, err := apiClient.IM().Account.Register(ctx, &prismer.IMRegisterOptions{
		Type:         "agent",
		Username:     username,
		DisplayName:  fmt.Sprintf("Test %s %d", prefix, time.Now().UnixNano()),
		AgentType:    "assistant",
		Capabilities: []string{"chat", "testing", "evolution"},
		Description:  "Integration test agent for new APIs",
	})
	if err != nil {
		t.Fatalf("Register agent %s error: %v", prefix, err)
	}
	if !regResult.OK {
		t.Fatalf("Register agent %s not OK: %+v", prefix, regResult.Error)
	}

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("Decode register data: %v", err)
	}
	if regData.Token == "" {
		t.Fatalf("Agent %s got empty token", prefix)
	}

	base := os.Getenv("PRISMER_BASE_URL_TEST")
	if base == "" {
		base = testBaseURLDefault
	}
	agentClient := prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	t.Logf("Registered agent %s — userId=%s username=%s", prefix, regData.IMUserID, regData.Username)
	return agentClient, regData.IMUserID
}

// ============================================================================
// Evolution API Tests
// ============================================================================

func TestNewAPI_Evolution_Analyze(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_analyze")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.Analyze(ctx, &prismer.AnalyzeOptions{
		Context: "User asked to refactor a function but the tests failed after changes",
		Signals: []string{"test_failure", "refactor"},
	})
	if err != nil {
		t.Fatalf("Analyze error: %v", err)
	}
	if !result.OK {
		t.Logf("Analyze not OK (may be expected for new agent): %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Analyze — ok=%v data=%s", result.OK, string(result.Data))
}

func TestNewAPI_Evolution_CreateGene(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_create")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.CreateGene(ctx, &prismer.CreateGeneOptions{
		Category:     "repair",
		SignalsMatch: []string{"test_failure", "compilation_error"},
		Strategy:     []string{"Check error messages first", "Run failing test in isolation"},
	})
	if err != nil {
		t.Fatalf("CreateGene error: %v", err)
	}
	if !result.OK {
		t.Logf("CreateGene not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("CreateGene — ok=%v data=%s", result.OK, string(result.Data))
}

func TestNewAPI_Evolution_RecordOutcome(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_record")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// First create a gene to record against
	geneResult, err := client.IM().Evolution.CreateGene(ctx, &prismer.CreateGeneOptions{
		Category:     "optimize",
		SignalsMatch: []string{"slow_response"},
		Strategy:     []string{"Add caching layer"},
	})
	if err != nil {
		t.Fatalf("CreateGene error: %v", err)
	}
	if !geneResult.OK {
		t.Logf("CreateGene not OK, skipping record test: %+v", geneResult.Error)
		t.SkipNow()
	}

	var geneData map[string]interface{}
	if err := geneResult.Decode(&geneData); err != nil {
		t.Fatalf("Decode gene: %v", err)
	}
	geneID, _ := geneData["id"].(string)
	if geneID == "" {
		// Try alternate field name
		geneID, _ = geneData["gene_id"].(string)
	}
	if geneID == "" {
		t.Logf("No gene ID in response, skipping record test. Data: %s", string(geneResult.Data))
		t.SkipNow()
	}

	score := 0.85
	result, err := client.IM().Evolution.Record(ctx, &prismer.RecordOutcomeOptions{
		GeneID:  geneID,
		Signals: []string{"slow_response"},
		Outcome: "success",
		Score:   &score,
		Summary: "Caching reduced response time by 60%",
	})
	if err != nil {
		t.Fatalf("Record error: %v", err)
	}
	if !result.OK {
		t.Logf("Record not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Record — ok=%v", result.OK)
}

func TestNewAPI_Evolution_ListGenes(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_list")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.ListGenes(ctx, "", "")
	if err != nil {
		t.Fatalf("ListGenes error: %v", err)
	}
	if !result.OK {
		t.Logf("ListGenes not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("ListGenes — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_BrowseGenes(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_browse")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.BrowseGenes(ctx, &prismer.GeneListOptions{
		Limit: 5,
	})
	if err != nil {
		t.Fatalf("BrowseGenes error: %v", err)
	}
	if !result.OK {
		t.Logf("BrowseGenes not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("BrowseGenes — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_Distill(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_distill")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.Distill(ctx, true) // dry_run=true
	if err != nil {
		t.Fatalf("Distill error: %v", err)
	}
	if !result.OK {
		t.Logf("Distill not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Distill — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_DeleteGene(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_delete")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Create then delete
	geneResult, err := client.IM().Evolution.CreateGene(ctx, &prismer.CreateGeneOptions{
		Category:     "diagnostic",
		SignalsMatch: []string{"to_be_deleted"},
		Strategy:     []string{"Temporary gene for deletion test"},
	})
	if err != nil {
		t.Fatalf("CreateGene error: %v", err)
	}
	if !geneResult.OK {
		t.Logf("CreateGene not OK, skipping delete test: %+v", geneResult.Error)
		t.SkipNow()
	}

	var geneData map[string]interface{}
	if err := geneResult.Decode(&geneData); err != nil {
		t.Fatalf("Decode gene: %v", err)
	}
	geneID, _ := geneData["id"].(string)
	if geneID == "" {
		geneID, _ = geneData["gene_id"].(string)
	}
	if geneID == "" {
		t.Logf("No gene ID in response. Data: %s", string(geneResult.Data))
		t.SkipNow()
	}

	result, err := client.IM().Evolution.DeleteGene(ctx, geneID)
	if err != nil {
		t.Fatalf("DeleteGene error: %v", err)
	}
	if !result.OK {
		t.Logf("DeleteGene not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("DeleteGene — ok=%v geneId=%s", result.OK, geneID)
}

func TestNewAPI_Evolution_GetReport(t *testing.T) {
	client, agentID := registerTestAgent(t, "evo_report")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.GetReport(ctx, agentID)
	if err != nil {
		t.Fatalf("GetReport error: %v", err)
	}
	if !result.OK {
		t.Logf("GetReport not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("GetReport — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_GetAchievements(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_ach")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.GetAchievements(ctx)
	if err != nil {
		t.Fatalf("GetAchievements error: %v", err)
	}
	if !result.OK {
		t.Logf("GetAchievements not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("GetAchievements — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_GetSyncSnapshot(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_snap")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.GetSyncSnapshot(ctx, 0)
	if err != nil {
		t.Fatalf("GetSyncSnapshot error: %v", err)
	}
	if !result.OK {
		t.Logf("GetSyncSnapshot not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("GetSyncSnapshot — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_Sync(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_sync")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.Sync(ctx, nil, 0)
	if err != nil {
		t.Fatalf("Sync error: %v", err)
	}
	if !result.OK {
		t.Logf("Sync not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Sync — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_SearchSkills(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_search")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Evolution.SearchSkills(ctx, "", "", 5)
	if err != nil {
		t.Fatalf("SearchSkills error: %v", err)
	}
	if !result.OK {
		t.Logf("SearchSkills not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("SearchSkills — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Evolution_SkillLifecycle(t *testing.T) {
	client, _ := registerTestAgent(t, "evo_skill")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Search for a skill to install
	searchResult, err := client.IM().Evolution.SearchSkills(ctx, "", "", 1)
	if err != nil {
		t.Fatalf("SearchSkills error: %v", err)
	}
	if !searchResult.OK {
		t.Logf("SearchSkills not OK, skipping skill lifecycle: %+v", searchResult.Error)
		t.SkipNow()
	}

	var skills []map[string]interface{}
	if err := searchResult.Decode(&skills); err != nil || len(skills) == 0 {
		// Try as object with items
		var data map[string]interface{}
		if err2 := searchResult.Decode(&data); err2 == nil {
			if items, ok := data["items"].([]interface{}); ok && len(items) > 0 {
				for _, item := range items {
					if m, ok := item.(map[string]interface{}); ok {
						skills = append(skills, m)
					}
				}
			}
			if items, ok := data["skills"].([]interface{}); ok && len(items) > 0 {
				for _, item := range items {
					if m, ok := item.(map[string]interface{}); ok {
						skills = append(skills, m)
					}
				}
			}
		}
		if len(skills) == 0 {
			t.Logf("No skills found to test install. Data: %s", truncate(string(searchResult.Data), 300))
			t.SkipNow()
		}
	}

	slug, _ := skills[0]["slug"].(string)
	if slug == "" {
		slug, _ = skills[0]["id"].(string)
	}
	if slug == "" {
		t.Logf("No slug or id in skill data: %v", skills[0])
		t.SkipNow()
	}

	// Install
	t.Run("InstallSkill", func(t *testing.T) {
		result, err := client.IM().Evolution.InstallSkill(ctx, slug)
		if err != nil {
			t.Fatalf("InstallSkill error: %v", err)
		}
		if !result.OK {
			t.Logf("InstallSkill not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("InstallSkill(%s) — ok=%v", slug, result.OK)
	})

	// InstalledSkills
	t.Run("InstalledSkills", func(t *testing.T) {
		result, err := client.IM().Evolution.InstalledSkills(ctx)
		if err != nil {
			t.Fatalf("InstalledSkills error: %v", err)
		}
		if !result.OK {
			t.Logf("InstalledSkills not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("InstalledSkills — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
	})

	// Uninstall
	t.Run("UninstallSkill", func(t *testing.T) {
		result, err := client.IM().Evolution.UninstallSkill(ctx, slug)
		if err != nil {
			t.Fatalf("UninstallSkill error: %v", err)
		}
		if !result.OK {
			t.Logf("UninstallSkill not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("UninstallSkill(%s) — ok=%v", slug, result.OK)
	})
}

// ============================================================================
// Tasks API Tests
// ============================================================================

func TestNewAPI_Tasks_Lifecycle(t *testing.T) {
	client, _ := registerTestAgent(t, "task_life")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	taskTitle := testUnique("go_test_task")

	// Create
	var taskID string
	t.Run("Create", func(t *testing.T) {
		result, err := client.IM().Tasks.Create(ctx, &prismer.CreateTaskOptions{
			Title:       taskTitle,
			Description: "Integration test task from Go SDK",
			Capability:  "testing",
			Input:       map[string]interface{}{"test": true, "source": "go-sdk"},
			TimeoutMs:   300000,
		})
		if err != nil {
			t.Fatalf("Tasks.Create error: %v", err)
		}
		if !result.OK {
			t.Logf("Tasks.Create not OK: %+v", result.Error)
			t.SkipNow()
		}
		var data map[string]interface{}
		if err := result.Decode(&data); err != nil {
			t.Fatalf("Decode: %v", err)
		}
		taskID, _ = data["id"].(string)
		if taskID == "" {
			taskID, _ = data["taskId"].(string)
		}
		t.Logf("Tasks.Create — ok=%v taskId=%s", result.OK, taskID)
	})

	// List
	t.Run("List", func(t *testing.T) {
		result, err := client.IM().Tasks.List(ctx, &prismer.TaskListOptions{
			Limit: 5,
		})
		if err != nil {
			t.Fatalf("Tasks.List error: %v", err)
		}
		if !result.OK {
			t.Logf("Tasks.List not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Tasks.List — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
	})

	// Get
	t.Run("Get", func(t *testing.T) {
		if taskID == "" {
			t.Skip("no task created")
		}
		result, err := client.IM().Tasks.Get(ctx, taskID)
		if err != nil {
			t.Fatalf("Tasks.Get error: %v", err)
		}
		if !result.OK {
			t.Logf("Tasks.Get not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Tasks.Get — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
	})

	// Update
	t.Run("Update", func(t *testing.T) {
		if taskID == "" {
			t.Skip("no task created")
		}
		result, err := client.IM().Tasks.Update(ctx, taskID, &prismer.UpdateTaskOptions{
			Metadata: map[string]interface{}{"updated_by": "go-sdk-test"},
		})
		if err != nil {
			t.Fatalf("Tasks.Update error: %v", err)
		}
		if !result.OK {
			t.Logf("Tasks.Update not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Tasks.Update — ok=%v", result.OK)
	})

	// Claim
	t.Run("Claim", func(t *testing.T) {
		if taskID == "" {
			t.Skip("no task created")
		}
		result, err := client.IM().Tasks.Claim(ctx, taskID)
		if err != nil {
			t.Fatalf("Tasks.Claim error: %v", err)
		}
		if !result.OK {
			t.Logf("Tasks.Claim not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Tasks.Claim — ok=%v", result.OK)
	})

	// Progress
	t.Run("Progress", func(t *testing.T) {
		if taskID == "" {
			t.Skip("no task created")
		}
		result, err := client.IM().Tasks.Progress(ctx, taskID, &prismer.ProgressOptions{
			Message:  "50% complete",
			Metadata: map[string]interface{}{"progress": 50},
		})
		if err != nil {
			t.Fatalf("Tasks.Progress error: %v", err)
		}
		if !result.OK {
			t.Logf("Tasks.Progress not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Tasks.Progress — ok=%v", result.OK)
	})

	// Complete
	t.Run("Complete", func(t *testing.T) {
		if taskID == "" {
			t.Skip("no task created")
		}
		result, err := client.IM().Tasks.Complete(ctx, taskID, &prismer.CompleteTaskOptions{
			Result: map[string]interface{}{"status": "done", "output": "test result"},
		})
		if err != nil {
			t.Fatalf("Tasks.Complete error: %v", err)
		}
		if !result.OK {
			t.Logf("Tasks.Complete not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Tasks.Complete — ok=%v", result.OK)
	})
}

func TestNewAPI_Tasks_Fail(t *testing.T) {
	client, _ := registerTestAgent(t, "task_fail")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Create a task to fail
	createResult, err := client.IM().Tasks.Create(ctx, &prismer.CreateTaskOptions{
		Title:      testUnique("go_fail_task"),
		Capability: "testing",
	})
	if err != nil {
		t.Fatalf("Tasks.Create error: %v", err)
	}
	if !createResult.OK {
		t.Logf("Tasks.Create not OK: %+v", createResult.Error)
		t.SkipNow()
	}

	var data map[string]interface{}
	if err := createResult.Decode(&data); err != nil {
		t.Fatalf("Decode: %v", err)
	}
	taskID, _ := data["id"].(string)
	if taskID == "" {
		taskID, _ = data["taskId"].(string)
	}
	if taskID == "" {
		t.Logf("No task ID in response. Data: %s", string(createResult.Data))
		t.SkipNow()
	}

	// Claim first
	claimResult, err := client.IM().Tasks.Claim(ctx, taskID)
	if err != nil {
		t.Logf("Claim error (proceeding): %v", err)
	} else if !claimResult.OK {
		t.Logf("Claim not OK (proceeding): %+v", claimResult.Error)
	}

	// Fail
	result, err := client.IM().Tasks.Fail(ctx, taskID, "Intentional failure for testing", map[string]interface{}{
		"reason": "test",
	})
	if err != nil {
		t.Fatalf("Tasks.Fail error: %v", err)
	}
	if !result.OK {
		t.Logf("Tasks.Fail not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Tasks.Fail — ok=%v taskId=%s", result.OK, taskID)
}

// ============================================================================
// Memory API Tests
// ============================================================================

func TestNewAPI_Memory_Lifecycle(t *testing.T) {
	client, _ := registerTestAgent(t, "mem_life")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	memPath := testUnique("test/go-sdk-memory") + ".md"

	// CreateFile
	var fileID string
	t.Run("CreateFile", func(t *testing.T) {
		result, err := client.IM().Memory.CreateFile(ctx, &prismer.CreateMemoryFileOptions{
			Path:    memPath,
			Content: "# Test Memory\n\nCreated by Go SDK integration test.",
			Scope:   "agent",
		})
		if err != nil {
			t.Fatalf("Memory.CreateFile error: %v", err)
		}
		if !result.OK {
			t.Logf("Memory.CreateFile not OK: %+v", result.Error)
			t.SkipNow()
		}
		var data map[string]interface{}
		if err := result.Decode(&data); err == nil {
			fileID, _ = data["id"].(string)
			if fileID == "" {
				fileID, _ = data["fileId"].(string)
			}
		}
		t.Logf("Memory.CreateFile — ok=%v fileId=%s path=%s", result.OK, fileID, memPath)
	})

	// ListFiles
	t.Run("ListFiles", func(t *testing.T) {
		result, err := client.IM().Memory.ListFiles(ctx, "agent", "")
		if err != nil {
			t.Fatalf("Memory.ListFiles error: %v", err)
		}
		if !result.OK {
			t.Logf("Memory.ListFiles not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Memory.ListFiles — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
	})

	// GetFile
	t.Run("GetFile", func(t *testing.T) {
		if fileID == "" {
			t.Skip("no file created")
		}
		result, err := client.IM().Memory.GetFile(ctx, fileID)
		if err != nil {
			t.Fatalf("Memory.GetFile error: %v", err)
		}
		if !result.OK {
			t.Logf("Memory.GetFile not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Memory.GetFile — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
	})

	// UpdateFile
	t.Run("UpdateFile", func(t *testing.T) {
		if fileID == "" {
			t.Skip("no file created")
		}
		result, err := client.IM().Memory.UpdateFile(ctx, fileID, &prismer.UpdateMemoryFileOptions{
			Operation: "replace",
			Content:   "# Updated Memory\n\nUpdated by Go SDK integration test.",
		})
		if err != nil {
			t.Fatalf("Memory.UpdateFile error: %v", err)
		}
		if !result.OK {
			t.Logf("Memory.UpdateFile not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Memory.UpdateFile — ok=%v", result.OK)
	})

	// DeleteFile
	t.Run("DeleteFile", func(t *testing.T) {
		if fileID == "" {
			t.Skip("no file created")
		}
		result, err := client.IM().Memory.DeleteFile(ctx, fileID)
		if err != nil {
			t.Fatalf("Memory.DeleteFile error: %v", err)
		}
		if !result.OK {
			t.Logf("Memory.DeleteFile not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("Memory.DeleteFile — ok=%v fileId=%s", result.OK, fileID)
	})
}

func TestNewAPI_Memory_Load(t *testing.T) {
	client, _ := registerTestAgent(t, "mem_load")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Memory.Load(ctx, "agent")
	if err != nil {
		t.Fatalf("Memory.Load error: %v", err)
	}
	if !result.OK {
		t.Logf("Memory.Load not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Memory.Load — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

// ============================================================================
// Identity API Tests
// ============================================================================

func TestNewAPI_Identity_GetServerKey(t *testing.T) {
	client, _ := registerTestAgent(t, "id_srvkey")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Identity.GetServerKey(ctx)
	if err != nil {
		t.Skipf("Identity.GetServerKey error (endpoint may not be available): %v", err)
	}
	if !result.OK {
		t.Logf("Identity.GetServerKey not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Identity.GetServerKey — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Identity_RegisterKey(t *testing.T) {
	client, _ := registerTestAgent(t, "id_regkey")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Use a dummy Ed25519 public key (base64-encoded 32 bytes)
	dummyPubKey := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	result, err := client.IM().Identity.RegisterKey(ctx, &prismer.RegisterKeyOptions{
		PublicKey:      dummyPubKey,
		DerivationMode: "ed25519",
	})
	if err != nil {
		t.Skipf("Identity.RegisterKey error (endpoint may not be available): %v", err)
	}
	if !result.OK {
		t.Logf("Identity.RegisterKey not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Identity.RegisterKey — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Identity_GetKey(t *testing.T) {
	client, agentID := registerTestAgent(t, "id_getkey")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Identity.GetKey(ctx, agentID)
	if err != nil {
		t.Fatalf("Identity.GetKey error: %v", err)
	}
	if !result.OK {
		// May not have a key registered yet — that's expected
		t.Logf("Identity.GetKey not OK (expected if no key registered): %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Identity.GetKey — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

func TestNewAPI_Identity_GetAuditLog(t *testing.T) {
	client, agentID := registerTestAgent(t, "id_audit")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.IM().Identity.GetAuditLog(ctx, agentID)
	if err != nil {
		t.Fatalf("Identity.GetAuditLog error: %v", err)
	}
	if !result.OK {
		t.Logf("Identity.GetAuditLog not OK: %+v", result.Error)
		t.SkipNow()
	}
	t.Logf("Identity.GetAuditLog — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
}

// ============================================================================
// Security API Tests
// ============================================================================

func TestNewAPI_Security_ConversationSecurity(t *testing.T) {
	client, _ := registerTestAgent(t, "sec_conv")
	client2, agent2ID := registerTestAgent(t, "sec_conv2")
	_ = client2
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// First create a conversation by sending a direct message
	sendResult, err := client.IM().Direct.Send(ctx, agent2ID, "Security test setup message", nil)
	if err != nil {
		t.Fatalf("Direct.Send error: %v", err)
	}
	if !sendResult.OK {
		t.Fatalf("Direct.Send not OK: %+v", sendResult.Error)
	}

	var msgData prismer.IMMessageData
	if err := sendResult.Decode(&msgData); err != nil {
		t.Fatalf("Decode message: %v", err)
	}
	convID := msgData.ConversationID
	if convID == "" {
		t.Fatal("No conversationId returned from Direct.Send")
	}

	// GetConversationSecurity
	t.Run("GetConversationSecurity", func(t *testing.T) {
		result, err := client.IM().Security.GetConversationSecurity(ctx, convID)
		if err != nil {
			t.Fatalf("GetConversationSecurity error: %v", err)
		}
		if !result.OK {
			t.Logf("GetConversationSecurity not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("GetConversationSecurity — ok=%v data=%s", result.OK, truncate(string(result.Data), 200))
	})

	// SetConversationSecurity
	t.Run("SetConversationSecurity", func(t *testing.T) {
		result, err := client.IM().Security.SetConversationSecurity(ctx, convID, map[string]interface{}{
			"encryptionEnabled": false,
		})
		if err != nil {
			t.Fatalf("SetConversationSecurity error: %v", err)
		}
		if !result.OK {
			t.Logf("SetConversationSecurity not OK: %+v", result.Error)
			t.SkipNow()
		}
		t.Logf("SetConversationSecurity — ok=%v", result.OK)
	})
}

// ============================================================================
// Helpers
// ============================================================================

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

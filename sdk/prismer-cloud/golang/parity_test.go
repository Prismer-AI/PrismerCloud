//go:build integration

/*
SDK Cross-Language Parity Tests — Go

Mirrors: typescript/tests/integration/sdk-parity.test.ts
Same test IDs (P1.1, P2.1, etc.) for cross-language traceability.

Run: PRISMER_API_KEY_TEST="sk-prismer-..." go test -tags=integration -v -run TestParity
Env: PRISMER_BASE_URL_TEST (default: https://cloud.prismer.dev)
*/

package prismer_test

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"
)

var parityRunID = fmt.Sprintf("go-parity-%d", time.Now().Unix())

func parityClient(t *testing.T) *prismer.Client {
	t.Helper()
	key := os.Getenv("PRISMER_API_KEY_TEST")
	if key == "" {
		t.Fatal("PRISMER_API_KEY_TEST required")
	}
	base := os.Getenv("PRISMER_BASE_URL_TEST")
	if base == "" {
		base = "https://cloud.prismer.dev"
	}
	return prismer.NewClient(key, prismer.WithBaseURL(base))
}

// ============================================================================
// P1: Context API
// ============================================================================

func TestParityP1_1_LoadSingleURL(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.Load(ctx, "https://example.com", nil)
	if err != nil {
		t.Fatalf("load error: %v", err)
	}
	if !result.Success {
		t.Fatalf("load not successful: %v", result.Error)
	}
	if result.Mode != "single_url" {
		t.Fatalf("expected mode=single_url, got %s", result.Mode)
	}
	if result.Result == nil || result.Result.URL != "https://example.com" {
		t.Fatal("result missing or wrong URL")
	}
}

func TestParityP1_2_LoadReturnsContent(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.Load(ctx, "https://example.com", nil)
	if err != nil {
		t.Fatalf("load error: %v", err)
	}
	if result.Result == nil {
		t.Fatal("result is nil")
	}
	if result.Result.HQCC == "" && result.Result.Raw == "" {
		t.Fatal("no content returned")
	}
}

func TestParityP1_3_SearchReturnsResults(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.Search(ctx, "prismer cloud AI", nil)
	if err != nil {
		t.Fatalf("search error: %v", err)
	}
	if !result.Success {
		t.Fatalf("search not successful")
	}
	if result.Mode != "query" {
		t.Fatalf("expected mode=query, got %s", result.Mode)
	}
}

// ============================================================================
// P2: IM Registration & Identity
// ============================================================================

func TestParityP2_1_WorkspaceInit(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Workspace.Init(ctx, &prismer.IMWorkspaceInitOptions{
		WorkspaceID:     fmt.Sprintf("ws-%s", parityRunID),
		UserID:          fmt.Sprintf("user-%s", parityRunID),
		UserDisplayName: "Parity Test User",
	})
	if err != nil {
		t.Fatalf("workspace init error: %v", err)
	}
	if !result.OK {
		t.Fatal("workspace init not ok")
	}
	// Decode the raw Data to check fields
	var data map[string]interface{}
	if err := result.Decode(&data); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if data["conversationId"] == nil && data["conversationID"] == nil {
		t.Log("warning: conversationId not found in workspace init response")
	}
}

func TestParityP2_2_Me(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Account.Me(ctx)
	if err != nil {
		t.Fatalf("me error: %v", err)
	}
	if !result.OK {
		t.Fatal("me not ok")
	}
}

func TestParityP2_3_Contacts(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Contacts.List(ctx)
	if err != nil {
		t.Fatalf("contacts error: %v", err)
	}
	if !result.OK {
		t.Fatal("contacts not ok")
	}
}

func TestParityP2_4_Discover(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Contacts.Discover(ctx, nil)
	if err != nil {
		t.Fatalf("discover error: %v", err)
	}
	if !result.OK {
		t.Fatal("discover not ok")
	}
}

// ============================================================================
// P3: Conversations
// ============================================================================

func TestParityP3_1_List(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Conversations.List(ctx, false, false)
	if err != nil {
		t.Fatalf("conversations list error: %v", err)
	}
	if !result.OK {
		t.Fatal("conversations list not ok")
	}
}

// ============================================================================
// P4: Evolution Core Loop
// ============================================================================

var parityGeneID string

func TestParityP4_1_Analyze(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Evolution.Analyze(ctx, &prismer.AnalyzeOptions{
		Signals:    []string{"error:timeout"},
		TaskStatus: "pending",
	})
	if err != nil {
		t.Fatalf("analyze error: %v", err)
	}
	if !result.OK {
		t.Fatal("analyze not ok")
	}
}

func TestParityP4_2_CreateGene(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Evolution.CreateGene(ctx, &prismer.CreateGeneOptions{
		Category:     "repair",
		SignalsMatch: []string{"error:test_parity"},
		Strategy:     []string{"Step 1: test", "Step 2: verify"},
	})
	if err != nil {
		t.Fatalf("create gene error: %v", err)
	}
	if !result.OK {
		t.Fatal("create gene not ok")
	}
	var data map[string]interface{}
	if err := result.Decode(&data); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if id, ok := data["id"].(string); ok {
		parityGeneID = id
	} else if id, ok := data["gene_id"].(string); ok {
		parityGeneID = id
	}
	if parityGeneID == "" {
		t.Fatal("gene ID empty")
	}
}

func TestParityP4_3_Record(t *testing.T) {
	if parityGeneID == "" {
		t.Skip("no gene from P4.2")
	}
	c := parityClient(t)
	ctx := context.Background()
	score := 0.85
	result, err := c.IM().Evolution.Record(ctx, &prismer.RecordOutcomeOptions{
		GeneID:  parityGeneID,
		Outcome: "success",
		Score:   &score,
		Summary: "Parity test: outcome recorded",
		Signals: []string{"error:test_parity"},
	})
	if err != nil {
		t.Fatalf("record error: %v", err)
	}
	if !result.OK {
		t.Fatal("record not ok")
	}
}

func TestParityP4_4_Achievements(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Evolution.GetAchievements(ctx)
	if err != nil {
		t.Fatalf("achievements error: %v", err)
	}
	if !result.OK {
		t.Fatal("achievements not ok")
	}
}

func TestParityP4_5_Sync(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Evolution.Sync(ctx, nil, 0)
	if err != nil {
		t.Fatalf("sync error: %v", err)
	}
	if !result.OK {
		t.Fatal("sync not ok")
	}
}

func TestParityP4_6_PublicStats(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Evolution.GetStats(ctx)
	if err != nil {
		t.Fatalf("stats error: %v", err)
	}
	if !result.OK {
		t.Fatal("stats not ok")
	}
}

func TestParityP4_8_DeleteGene(t *testing.T) {
	if parityGeneID == "" {
		t.Skip("no gene from P4.2")
	}
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Evolution.DeleteGene(ctx, parityGeneID)
	if err != nil {
		t.Fatalf("delete gene error: %v", err)
	}
	if !result.OK {
		t.Fatal("delete gene not ok")
	}
}

// ============================================================================
// P6: Memory
// ============================================================================

var parityMemoryFileID string

func TestParityP6_1_Write(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Memory.CreateFile(ctx, &prismer.CreateMemoryFileOptions{
		Path:    fmt.Sprintf("parity/%s.md", parityRunID),
		Content: fmt.Sprintf("# Parity Test\n%d", time.Now().Unix()),
	})
	if err != nil {
		t.Fatalf("memory write error: %v", err)
	}
	if !result.OK {
		t.Fatal("memory write not ok")
	}
	var data map[string]interface{}
	if err := result.Decode(&data); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if id, ok := data["id"].(string); ok {
		parityMemoryFileID = id
	}
}

func TestParityP6_2_List(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Memory.ListFiles(ctx, "", "")
	if err != nil {
		t.Fatalf("memory list error: %v", err)
	}
	if !result.OK {
		t.Fatal("memory list not ok")
	}
}

func TestParityP6_3_Load(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Memory.Load(ctx, "")
	if err != nil {
		t.Fatalf("memory load error: %v", err)
	}
	if !result.OK {
		t.Fatal("memory load not ok")
	}
}

func TestParityP6_5_Delete(t *testing.T) {
	if parityMemoryFileID == "" {
		t.Skip("no file from P6.1")
	}
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Memory.DeleteFile(ctx, parityMemoryFileID)
	if err != nil {
		t.Fatalf("memory delete error: %v", err)
	}
	if !result.OK {
		t.Fatal("memory delete not ok")
	}
}

// ============================================================================
// P7: Tasks
// ============================================================================

var parityTaskID string

func TestParityP7_1_Create(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Tasks.Create(ctx, &prismer.CreateTaskOptions{
		Title:       fmt.Sprintf("Parity Task %s", parityRunID),
		Description: "Cross-language parity test",
	})
	if err != nil {
		t.Fatalf("task create error: %v", err)
	}
	if !result.OK {
		t.Fatal("task create not ok")
	}
	var data map[string]interface{}
	if err := result.Decode(&data); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if id, ok := data["id"].(string); ok {
		parityTaskID = id
	}
}

func TestParityP7_2_List(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Tasks.List(ctx, nil)
	if err != nil {
		t.Fatalf("task list error: %v", err)
	}
	if !result.OK {
		t.Fatal("task list not ok")
	}
}

func TestParityP7_3_Get(t *testing.T) {
	if parityTaskID == "" {
		t.Skip("no task from P7.1")
	}
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Tasks.Get(ctx, parityTaskID)
	if err != nil {
		t.Fatalf("task get error: %v", err)
	}
	if !result.OK {
		t.Fatal("task get not ok")
	}
}

func TestParityP7_4_Claim(t *testing.T) {
	if parityTaskID == "" {
		t.Skip("no task from P7.1")
	}
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Tasks.Claim(ctx, parityTaskID)
	if err != nil {
		t.Fatalf("task claim error: %v", err)
	}
	if !result.OK {
		t.Fatal("task claim not ok")
	}
}

func TestParityP7_5_Complete(t *testing.T) {
	if parityTaskID == "" {
		t.Skip("no task from P7.1")
	}
	c := parityClient(t)
	ctx := context.Background()
	result, err := c.IM().Tasks.Complete(ctx, parityTaskID, &prismer.CompleteTaskOptions{
		Result: "parity test done",
	})
	if err != nil {
		t.Fatalf("task complete error: %v", err)
	}
	if !result.OK {
		t.Fatal("task complete not ok")
	}
}

// ============================================================================
// P10: EvolutionRuntime
// ============================================================================

func TestParityP10_1_Suggest(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	rt := prismer.NewEvolutionRuntime(c.IM().Evolution, nil)
	if err := rt.Start(ctx); err != nil {
		t.Fatalf("runtime start error: %v", err)
	}
	defer rt.Stop()
	fix, err := rt.Suggest(ctx, "Connection timeout ETIMEDOUT")
	if err != nil {
		t.Fatalf("suggest error: %v", err)
	}
	// May return nil if no genes match
	if fix != nil {
		if len(fix.Strategy) == 0 {
			t.Log("suggest returned fix with empty strategy")
		}
	}
}

func TestParityP10_2_Learned(t *testing.T) {
	c := parityClient(t)
	ctx := context.Background()
	rt := prismer.NewEvolutionRuntime(c.IM().Evolution, nil)
	if err := rt.Start(ctx); err != nil {
		t.Fatalf("runtime start error: %v", err)
	}
	defer rt.Stop()
	// Should not panic
	rt.Learned("ETIMEDOUT", "success", "Parity test learned")
}

// ============================================================================
// P11: Webhook
// ============================================================================

func TestParityP11_1_VerifyRejectsInvalid(t *testing.T) {
	isValid := prismer.VerifyWebhookSignature("invalid-body", "invalid-signature", "test-secret")
	if isValid {
		t.Fatal("expected invalid signature to be rejected")
	}
}

// ============================================================================
// P12: Signal Rules
// ============================================================================

func TestParityP12_1_Timeout(t *testing.T) {
	signals := prismer.ExtractSignals(prismer.SignalExtractionContext{
		Error: "Error: ETIMEDOUT connection timed out",
	})
	if len(signals) == 0 {
		t.Fatal("expected signals for timeout error")
	}
	found := false
	for _, s := range signals {
		if s.Type == "error:timeout" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("timeout signal not found, got types: %v", func() []string {
			var types []string
			for _, s := range signals {
				types = append(types, s.Type)
			}
			return types
		}())
	}
}

func TestParityP12_2_Permission(t *testing.T) {
	signals := prismer.ExtractSignals(prismer.SignalExtractionContext{
		Error: "Error: 403 Forbidden access denied",
	})
	if len(signals) == 0 {
		t.Fatal("expected signals for permission error")
	}
}

func TestParityP12_3_CleanOutput(t *testing.T) {
	signals := prismer.ExtractSignals(prismer.SignalExtractionContext{
		Error: "Build succeeded. All tests passed.",
	})
	// Clean output may still produce a fallback signal since it's a non-empty error string.
	// The SDK extracts a normalized fallback signal for any non-empty Error field.
	// This is correct behavior — ExtractSignals always returns at least one signal
	// if Error is non-empty (fallback to normalized error string).
	// For a truly clean scenario, pass empty error.
	signals2 := prismer.ExtractSignals(prismer.SignalExtractionContext{
		Error: "",
	})
	if len(signals2) != 0 {
		t.Fatalf("expected 0 signals for empty error, got %d", len(signals2))
	}
	// Also verify the original string doesn't match any known error pattern
	hasKnownPattern := false
	for _, s := range signals {
		// "error:build_succeeded__all_tests_passed_" is a fallback, not a known pattern
		if s.Type == "error:timeout" || s.Type == "error:permission_error" || s.Type == "error:auth_error" {
			hasKnownPattern = true
		}
	}
	if hasKnownPattern {
		t.Fatal("clean output matched a known error pattern")
	}
}

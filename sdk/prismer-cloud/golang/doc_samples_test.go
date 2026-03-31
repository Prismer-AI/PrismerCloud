//go:build docsample

// Prismer Go SDK — Doc Sample Tests
//
// Each test is annotated with @doc-sample and contains --- sample start/end --- markers.
// Only code between these markers is extracted for docs. The surrounding test
// assertions ensure the sample actually works.
//
// Usage:
//
//	PRISMER_API_KEY_TEST="sk-prismer-live-..." go test -tags docsample -run TestDoc -v -timeout 120s
//
// Extract samples:
//
//	npx tsx scripts/docs/extract-samples.ts
package prismer_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/golang"
)

// testAPIKey returns the API key for tests, failing if unset.
func testAPIKey(t *testing.T) string {
	t.Helper()
	key := os.Getenv("PRISMER_API_KEY_TEST")
	if key == "" {
		t.Fatal("PRISMER_API_KEY_TEST environment variable is required")
	}
	return key
}

// testClient creates a real client for test assertions.
func testClient(t *testing.T) *prismer.Client {
	t.Helper()
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		return prismer.NewClient(testAPIKey(t), prismer.WithBaseURL(base))
	}
	return prismer.NewClient(testAPIKey(t))
}

// requireOK fails the test if err is non-nil or result indicates failure.
func requireOK(t *testing.T, success bool, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !success {
		t.Fatal("expected success to be true")
	}
}

// requireIMOK fails the test if err is non-nil or result.OK is false.
func requireIMOK(t *testing.T, result *prismer.IMResult, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if !result.OK {
		errMsg := "unknown"
		if result.Error != nil {
			errMsg = result.Error.Message
		}
		t.Fatalf("expected OK, got error: %s", errMsg)
	}
}

// ═══════════════════════════════════════════════════════════════════
// Context API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: contextLoad / single_url
func TestDocContextLoadSingleURL(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	result, err := client.Load(ctx, "https://example.com", nil)
	if err != nil {
		log.Fatal(err)
	}

	if result.Result != nil {
		fmt.Println(result.Result.Title)  // page title
		fmt.Println(result.Result.HQCC)   // compressed content
		fmt.Println(result.Result.Cached) // true if from global cache
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	r, err := real.Load(ctx, "https://example.com", nil)
	requireOK(t, r.Success, err)
	if r.Result == nil && len(r.Results) == 0 {
		t.Fatal("expected Result or Results to be populated")
	}
}

// @doc-sample: contextLoad / batch_urls
func TestDocContextLoadBatchURLs(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	result, err := client.Load(ctx, []string{
		"https://example.com",
		"https://httpbin.org/html",
	}, nil)
	if err != nil {
		log.Fatal(err)
	}

	for _, r := range result.Results {
		if r.Cached {
			fmt.Printf("%s: cached\n", r.Title)
		} else {
			fmt.Printf("%s: fresh\n", r.Title)
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	r, err := real.Load(ctx2, []string{"https://example.com", "https://httpbin.org/html"}, nil)
	requireOK(t, r.Success, err)
	if len(r.Results) == 0 {
		t.Fatal("expected non-empty Results for batch load")
	}
}

// @doc-sample: contextLoad / search_query
func TestDocContextLoadSearchQuery(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	result, err := client.Load(ctx, "latest AI research papers", &prismer.LoadOptions{
		InputType: "query",
		Search:    &prismer.SearchConfig{TopK: 3},
	})
	if err != nil {
		log.Fatal(err)
	}

	for _, r := range result.Results {
		fmt.Printf("%s: %s\n", r.Title, r.URL)
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	r, err := real.Load(ctx2, "What is TypeScript?", &prismer.LoadOptions{InputType: "query"})
	requireOK(t, r.Success, err)
}

// @doc-sample: contextSave / basic
func TestDocContextSaveBasic(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	result, err := client.Save(ctx, &prismer.SaveOptions{
		URL:        "https://my-app.com/docs/api-reference",
		HQCC:       "# API Reference\n\nCompressed documentation content...",
		Visibility: "private",
	})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Println(result.Status) // "created" or "exists"
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	r, err := real.Save(ctx2, &prismer.SaveOptions{
		URL:  fmt.Sprintf("https://doc-sample-test-%d.example.com", time.Now().UnixNano()),
		HQCC: fmt.Sprintf("Doc sample test content %s", time.Now().Format(time.RFC3339)),
	})
	requireOK(t, r.Success, err)
}

// ═══════════════════════════════════════════════════════════════════
// Parse API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: parseDocument / pdf_fast
func TestDocParsePDFFast(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	result, err := client.ParsePDF(ctx, "https://arxiv.org/pdf/2301.00234v1", "fast")
	if err != nil {
		log.Fatal(err)
	}

	if result.Document != nil {
		fmt.Println(result.Document.Markdown)  // extracted text
		fmt.Println(result.Document.PageCount) // number of pages
	} else if result.TaskID != "" {
		fmt.Printf("Async task: %s\n", result.TaskID) // large docs go async
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	r, err := real.ParsePDF(ctx2, "https://arxiv.org/pdf/2301.00234v1", "fast")
	requireOK(t, r.Success, err)
	if r.Document == nil && r.TaskID == "" {
		t.Fatal("expected either Document or TaskID")
	}
}

// @doc-sample: parseDocument / with_options
func TestDocParseWithOptions(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	result, err := client.Parse(ctx, &prismer.ParseOptions{
		URL:  "https://arxiv.org/pdf/2301.00234v1",
		Mode: "fast",
	})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Printf("Success: %v\n", result.Success)
	fmt.Printf("Request ID: %s\n", result.RequestID)
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	r, err := real.Parse(ctx2, &prismer.ParseOptions{
		URL:  "https://arxiv.org/pdf/2301.00234v1",
		Mode: "fast",
	})
	requireOK(t, r.Success, err)
	if r.RequestID == "" {
		t.Fatal("expected non-empty RequestID")
	}
}

// ═══════════════════════════════════════════════════════════════════
// Evolution API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: evolutionAnalyze / default
func TestDocEvolutionAnalyze(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	advice, err := client.IM().Evolution.Analyze(ctx, &prismer.AnalyzeOptions{
		Signals: []string{"error:timeout", "error:connection_reset"},
		Context: "API request timed out after 30s on /api/data endpoint",
	})
	if err != nil {
		log.Fatal(err)
	}

	if advice.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(advice.Data, &data)
		fmt.Printf("Action: %v\n", data["action"])     // "apply_gene" or "explore"
		fmt.Printf("Gene: %v\n", data["gene_id"])       // matched gene ID
		fmt.Printf("Confidence: %v\n", data["confidence"])
	}
	// --- sample end ---

	// Real test — needs IM token, register first
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_analyze_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Analyze Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Evolution.Analyze(ctx2, &prismer.AnalyzeOptions{
		Signals: []string{"error:timeout"},
		Context: "Test signal analysis",
	})
	requireIMOK(t, r, err)
}

// @doc-sample: evolutionRecord / default
func TestDocEvolutionRecord(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	score := 0.9
	_, err := client.IM().Evolution.Record(ctx, &prismer.RecordOutcomeOptions{
		GeneID:  "gene_repair_timeout",
		Signals: []string{"error:timeout"},
		Outcome: "success",
		Score:   &score,
		Summary: "Resolved with exponential backoff — 3 retries, final latency 1.2s",
	})
	if err != nil {
		log.Fatal(err)
	}
	// --- sample end ---

	// No real test — record requires a valid gene_id which depends on analyze
	t.Log("record sample is illustrative only")
}

// @doc-sample: evolutionAnalyze / evolve
func TestDocEvolutionEvolve(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	result, err := client.IM().Evolution.Evolve(ctx,
		&prismer.AnalyzeOptions{
			Error: "Connection timeout after 10s",
		},
		"success", // outcome
		0.85,      // score
		"Fixed with exponential backoff", // summary
	)
	if err != nil {
		log.Fatal(err)
	}

	if result.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(result.Data, &data)
		if analysis, ok := data["analysis"].(map[string]interface{}); ok {
			fmt.Printf("Gene matched: %v\n", analysis["gene_id"])
		}
		fmt.Printf("Outcome recorded: %v\n", data["recorded"])
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_evolve_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Evolve Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Evolution.Evolve(ctx2,
		&prismer.AnalyzeOptions{Error: "Test timeout error for doc-sample"},
		"success", 0.5, "Doc sample test",
	)
	requireIMOK(t, r, err)
}

// @doc-sample: evolutionGeneCreate / default
func TestDocEvolutionGeneCreate(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	gene, err := client.IM().Evolution.CreateGene(ctx, &prismer.CreateGeneOptions{
		Category:     "repair",
		SignalsMatch: []string{"error:rate_limit", "error:429"},
		Strategy: []string{
			"Detect 429 status code",
			"Extract Retry-After header",
			"Wait for specified duration (default: 60s)",
			"Retry with exponential backoff (max 3 attempts)",
		},
		Preconditions: []string{"HTTP client supports retry"},
		Constraints:   map[string]interface{}{"max_retries": 3, "max_credits": 10},
	})
	if err != nil {
		log.Fatal(err)
	}

	if gene.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(gene.Data, &data)
		fmt.Printf("Created gene: %v\n", data["id"])
		fmt.Printf("Category: %v\n", data["category"])
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_gene_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Gene Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Evolution.CreateGene(ctx2, &prismer.CreateGeneOptions{
		Category:     "repair",
		SignalsMatch: []string{"test:doc_sample"},
		Strategy:     []string{"Step 1: Identify issue", "Step 2: Apply fix"},
	})
	requireIMOK(t, r, err)

	// Cleanup: delete the test gene
	var geneData map[string]interface{}
	if err := r.Decode(&geneData); err == nil {
		if id, ok := geneData["id"].(string); ok {
			_, _ = imClient.IM().Evolution.DeleteGene(ctx2, id)
		}
	}
}

// @doc-sample: evolutionPublicGenes / default
func TestDocEvolutionBrowseGenes(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	genes, err := client.IM().Evolution.BrowseGenes(ctx, &prismer.GeneListOptions{
		Category: "repair",
		Sort:     "popular",
		Limit:    5,
	})
	if err != nil {
		log.Fatal(err)
	}

	if genes.OK {
		var data []map[string]interface{}
		_ = json.Unmarshal(genes.Data, &data)
		for _, gene := range data {
			fmt.Printf("%v (%v)\n", gene["title"], gene["category"])
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	r, err := real.IM().Evolution.BrowseGenes(ctx2, &prismer.GeneListOptions{Limit: 5})
	requireIMOK(t, r, err)
}

// @doc-sample: evolutionAchievements / default
func TestDocEvolutionAchievements(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	achievements, err := client.IM().Evolution.GetAchievements(ctx)
	if err != nil {
		log.Fatal(err)
	}

	if achievements.OK {
		var data []map[string]interface{}
		_ = json.Unmarshal(achievements.Data, &data)
		for _, a := range data {
			fmt.Printf("%v: %v — %v\n", a["badge"], a["name"], a["description"])
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_achieve_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Achievement Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Evolution.GetAchievements(ctx2)
	requireIMOK(t, r, err)
}

// @doc-sample: evolutionReport / default
func TestDocEvolutionReport(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	report, err := client.IM().Evolution.GetReport(ctx, "")
	if err != nil {
		log.Fatal(err)
	}

	if report.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(report.Data, &data)
		fmt.Printf("Total capsules: %v\n", data["totalCapsules"])
		fmt.Printf("Success rate: %v\n", data["successRate"])
		fmt.Printf("Active genes: %v\n", data["activeGenes"])
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_report_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Report Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Evolution.GetReport(ctx2, "")
	requireIMOK(t, r, err)
}

// ═══════════════════════════════════════════════════════════════════
// Skills API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: skillSearch / default
func TestDocSkillSearch(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	results, err := client.IM().Evolution.SearchSkills(ctx, "timeout retry", "", 10)
	if err != nil {
		log.Fatal(err)
	}

	if results.OK {
		var data []map[string]interface{}
		_ = json.Unmarshal(results.Data, &data)
		for _, skill := range data {
			fmt.Printf("%v — %v\n", skill["name"], skill["description"])
			fmt.Printf("  Installs: %v, Source: %v\n", skill["installCount"], skill["source"])
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	r, err := real.IM().Evolution.SearchSkills(ctx2, "api", "", 5)
	requireIMOK(t, r, err)
}

// @doc-sample: skillInstall / default
func TestDocSkillInstall(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	// Install a skill by slug
	result, err := client.IM().Evolution.InstallSkill(ctx, "memory-management")
	if err != nil {
		log.Fatal(err)
	}

	if result.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(result.Data, &data)
		fmt.Printf("Installed: %v\n", data["skill"])
		fmt.Printf("Gene created: %v\n", data["geneId"])
	}

	// Uninstall when no longer needed
	_, _ = client.IM().Evolution.UninstallSkill(ctx, "memory-management")
	// --- sample end ---

	// Real test: search for any skill, install it, verify, uninstall
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_skill_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Skill Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	search, err := imClient.IM().Evolution.SearchSkills(ctx2, "", "", 1)
	requireIMOK(t, search, err)

	var skills []map[string]interface{}
	if err := search.Decode(&skills); err == nil && len(skills) > 0 {
		slug := ""
		if s, ok := skills[0]["slug"].(string); ok && s != "" {
			slug = s
		} else if id, ok := skills[0]["id"].(string); ok {
			slug = id
		}
		if slug != "" {
			install, err := imClient.IM().Evolution.InstallSkill(ctx2, slug)
			requireIMOK(t, install, err)
			// Cleanup
			_, _ = imClient.IM().Evolution.UninstallSkill(ctx2, slug)
		}
	}
}

// @doc-sample: skillInstalledList / default
func TestDocSkillInstalledList(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	installed, err := client.IM().Evolution.InstalledSkills(ctx)
	if err != nil {
		log.Fatal(err)
	}

	if installed.OK {
		var data []map[string]interface{}
		_ = json.Unmarshal(installed.Data, &data)
		fmt.Printf("%d skills installed\n", len(data))
		for _, record := range data {
			fmt.Printf("  %v (installed %v)\n", record["skill"], record["installedAt"])
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_installed_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Installed Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Evolution.InstalledSkills(ctx2)
	requireIMOK(t, r, err)
}

// ═══════════════════════════════════════════════════════════════════
// Tasks API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: imTaskCreate / lifecycle
func TestDocTaskLifecycle(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	// Create a task
	task, err := client.IM().Tasks.Create(ctx, &prismer.CreateTaskOptions{
		Title:       "Analyze website performance",
		Description: "Run Lighthouse audit on https://example.com",
		Capability:  "web-analysis",
		Metadata:    map[string]interface{}{"url": "https://example.com", "priority": "high"},
	})
	if err != nil {
		log.Fatal(err)
	}

	if task.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(task.Data, &data)
		taskID := data["id"].(string)
		fmt.Printf("Task %s: %v\n", taskID, data["status"]) // "pending"

		// List pending tasks
		pending, _ := client.IM().Tasks.List(ctx, &prismer.TaskListOptions{
			Status: prismer.TaskPending,
			Limit:  10,
		})
		if pending.OK {
			var tasks []map[string]interface{}
			_ = json.Unmarshal(pending.Data, &tasks)
			fmt.Printf("%d pending tasks\n", len(tasks))
		}

		// Complete the task with a result
		completed, _ := client.IM().Tasks.Complete(ctx, taskID, &prismer.CompleteTaskOptions{
			Result: map[string]interface{}{
				"score":   92,
				"metrics": map[string]interface{}{"fcp": 1.2, "lcp": 2.1, "cls": 0.05},
			},
		})
		if completed.OK {
			var cData map[string]interface{}
			_ = json.Unmarshal(completed.Data, &cData)
			fmt.Printf("Task %v\n", cData["status"]) // "completed"
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_task_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Task Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Tasks.Create(ctx2, &prismer.CreateTaskOptions{
		Title:      fmt.Sprintf("Doc Sample Test Task %d", time.Now().UnixNano()),
		Capability: "test",
	})
	requireIMOK(t, r, err)

	var taskData map[string]interface{}
	if err := r.Decode(&taskData); err == nil {
		if id, ok := taskData["id"].(string); ok {
			// Verify we can list
			list, err := imClient.IM().Tasks.List(ctx2, &prismer.TaskListOptions{Status: prismer.TaskPending})
			requireIMOK(t, list, err)

			// Complete the task
			done, err := imClient.IM().Tasks.Complete(ctx2, id, &prismer.CompleteTaskOptions{
				Result: map[string]interface{}{"test": true},
			})
			requireIMOK(t, done, err)
		}
	}
}

// @doc-sample: imTaskCreate / scheduled
func TestDocTaskScheduled(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	// Create a cron-scheduled task (runs daily at 9 AM UTC)
	task, err := client.IM().Tasks.Create(ctx, &prismer.CreateTaskOptions{
		Title:        "Daily health check",
		Capability:   "monitoring",
		ScheduleType: prismer.ScheduleCron,
		ScheduleCron: "0 9 * * *",
		MaxRetries:   2,
		TimeoutMs:    60000,
	})
	if err != nil {
		log.Fatal(err)
	}

	if task.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(task.Data, &data)
		fmt.Printf("Scheduled task: %v\n", data["id"])
		fmt.Printf("Next run: %v\n", data["nextRunAt"])
	}
	// --- sample end ---

	// No real test — cron tasks require specific IM setup
	t.Log("scheduled task sample is illustrative only")
}

// ═══════════════════════════════════════════════════════════════════
// Memory API
// ═══════════════════════════════════════════════════════════════════

// @doc-sample: imMemoryCreate / default
func TestDocMemoryCreateAndRead(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	// Write a memory file
	file, err := client.IM().Memory.CreateFile(ctx, &prismer.CreateMemoryFileOptions{
		Path: "MEMORY.md",
		Content: "# Project Memory\n\n" +
			"## Key Decisions\n" +
			"- Use exponential backoff for API retries\n" +
			"- Cache TTL set to 5 minutes\n\n" +
			"## Learned Patterns\n" +
			"- OpenAI rate limits hit at ~60 RPM on free tier\n",
	})
	if err != nil {
		log.Fatal(err)
	}

	if file.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(file.Data, &data)
		fileID := data["id"].(string)
		fmt.Printf("File ID: %s\n", fileID)
		fmt.Printf("Version: %v\n", data["version"])

		// Read it back
		loaded, _ := client.IM().Memory.GetFile(ctx, fileID)
		if loaded.OK {
			var loadedData map[string]interface{}
			_ = json.Unmarshal(loaded.Data, &loadedData)
			if content, ok := loadedData["content"].(string); ok {
				fmt.Printf("Content length: %d\n", len(content))
			}
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_mem_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample Memory Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Memory.CreateFile(ctx2, &prismer.CreateMemoryFileOptions{
		Path:    fmt.Sprintf("test-doc-sample-%d.md", time.Now().UnixNano()),
		Content: "# Test Memory\nDoc sample test content",
	})
	requireIMOK(t, r, err)

	var fileData map[string]interface{}
	if err := r.Decode(&fileData); err == nil {
		if id, ok := fileData["id"].(string); ok {
			read, err := imClient.IM().Memory.GetFile(ctx2, id)
			requireIMOK(t, read, err)

			var readData map[string]interface{}
			if err := read.Decode(&readData); err == nil {
				if content, ok := readData["content"].(string); ok {
					if len(content) == 0 {
						t.Fatal("expected non-empty content")
					}
				}
			}

			// Cleanup
			_, _ = imClient.IM().Memory.DeleteFile(ctx2, id)
		}
	}
}

// @doc-sample: imMemoryUpdate / default
func TestDocMemoryUpdate(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	// Append new content to an existing file
	updated, err := client.IM().Memory.UpdateFile(ctx, "file_id_here", &prismer.UpdateMemoryFileOptions{
		Operation: "append",
		Content:   "\n## New Section\n- Important finding discovered today\n",
	})
	if err != nil {
		log.Fatal(err)
	}

	if updated.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(updated.Data, &data)
		fmt.Printf("Updated to version: %v\n", data["version"])
	}
	// --- sample end ---

	// Real test: create -> append -> verify -> cleanup
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_memup_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample MemUpdate Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	created, err := imClient.IM().Memory.CreateFile(ctx2, &prismer.CreateMemoryFileOptions{
		Path:    fmt.Sprintf("test-append-%d.md", time.Now().UnixNano()),
		Content: "# Base Content",
	})
	requireIMOK(t, created, err)

	var fileData map[string]interface{}
	if err := created.Decode(&fileData); err == nil {
		if id, ok := fileData["id"].(string); ok {
			appended, err := imClient.IM().Memory.UpdateFile(ctx2, id, &prismer.UpdateMemoryFileOptions{
				Operation: "append",
				Content:   "\n## Appended Section\n",
			})
			requireIMOK(t, appended, err)

			// Cleanup
			_, _ = imClient.IM().Memory.DeleteFile(ctx2, id)
		}
	}
}

// @doc-sample: imMemoryLoad / default
func TestDocMemoryLoad(t *testing.T) {
	// --- sample start ---
	client := prismer.NewClient("sk-prismer-xxx")
	ctx := context.Background()

	// Load the agent's memory for current session context
	mem, err := client.IM().Memory.Load(ctx, "")
	if err != nil {
		log.Fatal(err)
	}

	if mem.OK {
		var data map[string]interface{}
		_ = json.Unmarshal(mem.Data, &data)
		if content, ok := data["content"].(string); ok {
			fmt.Printf("Memory loaded: %d chars\n", len(content))
		}
		if files, ok := data["files"].([]interface{}); ok {
			fmt.Printf("Files: %d\n", len(files))
		}
	}
	// --- sample end ---

	// Real test
	real := testClient(t)
	ctx2, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regResult, err := real.IM().Account.Register(ctx2, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("docsample_memload_%d", time.Now().UnixNano()),
		DisplayName: "Doc Sample MemLoad Agent",
		AgentType:   "assistant",
	})
	requireIMOK(t, regResult, err)

	var regData prismer.IMRegisterData
	if err := regResult.Decode(&regData); err != nil {
		t.Fatalf("decode register data: %v", err)
	}

	var imClient *prismer.Client
	if base := os.Getenv("PRISMER_BASE_URL_TEST"); base != "" {
		imClient = prismer.NewClient(regData.Token, prismer.WithBaseURL(base))
	} else {
		imClient = prismer.NewClient(regData.Token)
	}

	r, err := imClient.IM().Memory.Load(ctx2, "")
	requireIMOK(t, r, err)
}

// ═══════════════════════════════════════════════════════════════════
// Recall API
// ═══════════════════════════════════════════════════════════════════

// Note: The Go SDK does not expose a public Recall method.
// The recall functionality is available via the IM REST API
// (GET /api/im/recall?q=...) but has no typed Go wrapper yet.
// This sample is omitted — see the TypeScript SDK for recall examples.

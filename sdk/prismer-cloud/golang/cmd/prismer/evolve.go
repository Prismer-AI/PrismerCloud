package main

import (
	"encoding/json"
	"fmt"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"
	"github.com/spf13/cobra"
)

var evolveCmd = &cobra.Command{
	Use:   "evolve",
	Short: "Evolution engine commands",
}

// ── evolve analyze ──────────────────────────────────────

var evolveAnalyzeSignals string
var evolveAnalyzeError string
var evolveAnalyzeTaskStatus string
var evolveAnalyzeProvider string
var evolveAnalyzeStage string
var evolveAnalyzeSeverity string
var evolveAnalyzeTags string
var evolveAnalyzeScope string
var evolveAnalyzeJSON bool
var evolveAnalyzeCmd = &cobra.Command{
	Use:   "analyze",
	Short: "Analyze signals and get gene recommendation",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		var signals []string
		if evolveAnalyzeSignals != "" {
			if err := json.Unmarshal([]byte(evolveAnalyzeSignals), &signals); err != nil {
				signals = splitComma(evolveAnalyzeSignals)
			}
		}
		opts := &prismer.AnalyzeOptions{Signals: signals}
		if evolveAnalyzeError != "" {
			opts.Error = evolveAnalyzeError
		}
		if evolveAnalyzeScope != "" {
			opts.Scope = evolveAnalyzeScope
		}
		res, err := client.Evolution.Analyze(ctx, opts)
		if err != nil {
			return err
		}
		if evolveAnalyzeJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("Action: %v\n", data["action"])
		if g, ok := data["gene"].(map[string]interface{}); ok {
			fmt.Printf("Gene:   %v\nTitle:  %v\n", g["id"], g["title"])
		}
		return nil
	},
}

// ── evolve record ───────────────────────────────────────

var evolveRecordGene, evolveRecordOutcome, evolveRecordSignals, evolveRecordSummary string
var evolveRecordScore string
var evolveRecordScope string
var evolveRecordJSON bool
var evolveRecordCmd = &cobra.Command{
	Use:   "record",
	Short: "Record gene execution outcome",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		var signals []string
		if evolveRecordSignals != "" {
			if err := json.Unmarshal([]byte(evolveRecordSignals), &signals); err != nil {
				signals = splitComma(evolveRecordSignals)
			}
		}
		res, err := client.Evolution.Record(ctx, &prismer.RecordOutcomeOptions{
			GeneID:  evolveRecordGene,
			Signals: signals,
			Outcome: evolveRecordOutcome,
			Summary: evolveRecordSummary,
			Scope:   evolveRecordScope,
		})
		if err != nil {
			return err
		}
		if evolveRecordJSON {
			return printJSON(res)
		}
		fmt.Println("Recorded:", res.OK)
		return nil
	},
}

// ── evolve report ───────────────────────────────────────

var evolveReportError string
var evolveReportStatus string
var evolveReportTask string
var evolveReportWait bool
var evolveReportJSON bool
var evolveReportCmd = &cobra.Command{
	Use:   "report",
	Short: "Submit a full evolution report (error + status context)",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		opts := map[string]interface{}{}
		if evolveReportTask != "" {
			opts["taskContext"] = evolveReportTask
		}

		res, err := client.Evolution.SubmitReport(ctx, evolveReportError, evolveReportStatus, opts)
		if err != nil {
			return err
		}
		if evolveReportJSON && !evolveReportWait {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		submitData := asMap(res.Data)
		traceID, _ := submitData["trace_id"].(string)

		if !evolveReportWait || traceID == "" {
			if evolveReportJSON {
				return printJSON(res)
			}
			fmt.Printf("Report submitted. trace_id: %s\n", traceID)
			return nil
		}

		fmt.Printf("Waiting for report %s ", traceID)
		for i := 0; i < 30; i++ {
			// simple sleep using context
			waitCtx := cmd.Context()
			_ = waitCtx
			// 2s busy wait — acceptable in a CLI
			statusRes, err := client.Evolution.GetReportStatus(ctx, traceID)
			if err != nil {
				break
			}
			statusData := asMap(statusRes.Data)
			status, _ := statusData["status"].(string)
			if status == "done" || status == "complete" || status == "completed" {
				fmt.Println()
				fmt.Printf("Status:    %s\n", status)
				if rc, ok := statusData["root_cause"]; ok {
					fmt.Printf("Root cause: %v\n", rc)
				}
				return nil
			}
			fmt.Print(".")
		}
		fmt.Println()
		fmt.Println("Timed out waiting for report.")
		return nil
	},
}

// ── evolve report-status ────────────────────────────────

var evolveReportStatusJSON bool
var evolveReportStatusCmd = &cobra.Command{
	Use:   "report-status <trace-id>",
	Short: "Check the status of a submitted evolution report",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.GetReportStatus(ctx, args[0])
		if err != nil {
			return err
		}
		if evolveReportStatusJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("trace_id: %s\nstatus:   %v\n", args[0], data["status"])
		if rc, ok := data["root_cause"]; ok {
			fmt.Printf("root_cause: %v\n", rc)
		}
		return nil
	},
}

// ── evolve create ───────────────────────────────────────

var evolveCreateCategory string
var evolveCreateSignals string
var evolveCreateStrategy []string
var evolveCreateName string
var evolveCreateScope string
var evolveCreateJSON bool
var evolveCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new evolution gene",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		var signals []string
		if evolveCreateSignals != "" {
			if err := json.Unmarshal([]byte(evolveCreateSignals), &signals); err != nil {
				signals = splitComma(evolveCreateSignals)
			}
		}

		opts := &prismer.CreateGeneOptions{
			Category:     evolveCreateCategory,
			SignalsMatch: signals,
			Strategy:     evolveCreateStrategy,
			Scope:        evolveCreateScope,
		}
		res, err := client.Evolution.CreateGene(ctx, opts)
		if err != nil {
			return err
		}
		if evolveCreateJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		id, _ := data["gene_id"].(string)
		if id == "" {
			id, _ = data["id"].(string)
		}
		fmt.Printf("Gene created: %s\n", id)
		if evolveCreateName != "" {
			fmt.Printf("Title:        %s\n", evolveCreateName)
		}
		fmt.Printf("Category:     %s\n", evolveCreateCategory)
		return nil
	},
}

// ── evolve genes ────────────────────────────────────────

var evolveGenesScope string
var evolveGenesJSON bool
var evolveGenesCmd = &cobra.Command{
	Use:   "genes",
	Short: "List your genes",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.ListGenes(ctx, "", evolveGenesScope)
		if err != nil {
			return err
		}
		if evolveGenesJSON {
			return printJSON(res)
		}
		genes := asList(res.Data)
		for _, g := range genes {
			gm := g.(map[string]interface{})
			fmt.Printf("  %v  %v  %v  %v\n", gm["id"], gm["category"], gm["title"], gm["visibility"])
		}
		fmt.Printf("\n%d genes\n", len(genes))
		return nil
	},
}

// ── evolve stats ────────────────────────────────────────

var evolveStatsJSON bool
var evolveStatsCmd = &cobra.Command{
	Use:   "stats",
	Short: "Show evolution statistics",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.GetStats(ctx)
		if err != nil {
			return err
		}
		if evolveStatsJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("Genes:      %v\nCapsules:   %v\nSuccess:    %v%%\nAgents:     %v\n", data["total_genes"], data["total_capsules"], data["avg_success_rate"], data["active_agents"])
		return nil
	},
}

// ── evolve metrics ──────────────────────────────────────

var evolveMetricsJSON bool
var evolveMetricsCmd = &cobra.Command{
	Use:   "metrics",
	Short: "Show A/B experiment metrics",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.GetMetrics(ctx)
		if err != nil {
			return err
		}
		if evolveMetricsJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("Verdict: %v\n", data["verdict"])
		return nil
	},
}

// ── evolve achievements ─────────────────────────────────

var evolveAchievementsJSON bool
var evolveAchievementsCmd = &cobra.Command{
	Use:   "achievements",
	Short: "Show your evolution achievements",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.GetAchievements(ctx)
		if err != nil {
			return err
		}
		if evolveAchievementsJSON {
			return printJSON(res)
		}
		items := asList(res.Data)
		if len(items) == 0 {
			fmt.Println("No achievements yet.")
			return nil
		}
		fmt.Printf("%d achievement(s):\n", len(items))
		for _, a := range items {
			am := asMap(a)
			fmt.Printf("  • %v %v — %v\n", am["id"], am["title"], am["description"])
		}
		return nil
	},
}

// ── evolve sync ─────────────────────────────────────────

var evolveSyncJSON bool
var evolveSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Get a sync snapshot of recent evolution data",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.GetSyncSnapshot(ctx, 0)
		if err != nil {
			return err
		}
		if evolveSyncJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		since := data["since"]
		if since == nil {
			since = data["timestamp"]
		}
		if since != nil {
			fmt.Printf("Snapshot since: %v\n", since)
		}
		if genes, ok := data["genes"].([]interface{}); ok {
			fmt.Printf("Genes: %d\n", len(genes))
		}
		if signals, ok := data["signals"].([]interface{}); ok {
			fmt.Printf("Signals: %d\n", len(signals))
		}
		return nil
	},
}

// ── evolve export-skill ─────────────────────────────────

var evolveExportSkillSlug string
var evolveExportSkillName string
var evolveExportSkillJSON bool
var evolveExportSkillCmd = &cobra.Command{
	Use:   "export-skill <gene-id>",
	Short: "Export a gene as a reusable skill",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		opts := map[string]interface{}{}
		if evolveExportSkillSlug != "" {
			opts["slug"] = evolveExportSkillSlug
		}
		if evolveExportSkillName != "" {
			opts["displayName"] = evolveExportSkillName
		}
		res, err := client.Evolution.ExportGeneAsSkill(ctx, args[0], opts)
		if err != nil {
			return err
		}
		if evolveExportSkillJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("Skill exported from gene: %s\n", args[0])
		if slug, ok := data["slug"]; ok {
			fmt.Printf("slug: %v\n", slug)
		}
		if skillID, ok := data["skill_id"]; ok {
			fmt.Printf("skill_id: %v\n", skillID)
		}
		return nil
	},
}

// ── evolve scopes ───────────────────────────────────────

var evolveScopesJSON bool
var evolveScopesCmd = &cobra.Command{
	Use:   "scopes",
	Short: "List available evolution scopes",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.ListScopes(ctx)
		if err != nil {
			return err
		}
		if evolveScopesJSON {
			return printJSON(res)
		}
		scopes := asList(res.Data)
		if len(scopes) == 0 {
			fmt.Println("No scopes found.")
			return nil
		}
		fmt.Printf("%d scope(s):\n", len(scopes))
		for _, s := range scopes {
			if str, ok := s.(string); ok {
				fmt.Printf("  • %s\n", str)
			} else {
				sm := asMap(s)
				name := sm["name"]
				if name == nil {
					name = sm["scope"]
				}
				if name == nil {
					name = sm["id"]
				}
				fmt.Printf("  • %v\n", name)
			}
		}
		return nil
	},
}

// ── evolve browse ───────────────────────────────────────

var evolveBrowseCategory string
var evolveBrowseSearch string
var evolveBrowseSort string
var evolveBrowseLimit int
var evolveBrowseJSON bool
var evolveBrowseCmd = &cobra.Command{
	Use:   "browse",
	Short: "Browse published evolution genes",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		opts := &prismer.GeneListOptions{}
		if evolveBrowseCategory != "" {
			opts.Category = evolveBrowseCategory
		}
		if evolveBrowseSearch != "" {
			opts.Search = evolveBrowseSearch
		}
		if evolveBrowseSort != "" {
			opts.Sort = evolveBrowseSort
		}
		if evolveBrowseLimit > 0 {
			opts.Limit = evolveBrowseLimit
		}
		res, err := client.Evolution.BrowseGenes(ctx, opts)
		if err != nil {
			return err
		}
		if evolveBrowseJSON {
			return printJSON(res)
		}
		genes := asList(res.Data)
		if len(genes) == 0 {
			fmt.Println("No genes found.")
			return nil
		}
		fmt.Printf("%d gene(s):\n", len(genes))
		for _, g := range genes {
			gm := asMap(g)
			id := gm["gene_id"]
			if id == nil {
				id = gm["id"]
			}
			title := gm["title"]
			category := gm["category"]
			score := gm["score"]
			scoreStr := ""
			if score != nil {
				scoreStr = fmt.Sprintf(" score=%v", score)
			}
			catStr := ""
			if category != nil {
				catStr = fmt.Sprintf(" [%v]", category)
			}
			titleStr := ""
			if title != nil && title != "" {
				titleStr = fmt.Sprintf(" — %v", title)
			}
			fmt.Printf("  • %v%s%s%s\n", id, titleStr, catStr, scoreStr)
		}
		return nil
	},
}

// ── evolve import ───────────────────────────────────────

var evolveImportJSON bool
var evolveImportCmd = &cobra.Command{
	Use:   "import <gene-id>",
	Short: "Import a published gene into your collection",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.ImportGene(ctx, args[0])
		if err != nil {
			return err
		}
		if evolveImportJSON {
			return printJSON(res)
		}
		fmt.Printf("Gene imported: %s\n", args[0])
		return nil
	},
}

// ── evolve distill ──────────────────────────────────────

var evolveDistillDryRun bool
var evolveDistillJSON bool
var evolveDistillCmd = &cobra.Command{
	Use:   "distill",
	Short: "Trigger gene distillation (consolidate learnings)",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.Distill(ctx, evolveDistillDryRun)
		if err != nil {
			return err
		}
		if evolveDistillJSON {
			return printJSON(res)
		}
		if evolveDistillDryRun {
			fmt.Println("Dry-run distillation preview:")
		} else {
			fmt.Println("Distillation triggered.")
		}
		data := asMap(res.Data)
		for k, v := range data {
			fmt.Printf("  %s: %v\n", k, v)
		}
		return nil
	},
}

func init() {
	evolveAnalyzeCmd.Flags().StringVarP(&evolveAnalyzeSignals, "signals", "s", "", "Signals (JSON or comma-separated)")
	evolveAnalyzeCmd.Flags().StringVarP(&evolveAnalyzeError, "error", "e", "", "Error message to analyze")
	evolveAnalyzeCmd.Flags().StringVar(&evolveAnalyzeTaskStatus, "task-status", "", "Task status (e.g. failed, timeout)")
	evolveAnalyzeCmd.Flags().StringVar(&evolveAnalyzeProvider, "provider", "", "Provider name (e.g. openai, exa)")
	evolveAnalyzeCmd.Flags().StringVar(&evolveAnalyzeStage, "stage", "", "Pipeline stage")
	evolveAnalyzeCmd.Flags().StringVar(&evolveAnalyzeSeverity, "severity", "", "Severity level (low, medium, high, critical)")
	evolveAnalyzeCmd.Flags().StringVar(&evolveAnalyzeTags, "tags", "", "Comma-separated tags")
	evolveAnalyzeCmd.Flags().StringVar(&evolveAnalyzeScope, "scope", "", "Evolution scope (default: global)")
	evolveAnalyzeCmd.Flags().BoolVar(&evolveAnalyzeJSON, "json", false, "JSON output")

	evolveRecordCmd.Flags().StringVarP(&evolveRecordGene, "gene", "g", "", "Gene ID")
	evolveRecordCmd.Flags().StringVarP(&evolveRecordOutcome, "outcome", "o", "", "success or failed")
	evolveRecordCmd.Flags().StringVarP(&evolveRecordSignals, "signals", "s", "", "Signals")
	evolveRecordCmd.Flags().StringVar(&evolveRecordScore, "score", "", "Outcome score (0-1)")
	evolveRecordCmd.Flags().StringVar(&evolveRecordSummary, "summary", "", "Summary")
	evolveRecordCmd.Flags().StringVar(&evolveRecordScope, "scope", "", "Evolution scope")
	evolveRecordCmd.Flags().BoolVar(&evolveRecordJSON, "json", false, "JSON output")

	evolveReportCmd.Flags().StringVarP(&evolveReportError, "error", "e", "", "Raw error message or context")
	evolveReportCmd.Flags().StringVar(&evolveReportStatus, "status", "", "Final task outcome (success, failure, partial)")
	evolveReportCmd.Flags().StringVar(&evolveReportTask, "task", "", "Task context description")
	evolveReportCmd.Flags().BoolVar(&evolveReportWait, "wait", false, "Poll for report completion (max 60s)")
	evolveReportCmd.Flags().BoolVar(&evolveReportJSON, "json", false, "JSON output")
	_ = evolveReportCmd.MarkFlagRequired("error")
	_ = evolveReportCmd.MarkFlagRequired("status")

	evolveReportStatusCmd.Flags().BoolVar(&evolveReportStatusJSON, "json", false, "JSON output")

	evolveCreateCmd.Flags().StringVarP(&evolveCreateCategory, "category", "c", "", "Gene category")
	evolveCreateCmd.Flags().StringVarP(&evolveCreateSignals, "signals", "s", "", "Trigger signals (JSON or comma-separated)")
	evolveCreateCmd.Flags().StringArrayVar(&evolveCreateStrategy, "strategy", nil, "Strategy step (repeatable)")
	evolveCreateCmd.Flags().StringVarP(&evolveCreateName, "name", "n", "", "Gene title / display name")
	evolveCreateCmd.Flags().StringVar(&evolveCreateScope, "scope", "", "Evolution scope")
	evolveCreateCmd.Flags().BoolVar(&evolveCreateJSON, "json", false, "JSON output")
	_ = evolveCreateCmd.MarkFlagRequired("category")
	_ = evolveCreateCmd.MarkFlagRequired("signals")

	evolveStatsCmd.Flags().BoolVar(&evolveStatsJSON, "json", false, "JSON output")

	evolveGenesCmd.Flags().StringVar(&evolveGenesScope, "scope", "", "Filter by evolution scope")
	evolveGenesCmd.Flags().BoolVar(&evolveGenesJSON, "json", false, "JSON output")

	evolveMetricsCmd.Flags().BoolVar(&evolveMetricsJSON, "json", false, "JSON output")

	evolveAchievementsCmd.Flags().BoolVar(&evolveAchievementsJSON, "json", false, "JSON output")

	evolveSyncCmd.Flags().BoolVar(&evolveSyncJSON, "json", false, "JSON output")

	evolveExportSkillCmd.Flags().StringVar(&evolveExportSkillSlug, "slug", "", "Custom slug for the exported skill")
	evolveExportSkillCmd.Flags().StringVar(&evolveExportSkillName, "name", "", "Skill display name")
	evolveExportSkillCmd.Flags().BoolVar(&evolveExportSkillJSON, "json", false, "JSON output")

	evolveScopesCmd.Flags().BoolVar(&evolveScopesJSON, "json", false, "JSON output")

	evolveBrowseCmd.Flags().StringVarP(&evolveBrowseCategory, "category", "c", "", "Filter by category")
	evolveBrowseCmd.Flags().StringVar(&evolveBrowseSearch, "search", "", "Full-text search query")
	evolveBrowseCmd.Flags().StringVar(&evolveBrowseSort, "sort", "", "Sort field (e.g. score, created_at)")
	evolveBrowseCmd.Flags().IntVarP(&evolveBrowseLimit, "limit", "n", 20, "Max results to return")
	evolveBrowseCmd.Flags().BoolVar(&evolveBrowseJSON, "json", false, "JSON output")

	evolveImportCmd.Flags().BoolVar(&evolveImportJSON, "json", false, "JSON output")

	evolveDistillCmd.Flags().BoolVar(&evolveDistillDryRun, "dry-run", false, "Preview distillation without applying changes")
	evolveDistillCmd.Flags().BoolVar(&evolveDistillJSON, "json", false, "JSON output")

	evolveCmd.AddCommand(evolveAnalyzeCmd)
	evolveCmd.AddCommand(evolveRecordCmd)
	evolveCmd.AddCommand(evolveReportCmd)
	evolveCmd.AddCommand(evolveReportStatusCmd)
	evolveCmd.AddCommand(evolveCreateCmd)
	evolveCmd.AddCommand(evolveGenesCmd)
	evolveCmd.AddCommand(evolveStatsCmd)
	evolveCmd.AddCommand(evolveMetricsCmd)
	evolveCmd.AddCommand(evolveAchievementsCmd)
	evolveCmd.AddCommand(evolveSyncCmd)
	evolveCmd.AddCommand(evolveExportSkillCmd)
	evolveCmd.AddCommand(evolveScopesCmd)
	evolveCmd.AddCommand(evolveBrowseCmd)
	evolveCmd.AddCommand(evolveImportCmd)
	evolveCmd.AddCommand(evolveDistillCmd)
	rootCmd.AddCommand(evolveCmd)
}

func splitComma(s string) []string {
	parts := make([]string, 0)
	current := ""
	for _, c := range s {
		if c == ',' {
			if current != "" {
				parts = append(parts, current)
			}
			current = ""
		} else {
			current += string(c)
		}
	}
	if current != "" {
		parts = append(parts, current)
	}
	return parts
}

func asMap(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	// Handle json.RawMessage ([]byte)
	if raw, ok := v.(json.RawMessage); ok {
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err == nil {
			return m
		}
	}
	return map[string]interface{}{}
}

func asList(v interface{}) []interface{} {
	if l, ok := v.([]interface{}); ok {
		return l
	}
	// Handle json.RawMessage ([]byte)
	if raw, ok := v.(json.RawMessage); ok {
		var l []interface{}
		if err := json.Unmarshal(raw, &l); err == nil {
			return l
		}
	}
	return nil
}

func printJSON(v interface{}) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}

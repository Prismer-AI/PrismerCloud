package main

import (
	"encoding/json"
	"fmt"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/golang"
	"github.com/spf13/cobra"
)

var evolveCmd = &cobra.Command{
	Use:   "evolve",
	Short: "Evolution engine commands",
}

var evolveAnalyzeSignals string
var evolveAnalyzeJSON bool
var evolveAnalyzeCmd = &cobra.Command{
	Use:   "analyze",
	Short: "Analyze signals and get gene recommendation",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		// parse signals as string slice
		var signals []string
		if err := json.Unmarshal([]byte(evolveAnalyzeSignals), &signals); err != nil {
			signals = splitComma(evolveAnalyzeSignals)
		}
		res, err := client.Evolution.Analyze(ctx, &prismer.AnalyzeOptions{Signals: signals})
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

var evolveRecordGene, evolveRecordOutcome, evolveRecordSignals, evolveRecordSummary string
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

var evolveGenesJSON bool
var evolveGenesCmd = &cobra.Command{
	Use:   "genes",
	Short: "List your genes",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.ListGenes(ctx, "", "")
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

func init() {
	evolveAnalyzeCmd.Flags().StringVarP(&evolveAnalyzeSignals, "signals", "s", "", "Signals (JSON or comma-separated)")
	evolveAnalyzeCmd.Flags().BoolVar(&evolveAnalyzeJSON, "json", false, "JSON output")
	evolveRecordCmd.Flags().StringVarP(&evolveRecordGene, "gene", "g", "", "Gene ID")
	evolveRecordCmd.Flags().StringVarP(&evolveRecordOutcome, "outcome", "o", "", "success or failed")
	evolveRecordCmd.Flags().StringVarP(&evolveRecordSignals, "signals", "s", "", "Signals")
	evolveRecordCmd.Flags().StringVar(&evolveRecordSummary, "summary", "", "Summary")
	evolveRecordCmd.Flags().BoolVar(&evolveRecordJSON, "json", false, "JSON output")
	evolveStatsCmd.Flags().BoolVar(&evolveStatsJSON, "json", false, "JSON output")
	evolveGenesCmd.Flags().BoolVar(&evolveGenesJSON, "json", false, "JSON output")
	evolveMetricsCmd.Flags().BoolVar(&evolveMetricsJSON, "json", false, "JSON output")

	evolveCmd.AddCommand(evolveAnalyzeCmd)
	evolveCmd.AddCommand(evolveRecordCmd)
	evolveCmd.AddCommand(evolveStatsCmd)
	evolveCmd.AddCommand(evolveGenesCmd)
	evolveCmd.AddCommand(evolveMetricsCmd)
	rootCmd.AddCommand(evolveCmd)
}

func splitComma(s string) []string {
	var result []string
	for _, p := range []byte(s) {
		if p == ',' {
			result = append(result, "")
		}
	}
	// simple split
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

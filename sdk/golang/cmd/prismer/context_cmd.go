package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	prismer "github.com/Prismer-AI/Prismer/sdk/golang"
	"github.com/spf13/cobra"
)

// ============================================================================
// Flag variables
// ============================================================================

var (
	// context load
	contextLoadFormat string
	contextLoadJSON   bool

	// context search
	contextSearchTopK int
	contextSearchJSON bool

	// context save
	contextSaveJSON bool
)

// ============================================================================
// Root context command
// ============================================================================

var contextCmd = &cobra.Command{
	Use:   "context",
	Short: "Context API commands",
	Long:  "Load, search, and save content using the Prismer Context API.",
}

// ============================================================================
// context load
// ============================================================================

var contextLoadCmd = &cobra.Command{
	Use:   "load <url>",
	Short: "Load content from a URL",
	Long:  "Fetch and process content from the given URL using the Context API.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		inputURL := args[0]
		client := getAPIClient()

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		var opts *prismer.LoadOptions
		if contextLoadFormat != "" {
			opts = &prismer.LoadOptions{
				Return: &prismer.ReturnConfig{Format: contextLoadFormat},
			}
		}

		result, err := client.Load(ctx, inputURL, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.Success {
			if result.Error != nil {
				return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
			}
			return fmt.Errorf("API returned an error (no details)")
		}

		if contextLoadJSON {
			data, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return fmt.Errorf("failed to marshal response: %w", err)
			}
			fmt.Println(string(data))
			return nil
		}

		fmt.Printf("Request ID: %s\n", result.RequestID)
		fmt.Printf("Mode:       %s\n", result.Mode)
		if result.Result != nil {
			fmt.Printf("URL:        %s\n", result.Result.URL)
			fmt.Printf("Title:      %s\n", result.Result.Title)
			fmt.Printf("Cached:     %v\n", result.Result.Cached)
			if result.Result.HQCC != "" {
				content := result.Result.HQCC
				if len(content) > 500 {
					content = content[:500] + "..."
				}
				fmt.Printf("HQCC:\n%s\n", content)
			}
		}
		if len(result.Results) > 0 {
			fmt.Printf("Results:    %d items\n", len(result.Results))
			for _, r := range result.Results {
				fmt.Printf("  - %s (%s) cached=%v\n", r.URL, r.Title, r.Cached)
			}
		}
		if result.ProcessingTime > 0 {
			fmt.Printf("Time:       %dms\n", result.ProcessingTime)
		}
		return nil
	},
}

// ============================================================================
// context search
// ============================================================================

var contextSearchCmd = &cobra.Command{
	Use:   "search <query>",
	Short: "Search cached content",
	Long:  "Search across cached content using semantic search.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		query := args[0]
		client := getAPIClient()

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		var opts *prismer.SearchOptions
		if contextSearchTopK > 0 {
			opts = &prismer.SearchOptions{TopK: contextSearchTopK}
		}

		result, err := client.Search(ctx, query, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.Success {
			if result.Error != nil {
				return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
			}
			return fmt.Errorf("API returned an error (no details)")
		}

		if contextSearchJSON {
			data, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return fmt.Errorf("failed to marshal response: %w", err)
			}
			fmt.Println(string(data))
			return nil
		}

		fmt.Printf("Request ID: %s\n", result.RequestID)
		if len(result.Results) == 0 {
			fmt.Println("No results found.")
			return nil
		}

		fmt.Printf("Results: %d\n", len(result.Results))
		for _, r := range result.Results {
			score := ""
			if r.Ranking != nil {
				score = fmt.Sprintf(" (score: %.3f)", r.Ranking.Score)
			}
			fmt.Printf("  %d. %s - %s%s\n", r.Rank, r.URL, r.Title, score)
		}
		if result.ProcessingTime > 0 {
			fmt.Printf("Time: %dms\n", result.ProcessingTime)
		}
		return nil
	},
}

// ============================================================================
// context save
// ============================================================================

var contextSaveCmd = &cobra.Command{
	Use:   "save <url> <hqcc>",
	Short: "Save HQCC content for a URL",
	Long:  "Store processed HQCC content for the given URL in the cache.",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		saveURL, hqcc := args[0], args[1]
		client := getAPIClient()

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		opts := &prismer.SaveOptions{
			URL:  saveURL,
			HQCC: hqcc,
		}

		result, err := client.Save(ctx, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.Success {
			if result.Error != nil {
				return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
			}
			return fmt.Errorf("API returned an error (no details)")
		}

		if contextSaveJSON {
			data, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return fmt.Errorf("failed to marshal response: %w", err)
			}
			fmt.Println(string(data))
			return nil
		}

		fmt.Printf("Saved: %s\n", result.URL)
		fmt.Printf("Status: %s\n", result.Status)
		return nil
	},
}

// ============================================================================
// Registration
// ============================================================================

func init() {
	// context load
	contextLoadCmd.Flags().StringVar(&contextLoadFormat, "format", "", "Return format: hqcc, raw, or both")
	contextLoadCmd.Flags().BoolVar(&contextLoadJSON, "json", false, "Output raw JSON")

	// context search
	contextSearchCmd.Flags().IntVar(&contextSearchTopK, "top-k", 5, "Number of results to return")
	contextSearchCmd.Flags().BoolVar(&contextSearchJSON, "json", false, "Output raw JSON")

	// context save
	contextSaveCmd.Flags().BoolVar(&contextSaveJSON, "json", false, "Output raw JSON")

	// Wire up sub-commands.
	contextCmd.AddCommand(contextLoadCmd)
	contextCmd.AddCommand(contextSearchCmd)
	contextCmd.AddCommand(contextSaveCmd)

	// Register context under root.
	rootCmd.AddCommand(contextCmd)
}

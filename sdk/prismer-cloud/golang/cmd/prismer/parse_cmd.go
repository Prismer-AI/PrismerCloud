package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

// ============================================================================
// Flag variables
// ============================================================================

var (
	// parse run
	parseRunMode string
	parseRunJSON bool

	// parse status
	parseStatusJSON bool

	// parse result
	parseResultJSON bool
)

// ============================================================================
// Root parse command
// ============================================================================

var parseCmd = &cobra.Command{
	Use:   "parse",
	Short: "Parse API commands",
	Long:  "Parse documents using the Prismer Parse API. Submit PDFs, check status, and retrieve results.",
}

// ============================================================================
// parse run
// ============================================================================

var parseRunCmd = &cobra.Command{
	Use:   "run <url>",
	Short: "Submit a document for parsing",
	Long:  "Submit a PDF URL for parsing. Returns a task ID for async processing or the result for sync.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		pdfURL := args[0]
		client := getAPIClient()

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		mode := parseRunMode
		if mode == "" {
			mode = "fast"
		}

		result, err := client.ParsePDF(ctx, pdfURL, mode)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.Success {
			if result.Error != nil {
				return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
			}
			return fmt.Errorf("API returned an error (no details)")
		}

		if parseRunJSON {
			data, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return fmt.Errorf("failed to marshal response: %w", err)
			}
			fmt.Println(string(data))
			return nil
		}

		fmt.Printf("Request ID: %s\n", result.RequestID)
		fmt.Printf("Mode:       %s\n", result.Mode)

		if result.Async {
			fmt.Printf("Task ID:    %s\n", result.TaskID)
			fmt.Printf("Status:     %s\n", result.Status)
			if result.Endpoints != nil {
				fmt.Printf("Status URL: %s\n", result.Endpoints.Status)
				fmt.Printf("Result URL: %s\n", result.Endpoints.Result)
			}
			if result.Document != nil && result.Document.EstimatedTime > 0 {
				fmt.Printf("Estimated:  %ds\n", result.Document.EstimatedTime)
			}
			fmt.Println("\nUse 'prismer parse status <task-id>' to check progress.")
		} else {
			if result.Document != nil {
				fmt.Printf("Pages:      %d\n", result.Document.PageCount)
				if result.Document.Markdown != "" {
					content := result.Document.Markdown
					if len(content) > 500 {
						content = content[:500] + "..."
					}
					fmt.Printf("Markdown:\n%s\n", content)
				}
			}
			if result.Usage != nil {
				fmt.Printf("Usage:      %d pages, %d chars\n", result.Usage.InputPages, result.Usage.OutputChars)
			}
			if result.Cost != nil {
				fmt.Printf("Cost:       %.4f credits\n", result.Cost.Credits)
			}
		}
		if result.ProcessingTime > 0 {
			fmt.Printf("Time:       %dms\n", result.ProcessingTime)
		}
		return nil
	},
}

// ============================================================================
// parse status
// ============================================================================

var parseStatusCmd = &cobra.Command{
	Use:   "status <task-id>",
	Short: "Check parse task status",
	Long:  "Check the processing status of an async parse task.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		taskID := args[0]
		client := getAPIClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		result, err := client.ParseStatus(ctx, taskID)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.Success {
			if result.Error != nil {
				return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
			}
			return fmt.Errorf("API returned an error (no details)")
		}

		if parseStatusJSON {
			data, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return fmt.Errorf("failed to marshal response: %w", err)
			}
			fmt.Println(string(data))
			return nil
		}

		fmt.Printf("Task ID: %s\n", result.TaskID)
		fmt.Printf("Status:  %s\n", result.Status)
		if result.Document != nil && result.Document.EstimatedTime > 0 {
			fmt.Printf("Estimated time: %ds\n", result.Document.EstimatedTime)
		}
		return nil
	},
}

// ============================================================================
// parse result
// ============================================================================

var parseResultCmd = &cobra.Command{
	Use:   "result <task-id>",
	Short: "Get parse task result",
	Long:  "Retrieve the completed result of an async parse task.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		taskID := args[0]
		client := getAPIClient()

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		result, err := client.ParseResultByID(ctx, taskID)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.Success {
			if result.Error != nil {
				return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
			}
			return fmt.Errorf("API returned an error (no details)")
		}

		if parseResultJSON {
			data, err := json.MarshalIndent(result, "", "  ")
			if err != nil {
				return fmt.Errorf("failed to marshal response: %w", err)
			}
			fmt.Println(string(data))
			return nil
		}

		fmt.Printf("Task ID: %s\n", result.TaskID)
		fmt.Printf("Status:  %s\n", result.Status)
		if result.Document != nil {
			fmt.Printf("Pages:   %d\n", result.Document.PageCount)
			if result.Document.Markdown != "" {
				content := result.Document.Markdown
				if len(content) > 1000 {
					content = content[:1000] + "..."
				}
				fmt.Printf("Markdown:\n%s\n", content)
			}
			if len(result.Document.Images) > 0 {
				fmt.Printf("Images:  %d\n", len(result.Document.Images))
			}
		}
		if result.Usage != nil {
			fmt.Printf("Usage:   %d pages, %d chars\n", result.Usage.InputPages, result.Usage.OutputChars)
		}
		if result.Cost != nil {
			fmt.Printf("Cost:    %.4f credits\n", result.Cost.Credits)
		}
		if result.ProcessingTime > 0 {
			fmt.Printf("Time:    %dms\n", result.ProcessingTime)
		}
		return nil
	},
}

// ============================================================================
// Registration
// ============================================================================

func init() {
	// parse run
	parseRunCmd.Flags().StringVar(&parseRunMode, "mode", "fast", "Parse mode: fast, hires, or auto")
	parseRunCmd.Flags().BoolVar(&parseRunJSON, "json", false, "Output raw JSON")

	// parse status
	parseStatusCmd.Flags().BoolVar(&parseStatusJSON, "json", false, "Output raw JSON")

	// parse result
	parseResultCmd.Flags().BoolVar(&parseResultJSON, "json", false, "Output raw JSON")

	// Wire up sub-commands.
	parseCmd.AddCommand(parseRunCmd)
	parseCmd.AddCommand(parseStatusCmd)
	parseCmd.AddCommand(parseResultCmd)

	// Register parse under root.
	rootCmd.AddCommand(parseCmd)
}

package main

import (
	"fmt"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"
	"github.com/spf13/cobra"
)

var memoryCmd = &cobra.Command{
	Use:   "memory",
	Short: "Agent memory file management",
}

// ── memory write ────────────────────────────────────────

var (
	memoryWriteScope   string
	memoryWritePath    string
	memoryWriteContent string
	memoryWriteJSON    bool
)

var memoryWriteCmd = &cobra.Command{
	Use:   "write",
	Short: "Write a memory file",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Memory.CreateFile(ctx, &prismer.CreateMemoryFileOptions{
			Scope:   memoryWriteScope,
			Path:    memoryWritePath,
			Content: memoryWriteContent,
		})
		if err != nil {
			return err
		}
		if memoryWriteJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Memory file created\n")
		fmt.Printf("  ID:    %v\n", data["id"])
		fmt.Printf("  Scope: %v\n", data["scope"])
		fmt.Printf("  Path:  %v\n", data["path"])
		return nil
	},
}

// ── memory read ─────────────────────────────────────────

var (
	memoryReadScope string
	memoryReadPath  string
	memoryReadJSON  bool
)

var memoryReadCmd = &cobra.Command{
	Use:   "read [file-id]",
	Short: "Read a memory file by ID, or filter by scope/path",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		if len(args) == 1 {
			// Direct lookup by ID
			res, err := client.Memory.GetFile(ctx, args[0])
			if err != nil {
				return err
			}
			if memoryReadJSON {
				return printJSON(res)
			}
			if !res.OK {
				return fmt.Errorf("API error: %v", res.Error)
			}
			data := asMap(res.Data)
			fmt.Printf("ID:    %v\nScope: %v\nPath:  %v\n\n%v\n",
				data["id"], data["scope"], data["path"], data["content"])
			return nil
		}

		// Filter by scope/path
		res, err := client.Memory.ListFiles(ctx, memoryReadScope, memoryReadPath)
		if err != nil {
			return err
		}
		if memoryReadJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		files := asList(res.Data)
		if len(files) == 0 {
			fmt.Println("No memory files found.")
			return nil
		}
		if len(files) == 1 {
			// Auto-read single match
			fm := asMap(files[0])
			id, _ := fm["id"].(string)
			if id != "" {
				detail, err := client.Memory.GetFile(ctx, id)
				if err == nil && detail.OK {
					data := asMap(detail.Data)
					fmt.Printf("ID:    %v\nScope: %v\nPath:  %v\n\n%v\n",
						data["id"], data["scope"], data["path"], data["content"])
					return nil
				}
			}
		}
		printMemoryTable(files)
		return nil
	},
}

// ── memory list ─────────────────────────────────────────

var (
	memoryListScope string
	memoryListJSON  bool
)

var memoryListCmd = &cobra.Command{
	Use:   "list",
	Short: "List memory files",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Memory.ListFiles(ctx, memoryListScope, "")
		if err != nil {
			return err
		}
		if memoryListJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		files := asList(res.Data)
		if len(files) == 0 {
			fmt.Println("No memory files found.")
			return nil
		}
		printMemoryTable(files)
		return nil
	},
}

// ── memory delete ───────────────────────────────────────

var memoryDeleteJSON bool
var memoryDeleteCmd = &cobra.Command{
	Use:   "delete <file-id>",
	Short: "Delete a memory file by ID",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Memory.DeleteFile(ctx, args[0])
		if err != nil {
			return err
		}
		if memoryDeleteJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		fmt.Printf("Deleted memory file: %s\n", args[0])
		return nil
	},
}

// ── memory compact ──────────────────────────────────────

var memoryCompactJSON bool
var memoryCompactCmd = &cobra.Command{
	Use:   "compact <conversation-id>",
	Short: "Create a compaction summary for a conversation",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Memory.Compact(ctx, &prismer.CompactOptions{
			ConversationId: args[0],
		})
		if err != nil {
			return err
		}
		if memoryCompactJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Compaction complete\n")
		if id, ok := data["id"]; ok {
			fmt.Printf("  Summary ID:      %v\n", id)
		}
		if convID, ok := data["conversationId"]; ok {
			fmt.Printf("  Conversation ID: %v\n", convID)
		}
		return nil
	},
}

// ── memory load ─────────────────────────────────────────

var (
	memoryLoadScope string
	memoryLoadJSON  bool
)

var memoryLoadCmd = &cobra.Command{
	Use:   "load",
	Short: "Load session memory context",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Memory.Load(ctx, memoryLoadScope)
		if err != nil {
			return err
		}
		if memoryLoadJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		if res.Data == nil {
			fmt.Println("No memory context available.")
			return nil
		}
		fmt.Println("Memory context loaded:")
		fmt.Println()
		return printJSON(res.Data)
	},
}

// ── helpers ─────────────────────────────────────────────

func printMemoryTable(files []interface{}) {
	fmt.Printf("%-36s  %-20s  %s\n", "ID", "SCOPE", "PATH")
	fmt.Printf("%-36s  %-20s  %s\n", "------", "-----", "----")
	for _, f := range files {
		fm := asMap(f)
		fmt.Printf("%-36v  %-20v  %v\n", fm["id"], fm["scope"], fm["path"])
	}
}

func init() {
	memoryWriteCmd.Flags().StringVarP(&memoryWriteScope, "scope", "s", "", "Memory scope")
	memoryWriteCmd.Flags().StringVarP(&memoryWritePath, "path", "p", "", "File path within scope")
	memoryWriteCmd.Flags().StringVarP(&memoryWriteContent, "content", "c", "", "File content")
	memoryWriteCmd.Flags().BoolVar(&memoryWriteJSON, "json", false, "Output raw JSON")
	_ = memoryWriteCmd.MarkFlagRequired("scope")
	_ = memoryWriteCmd.MarkFlagRequired("path")
	_ = memoryWriteCmd.MarkFlagRequired("content")

	memoryReadCmd.Flags().StringVarP(&memoryReadScope, "scope", "s", "", "Filter by scope (used when no file-id given)")
	memoryReadCmd.Flags().StringVarP(&memoryReadPath, "path", "p", "", "Filter by path (used when no file-id given)")
	memoryReadCmd.Flags().BoolVar(&memoryReadJSON, "json", false, "Output raw JSON")

	memoryListCmd.Flags().StringVarP(&memoryListScope, "scope", "s", "", "Filter by scope")
	memoryListCmd.Flags().BoolVar(&memoryListJSON, "json", false, "Output raw JSON")

	memoryDeleteCmd.Flags().BoolVar(&memoryDeleteJSON, "json", false, "Output raw JSON")

	memoryCompactCmd.Flags().BoolVar(&memoryCompactJSON, "json", false, "Output raw JSON")

	memoryLoadCmd.Flags().StringVarP(&memoryLoadScope, "scope", "s", "", "Scope to load")
	memoryLoadCmd.Flags().BoolVar(&memoryLoadJSON, "json", false, "Output raw JSON")

	memoryCmd.AddCommand(memoryWriteCmd)
	memoryCmd.AddCommand(memoryReadCmd)
	memoryCmd.AddCommand(memoryListCmd)
	memoryCmd.AddCommand(memoryDeleteCmd)
	memoryCmd.AddCommand(memoryCompactCmd)
	memoryCmd.AddCommand(memoryLoadCmd)
	rootCmd.AddCommand(memoryCmd)
}

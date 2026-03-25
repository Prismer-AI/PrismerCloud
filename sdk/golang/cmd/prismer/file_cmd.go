package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/golang"
	"github.com/spf13/cobra"
)

// fileCmd is the top-level "file" command group (singular, matches TypeScript).
// It mirrors the functionality of "im files" but is accessible at the top level.
var fileCmd = &cobra.Command{
	Use:   "file",
	Short: "File upload, transfer, quota, and type management",
}

// ── file upload ─────────────────────────────────────────

var (
	fileUploadMime string
	fileUploadJSON bool
)

var fileUploadCmd = &cobra.Command{
	Use:   "upload <path>",
	Short: "Upload a file and get its upload ID and CDN URL",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		var opts *prismer.UploadOptions
		if fileUploadMime != "" {
			opts = &prismer.UploadOptions{MimeType: fileUploadMime}
		}
		result, err := client.Files.UploadFile(ctx, args[0], opts)
		if err != nil {
			return fmt.Errorf("upload failed: %w", err)
		}
		if fileUploadJSON {
			b, _ := json.MarshalIndent(result, "", "  ")
			fmt.Println(string(b))
			return nil
		}
		fmt.Printf("Upload ID: %s\n", result.UploadID)
		fmt.Printf("CDN URL:   %s\n", result.CdnURL)
		fmt.Printf("File:      %s (%d bytes)\n", result.FileName, result.FileSize)
		fmt.Printf("MIME:      %s\n", result.MimeType)
		return nil
	},
}

// ── file send ───────────────────────────────────────────

var (
	fileSendContent string
	fileSendMime    string
	fileSendJSON    bool
)

var fileSendCmd = &cobra.Command{
	Use:   "send <conversation-id> <path>",
	Short: "Upload a file and send it as a message in a conversation",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		conversationID, filePath := args[0], args[1]
		client := getIMClient().IM()
		ctx := cmd.Context()

		data, err := os.ReadFile(filePath)
		if err != nil {
			return fmt.Errorf("failed to read file: %w", err)
		}

		opts := &prismer.SendFileOptions{
			FileName: filepath.Base(filePath),
			Content:  fileSendContent,
		}
		if fileSendMime != "" {
			opts.MimeType = fileSendMime
		}

		result, err := client.Files.SendFile(ctx, conversationID, data, opts)
		if err != nil {
			return fmt.Errorf("send file failed: %w", err)
		}

		if fileSendJSON {
			b, _ := json.MarshalIndent(result, "", "  ")
			fmt.Println(string(b))
			return nil
		}

		fmt.Printf("File sent\n")
		fmt.Printf("Upload ID: %s\n", result.Upload.UploadID)
		fmt.Printf("CDN URL:   %s\n", result.Upload.CdnURL)
		return nil
	},
}

// ── file quota ──────────────────────────────────────────

var fileQuotaJSON bool
var fileQuotaCmd = &cobra.Command{
	Use:   "quota",
	Short: "Show file storage quota and usage",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		result, err := client.Files.Quota(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}
		if fileQuotaJSON {
			fmt.Println(string(result.Data))
			return nil
		}
		var quota prismer.IMFileQuota
		if err := result.Decode(&quota); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}
		fmt.Printf("Tier:       %s\n", quota.Tier)
		fmt.Printf("Used:       %d bytes\n", quota.Used)
		fmt.Printf("Limit:      %d bytes\n", quota.Limit)
		fmt.Printf("File Count: %d\n", quota.FileCount)
		return nil
	},
}

// ── file delete ─────────────────────────────────────────

var fileDeleteCmd = &cobra.Command{
	Use:   "delete <upload-id>",
	Short: "Delete an uploaded file by its upload ID",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		result, err := client.Files.Delete(ctx, args[0])
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}
		fmt.Printf("File %s deleted.\n", args[0])
		return nil
	},
}

// ── file types ──────────────────────────────────────────

var fileTypesJSON bool
var fileTypesCmd = &cobra.Command{
	Use:   "types",
	Short: "List allowed MIME types for file uploads",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		result, err := client.Files.Types(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}
		if fileTypesJSON {
			fmt.Println(string(result.Data))
			return nil
		}
		var data struct {
			AllowedMimeTypes []string `json:"allowedMimeTypes"`
		}
		if err := result.Decode(&data); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}
		fmt.Printf("Allowed MIME types (%d):\n", len(data.AllowedMimeTypes))
		for _, t := range data.AllowedMimeTypes {
			fmt.Printf("  %s\n", t)
		}
		return nil
	},
}

func init() {
	fileUploadCmd.Flags().StringVar(&fileUploadMime, "mime", "", "Override MIME type")
	fileUploadCmd.Flags().BoolVar(&fileUploadJSON, "json", false, "Output raw JSON")

	fileSendCmd.Flags().StringVarP(&fileSendContent, "content", "c", "", "Optional text caption")
	fileSendCmd.Flags().StringVar(&fileSendMime, "mime", "", "Override MIME type")
	fileSendCmd.Flags().BoolVar(&fileSendJSON, "json", false, "Output raw JSON")

	fileQuotaCmd.Flags().BoolVar(&fileQuotaJSON, "json", false, "Output raw JSON")
	fileTypesCmd.Flags().BoolVar(&fileTypesJSON, "json", false, "Output raw JSON")

	fileCmd.AddCommand(fileUploadCmd)
	fileCmd.AddCommand(fileSendCmd)
	fileCmd.AddCommand(fileQuotaCmd)
	fileCmd.AddCommand(fileDeleteCmd)
	fileCmd.AddCommand(fileTypesCmd)
	rootCmd.AddCommand(fileCmd)
}

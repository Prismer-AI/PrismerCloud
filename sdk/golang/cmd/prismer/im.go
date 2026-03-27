package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	prismer "github.com/Prismer-AI/Prismer/sdk/golang"
	"github.com/spf13/cobra"
)

// ============================================================================
// Flag variables
// ============================================================================

var (
	imJSONOutput bool

	// im send
	imSendJSON bool

	// im messages
	imMessagesLimit int
	imMessagesJSON  bool

	// im discover
	imDiscoverType       string
	imDiscoverCapability string
	imDiscoverJSON       bool

	// im contacts
	imContactsJSON bool

	// im groups list
	imGroupsListJSON bool

	// im groups create
	imGroupsCreateMembers string
	imGroupsCreateJSON    bool

	// im groups send
	imGroupsSendJSON bool

	// im groups messages
	imGroupsMessagesLimit int
	imGroupsMessagesJSON  bool

	// im conversations list
	imConversationsUnread bool
	imConversationsJSON   bool

	// im credits
	imCreditsJSON bool

	// im transactions
	imTransactionsLimit int
	imTransactionsJSON  bool

	// im files upload
	imFilesUploadMime string
	imFilesUploadJSON bool

	// im files send
	imFilesSendContent string
	imFilesSendMime    string
	imFilesSendJSON    bool

	// im files quota
	imFilesQuotaJSON bool

	// im files types
	imFilesTypesJSON bool
)

// ============================================================================
// Root IM command
// ============================================================================

var imCmd = &cobra.Command{
	Use:   "im",
	Short: "IM messaging commands",
	Long:  "Interact with the Prismer IM messaging system: send messages, manage groups, view conversations, and more.",
}

// ============================================================================
// im me
// ============================================================================

var imMeCmd = &cobra.Command{
	Use:   "me",
	Short: "Show current IM account info",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := client.IM().Account.Me(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imJSONOutput {
			fmt.Println(string(result.Data))
			return nil
		}

		var me prismer.IMMeData
		if err := result.Decode(&me); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		fmt.Printf("Username:      %s\n", me.User.Username)
		fmt.Printf("Display Name:  %s\n", me.User.DisplayName)
		fmt.Printf("Role:          %s\n", me.User.Role)
		fmt.Printf("Conversations: %d\n", me.Stats.ConversationCount)
		fmt.Printf("Contacts:      %d\n", me.Stats.ContactCount)
		fmt.Printf("Messages Sent: %d\n", me.Stats.MessagesSent)
		fmt.Printf("Unread:        %d\n", me.Stats.UnreadCount)
		fmt.Printf("Credits:       %.2f\n", me.Credits.Balance)
		return nil
	},
}

// ============================================================================
// im health
// ============================================================================

var imHealthCmd = &cobra.Command{
	Use:   "health",
	Short: "Check IM service health",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := client.IM().Health(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			fmt.Println("IM service: UNHEALTHY")
			return imError(result)
		}

		fmt.Println("IM service: HEALTHY")
		return nil
	},
}

// ============================================================================
// im send
// ============================================================================

var imSendCmd = &cobra.Command{
	Use:   "send <user-id> <message>",
	Short: "Send a direct message to a user",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		userID, message := args[0], args[1]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		result, err := client.IM().Direct.Send(ctx, userID, message, nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imSendJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var data prismer.IMMessageData
		if err := result.Decode(&data); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		fmt.Printf("Message sent to conversation %s\n", data.ConversationID)
		fmt.Printf("  Message ID: %s\n", data.Message.ID)
		fmt.Printf("  Content:    %s\n", data.Message.Content)
		return nil
	},
}

// ============================================================================
// im messages
// ============================================================================

var imMessagesCmd = &cobra.Command{
	Use:   "messages <user-id>",
	Short: "Get direct messages with a user",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		userID := args[0]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		var opts *prismer.IMPaginationOptions
		if imMessagesLimit > 0 {
			opts = &prismer.IMPaginationOptions{Limit: imMessagesLimit}
		}

		result, err := client.IM().Direct.GetMessages(ctx, userID, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imMessagesJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var messages []prismer.IMMessage
		if err := result.Decode(&messages); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		if len(messages) == 0 {
			fmt.Println("No messages found.")
			return nil
		}

		for _, msg := range messages {
			fmt.Printf("[%s] %s: %s\n", msg.CreatedAt, msg.SenderID, msg.Content)
		}
		return nil
	},
}

// ============================================================================
// im discover
// ============================================================================

var imDiscoverCmd = &cobra.Command{
	Use:   "discover",
	Short: "Discover available agents",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		var opts *prismer.IMDiscoverOptions
		if imDiscoverType != "" || imDiscoverCapability != "" {
			opts = &prismer.IMDiscoverOptions{
				Type:       imDiscoverType,
				Capability: imDiscoverCapability,
			}
		}

		result, err := client.IM().Contacts.Discover(ctx, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imDiscoverJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var agents []prismer.IMDiscoverAgent
		if err := result.Decode(&agents); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		if len(agents) == 0 {
			fmt.Println("No agents found.")
			return nil
		}

		for _, a := range agents {
			caps := ""
			if len(a.Capabilities) > 0 {
				caps = " [" + strings.Join(a.Capabilities, ", ") + "]"
			}
			fmt.Printf("  %s (%s) - %s %s%s\n", a.Username, a.DisplayName, a.AgentType, a.Status, caps)
		}
		return nil
	},
}

// ============================================================================
// im contacts
// ============================================================================

var imContactsCmd = &cobra.Command{
	Use:   "contacts",
	Short: "List contacts",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		result, err := client.IM().Contacts.List(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imContactsJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var contacts []prismer.IMContact
		if err := result.Decode(&contacts); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		if len(contacts) == 0 {
			fmt.Println("No contacts found.")
			return nil
		}

		for _, c := range contacts {
			unread := ""
			if c.UnreadCount > 0 {
				unread = fmt.Sprintf(" (%d unread)", c.UnreadCount)
			}
			fmt.Printf("  %s (%s) - %s%s\n", c.Username, c.DisplayName, c.Role, unread)
		}
		return nil
	},
}

// ============================================================================
// im groups (parent command)
// ============================================================================

var imGroupsCmd = &cobra.Command{
	Use:   "groups",
	Short: "Manage groups",
	Long:  "Create, list, and interact with IM groups.",
}

// ============================================================================
// im groups list
// ============================================================================

var imGroupsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List groups",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		result, err := client.IM().Groups.List(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imGroupsListJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var groups []prismer.IMGroupData
		if err := result.Decode(&groups); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		if len(groups) == 0 {
			fmt.Println("No groups found.")
			return nil
		}

		for _, g := range groups {
			fmt.Printf("  %s: %s (%d members)\n", g.GroupID, g.Title, len(g.Members))
		}
		return nil
	},
}

// ============================================================================
// im groups create
// ============================================================================

var imGroupsCreateCmd = &cobra.Command{
	Use:   "create <title>",
	Short: "Create a new group",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		title := args[0]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		opts := &prismer.IMCreateGroupOptions{
			Title: title,
		}
		if imGroupsCreateMembers != "" {
			members := strings.Split(imGroupsCreateMembers, ",")
			trimmed := make([]string, 0, len(members))
			for _, m := range members {
				m = strings.TrimSpace(m)
				if m != "" {
					trimmed = append(trimmed, m)
				}
			}
			opts.Members = trimmed
		}

		result, err := client.IM().Groups.Create(ctx, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imGroupsCreateJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var group prismer.IMGroupData
		if err := result.Decode(&group); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		fmt.Printf("Group created: %s\n", group.GroupID)
		fmt.Printf("  Title:   %s\n", group.Title)
		fmt.Printf("  Members: %d\n", len(group.Members))
		return nil
	},
}

// ============================================================================
// im groups send
// ============================================================================

var imGroupsSendCmd = &cobra.Command{
	Use:   "send <group-id> <message>",
	Short: "Send a message to a group",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		groupID, message := args[0], args[1]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		result, err := client.IM().Groups.Send(ctx, groupID, message, nil)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imGroupsSendJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var data prismer.IMMessageData
		if err := result.Decode(&data); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		fmt.Printf("Message sent to group %s\n", groupID)
		fmt.Printf("  Message ID: %s\n", data.Message.ID)
		return nil
	},
}

// ============================================================================
// im groups messages
// ============================================================================

var imGroupsMessagesCmd = &cobra.Command{
	Use:   "messages <group-id>",
	Short: "Get messages from a group",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		groupID := args[0]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		var opts *prismer.IMPaginationOptions
		if imGroupsMessagesLimit > 0 {
			opts = &prismer.IMPaginationOptions{Limit: imGroupsMessagesLimit}
		}

		result, err := client.IM().Groups.GetMessages(ctx, groupID, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imGroupsMessagesJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var messages []prismer.IMMessage
		if err := result.Decode(&messages); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		if len(messages) == 0 {
			fmt.Println("No messages found.")
			return nil
		}

		for _, msg := range messages {
			fmt.Printf("[%s] %s: %s\n", msg.CreatedAt, msg.SenderID, msg.Content)
		}
		return nil
	},
}

// ============================================================================
// im conversations (parent command)
// ============================================================================

var imConversationsCmd = &cobra.Command{
	Use:   "conversations",
	Short: "Manage conversations",
	Long:  "List and manage IM conversations.",
}

// ============================================================================
// im conversations list
// ============================================================================

var imConversationsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List conversations",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		result, err := client.IM().Conversations.List(ctx, imConversationsUnread, imConversationsUnread)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imConversationsJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var conversations []prismer.IMConversation
		if err := result.Decode(&conversations); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		if len(conversations) == 0 {
			fmt.Println("No conversations found.")
			return nil
		}

		for _, c := range conversations {
			unread := ""
			if c.UnreadCount > 0 {
				unread = fmt.Sprintf(" (%d unread)", c.UnreadCount)
			}
			title := c.Title
			if title == "" {
				title = c.Type
			}
			fmt.Printf("  %s: %s%s\n", c.ID, title, unread)
		}
		return nil
	},
}

// ============================================================================
// im conversations read
// ============================================================================

var imConversationsReadCmd = &cobra.Command{
	Use:   "read <conversation-id>",
	Short: "Mark a conversation as read",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		conversationID := args[0]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := client.IM().Conversations.MarkAsRead(ctx, conversationID)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		fmt.Printf("Conversation %s marked as read.\n", conversationID)
		return nil
	},
}

// ============================================================================
// im credits
// ============================================================================

var imCreditsCmd = &cobra.Command{
	Use:   "credits",
	Short: "Show credit balance",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := client.IM().Credits.Get(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imCreditsJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var credits prismer.IMCreditsData
		if err := result.Decode(&credits); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		fmt.Printf("Balance:      %.2f\n", credits.Balance)
		fmt.Printf("Total Earned: %.2f\n", credits.TotalEarned)
		fmt.Printf("Total Spent:  %.2f\n", credits.TotalSpent)
		return nil
	},
}

// ============================================================================
// im transactions
// ============================================================================

var imTransactionsCmd = &cobra.Command{
	Use:   "transactions",
	Short: "List credit transactions",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		var opts *prismer.IMPaginationOptions
		if imTransactionsLimit > 0 {
			opts = &prismer.IMPaginationOptions{Limit: imTransactionsLimit}
		}

		result, err := client.IM().Credits.Transactions(ctx, opts)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imTransactionsJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var transactions []prismer.IMTransaction
		if err := result.Decode(&transactions); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		if len(transactions) == 0 {
			fmt.Println("No transactions found.")
			return nil
		}

		for _, t := range transactions {
			fmt.Printf("  [%s] %s %+.2f  %s (balance: %.2f)\n",
				t.CreatedAt, t.Type, t.Amount, t.Description, t.BalanceAfter)
		}
		return nil
	},
}

// ============================================================================
// im files (parent command)
// ============================================================================

var imFilesCmd = &cobra.Command{
	Use:   "files",
	Short: "File upload management",
	Long:  "Upload, send, and manage files in IM conversations.",
}

// ============================================================================
// im files upload
// ============================================================================

var imFilesUploadCmd = &cobra.Command{
	Use:   "upload <path>",
	Short: "Upload a file",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		filePath := args[0]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		var opts *prismer.UploadOptions
		if imFilesUploadMime != "" {
			opts = &prismer.UploadOptions{MimeType: imFilesUploadMime}
		}

		result, err := client.IM().Files.UploadFile(ctx, filePath, opts)
		if err != nil {
			return fmt.Errorf("upload failed: %w", err)
		}

		if imFilesUploadJSON {
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

// ============================================================================
// im files send
// ============================================================================

var imFilesSendCmd = &cobra.Command{
	Use:   "send <conversation-id> <path>",
	Short: "Upload file and send as message",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		conversationID, filePath := args[0], args[1]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		data, err := os.ReadFile(filePath)
		if err != nil {
			return fmt.Errorf("failed to read file: %w", err)
		}

		opts := &prismer.SendFileOptions{
			FileName: filepath.Base(filePath),
			Content:  imFilesSendContent,
		}
		if imFilesSendMime != "" {
			opts.MimeType = imFilesSendMime
		}

		result, err := client.IM().Files.SendFile(ctx, conversationID, data, opts)
		if err != nil {
			return fmt.Errorf("send file failed: %w", err)
		}

		if imFilesSendJSON {
			b, _ := json.MarshalIndent(result, "", "  ")
			fmt.Println(string(b))
			return nil
		}

		fmt.Printf("Upload ID: %s\n", result.Upload.UploadID)
		fmt.Printf("CDN URL:   %s\n", result.Upload.CdnURL)
		fmt.Printf("File:      %s\n", result.Upload.FileName)
		fmt.Println("Message:   sent")
		return nil
	},
}

// ============================================================================
// im files quota
// ============================================================================

var imFilesQuotaCmd = &cobra.Command{
	Use:   "quota",
	Short: "Show storage quota",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := client.IM().Files.Quota(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imFilesQuotaJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		var quota prismer.IMFileQuota
		if err := result.Decode(&quota); err != nil {
			return fmt.Errorf("failed to decode response: %w", err)
		}

		fmt.Printf("Used:       %d bytes\n", quota.Used)
		fmt.Printf("Limit:      %d bytes\n", quota.Limit)
		fmt.Printf("File Count: %d\n", quota.FileCount)
		fmt.Printf("Tier:       %s\n", quota.Tier)
		return nil
	},
}

// ============================================================================
// im files delete
// ============================================================================

var imFilesDeleteCmd = &cobra.Command{
	Use:   "delete <upload-id>",
	Short: "Delete an uploaded file",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		uploadID := args[0]
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := client.IM().Files.Delete(ctx, uploadID)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		fmt.Printf("Deleted upload %s.\n", uploadID)
		return nil
	},
}

// ============================================================================
// im files types
// ============================================================================

var imFilesTypesCmd = &cobra.Command{
	Use:   "types",
	Short: "List allowed MIME types",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		result, err := client.IM().Files.Types(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if imFilesTypesJSON {
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

// ============================================================================
// Helper
// ============================================================================

// imError formats an IM API error for display.
func imError(result *prismer.IMResult) error {
	if result.Error != nil {
		return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
	}
	return fmt.Errorf("API returned an error (no details)")
}

// ============================================================================
// Registration
// ============================================================================

func init() {
	// im me
	imMeCmd.Flags().BoolVar(&imJSONOutput, "json", false, "Output raw JSON")

	// im send
	imSendCmd.Flags().BoolVar(&imSendJSON, "json", false, "Output raw JSON")

	// im messages
	imMessagesCmd.Flags().IntVarP(&imMessagesLimit, "limit", "n", 0, "Maximum number of messages to return")
	imMessagesCmd.Flags().BoolVar(&imMessagesJSON, "json", false, "Output raw JSON")

	// im discover
	imDiscoverCmd.Flags().StringVar(&imDiscoverType, "type", "", "Filter by agent type")
	imDiscoverCmd.Flags().StringVar(&imDiscoverCapability, "capability", "", "Filter by capability")
	imDiscoverCmd.Flags().BoolVar(&imDiscoverJSON, "json", false, "Output raw JSON")

	// im contacts
	imContactsCmd.Flags().BoolVar(&imContactsJSON, "json", false, "Output raw JSON")

	// im groups list
	imGroupsListCmd.Flags().BoolVar(&imGroupsListJSON, "json", false, "Output raw JSON")

	// im groups create
	imGroupsCreateCmd.Flags().StringVar(&imGroupsCreateMembers, "members", "", "Comma-separated list of member user IDs")
	imGroupsCreateCmd.Flags().BoolVar(&imGroupsCreateJSON, "json", false, "Output raw JSON")

	// im groups send
	imGroupsSendCmd.Flags().BoolVar(&imGroupsSendJSON, "json", false, "Output raw JSON")

	// im groups messages
	imGroupsMessagesCmd.Flags().IntVarP(&imGroupsMessagesLimit, "limit", "n", 0, "Maximum number of messages to return")
	imGroupsMessagesCmd.Flags().BoolVar(&imGroupsMessagesJSON, "json", false, "Output raw JSON")

	// im conversations list
	imConversationsListCmd.Flags().BoolVar(&imConversationsUnread, "unread", false, "Show only unread conversations")
	imConversationsListCmd.Flags().BoolVar(&imConversationsJSON, "json", false, "Output raw JSON")

	// im credits
	imCreditsCmd.Flags().BoolVar(&imCreditsJSON, "json", false, "Output raw JSON")

	// im transactions
	imTransactionsCmd.Flags().IntVarP(&imTransactionsLimit, "limit", "n", 0, "Maximum number of transactions to return")
	imTransactionsCmd.Flags().BoolVar(&imTransactionsJSON, "json", false, "Output raw JSON")

	// im files upload
	imFilesUploadCmd.Flags().StringVar(&imFilesUploadMime, "mime", "", "Override MIME type")
	imFilesUploadCmd.Flags().BoolVar(&imFilesUploadJSON, "json", false, "Output raw JSON")

	// im files send
	imFilesSendCmd.Flags().StringVar(&imFilesSendContent, "content", "", "Message text")
	imFilesSendCmd.Flags().StringVar(&imFilesSendMime, "mime", "", "Override MIME type")
	imFilesSendCmd.Flags().BoolVar(&imFilesSendJSON, "json", false, "Output raw JSON")

	// im files quota
	imFilesQuotaCmd.Flags().BoolVar(&imFilesQuotaJSON, "json", false, "Output raw JSON")

	// im files types
	imFilesTypesCmd.Flags().BoolVar(&imFilesTypesJSON, "json", false, "Output raw JSON")

	// Wire up files sub-commands.
	imFilesCmd.AddCommand(imFilesUploadCmd)
	imFilesCmd.AddCommand(imFilesSendCmd)
	imFilesCmd.AddCommand(imFilesQuotaCmd)
	imFilesCmd.AddCommand(imFilesDeleteCmd)
	imFilesCmd.AddCommand(imFilesTypesCmd)

	// Wire up groups sub-commands.
	imGroupsCmd.AddCommand(imGroupsListCmd)
	imGroupsCmd.AddCommand(imGroupsCreateCmd)
	imGroupsCmd.AddCommand(imGroupsSendCmd)
	imGroupsCmd.AddCommand(imGroupsMessagesCmd)

	// Wire up conversations sub-commands.
	imConversationsCmd.AddCommand(imConversationsListCmd)
	imConversationsCmd.AddCommand(imConversationsReadCmd)

	// Wire up top-level im sub-commands.
	imCmd.AddCommand(imMeCmd)
	imCmd.AddCommand(imHealthCmd)
	imCmd.AddCommand(imSendCmd)
	imCmd.AddCommand(imMessagesCmd)
	imCmd.AddCommand(imDiscoverCmd)
	imCmd.AddCommand(imContactsCmd)
	imCmd.AddCommand(imGroupsCmd)
	imCmd.AddCommand(imConversationsCmd)
	imCmd.AddCommand(imFilesCmd)
	imCmd.AddCommand(imCreditsCmd)
	imCmd.AddCommand(imTransactionsCmd)

	// Register im under root.
	rootCmd.AddCommand(imCmd)
}

// Ensure json import is used (for json.RawMessage in IMResult).
var _ = json.RawMessage{}

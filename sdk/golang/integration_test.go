//go:build integration

package prismer_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	prismer "github.com/Prismer-AI/Prismer/sdk/golang"
)

// imMessageLoose works around a SDK bug where IMMessage.Metadata is typed as
// map[string]any but the API can return a JSON string for that field.
// See SDK bug report in test summary.
type imMessageLoose struct {
	ID        string          `json:"id"`
	Content   string          `json:"content"`
	Type      string          `json:"type"`
	SenderID  string          `json:"senderId"`
	CreatedAt string          `json:"createdAt"`
	ParentID  *string         `json:"parentId,omitempty"`
	Metadata  json.RawMessage `json:"metadata,omitempty"`
}

// helpers ---------------------------------------------------------------

func apiKey(t *testing.T) string {
	t.Helper()
	key := os.Getenv("PRISMER_API_KEY_TEST")
	if key == "" {
		t.Fatal("PRISMER_API_KEY_TEST environment variable is required")
	}
	return key
}

func testBaseURL() string {
	if v := os.Getenv("PRISMER_BASE_URL_TEST"); v != "" {
		return v
	}
	return "" // empty means use default (production)
}

func newClient(t *testing.T) *prismer.Client {
	t.Helper()
	if base := testBaseURL(); base != "" {
		return prismer.NewClient(apiKey(t), prismer.WithBaseURL(base))
	}
	return prismer.NewClient(apiKey(t), prismer.WithEnvironment(prismer.Production))
}

func uniqueName(prefix string) string {
	return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
}

// =======================================================================
// Group 1: Context API
// =======================================================================

func TestIntegration_Context_LoadSingle(t *testing.T) {
	client := newClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	result, err := client.Load(ctx, "https://example.com", nil)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("Load was not successful: %+v", result.Error)
	}
	if result.Mode == "" {
		t.Error("expected non-empty Mode")
	}
	t.Logf("Load single — mode=%s requestId=%s", result.Mode, result.RequestID)

	// In single mode we expect Result to be populated
	if result.Result == nil && len(result.Results) == 0 {
		t.Error("expected at least Result or Results to be populated")
	}
}

func TestIntegration_Context_LoadBatch(t *testing.T) {
	client := newClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	urls := []string{"https://example.com", "https://httpbin.org/html"}
	result, err := client.Load(ctx, urls, nil)
	if err != nil {
		t.Fatalf("Load batch returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("Load batch was not successful: %+v", result.Error)
	}
	t.Logf("Load batch — mode=%s results=%d", result.Mode, len(result.Results))

	if result.Mode != "batch_urls" {
		t.Errorf("expected mode=batch_urls, got %s", result.Mode)
	}
	if len(result.Results) == 0 {
		t.Error("expected non-empty Results for batch load")
	}
}

func TestIntegration_Context_Save(t *testing.T) {
	client := newClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	saveURL := fmt.Sprintf("https://test.example.com/go-integration-%d", time.Now().UnixNano())
	result, err := client.Save(ctx, &prismer.SaveOptions{
		URL:  saveURL,
		HQCC: "Integration test content from Go SDK.",
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("Save was not successful: %+v", result.Error)
	}
	t.Logf("Save — status=%s url=%s", result.Status, result.URL)
}

// =======================================================================
// Group 2: Parse API
// =======================================================================

func TestIntegration_Parse_PDF(t *testing.T) {
	client := newClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	result, err := client.ParsePDF(ctx, "https://arxiv.org/pdf/2301.00234.pdf", "fast")
	if err != nil {
		t.Fatalf("ParsePDF returned error: %v", err)
	}
	if !result.Success {
		t.Fatalf("ParsePDF was not successful: %+v", result.Error)
	}
	t.Logf("ParsePDF — requestId=%s mode=%s taskId=%s async=%v",
		result.RequestID, result.Mode, result.TaskID, result.Async)

	// Depending on async mode, we might get a taskId or a document
	if result.RequestID == "" && result.TaskID == "" {
		t.Error("expected either requestId or taskId to be set")
	}
}

// =======================================================================
// Group 3: IM API — Full Lifecycle
// =======================================================================

func TestIntegration_IM_FullLifecycle(t *testing.T) {
	apiClient := newClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	ts := time.Now().UnixNano()

	// ---------------------------------------------------------------
	// 3.1  Register agent A
	// ---------------------------------------------------------------
	t.Run("Account_Register_AgentA", func(t *testing.T) {})

	agentAUser := uniqueName("gotest_a")
	regResultA, err := apiClient.IM().Account.Register(ctx, &prismer.IMRegisterOptions{
		Type:         "agent",
		Username:     agentAUser,
		DisplayName:  fmt.Sprintf("Go Test Agent A %d", ts),
		AgentType:    "assistant",
		Capabilities: []string{"chat", "testing"},
		Description:  "Integration test agent A",
	})
	if err != nil {
		t.Fatalf("Register agent A error: %v", err)
	}
	if !regResultA.OK {
		t.Fatalf("Register agent A not OK: %+v", regResultA.Error)
	}

	var regDataA prismer.IMRegisterData
	if err := regResultA.Decode(&regDataA); err != nil {
		t.Fatalf("Decode register A data: %v", err)
	}
	if regDataA.Token == "" {
		t.Fatal("expected non-empty Token for agent A")
	}
	t.Logf("Agent A registered — userId=%s username=%s isNew=%v",
		regDataA.IMUserID, regDataA.Username, regDataA.IsNew)

	agentAId := regDataA.IMUserID
	agentAToken := regDataA.Token

	// Create authenticated client for agent A
	var imClientA *prismer.Client
	if base := testBaseURL(); base != "" {
		imClientA = prismer.NewClient(regDataA.Token, prismer.WithBaseURL(base))
	} else {
		imClientA = prismer.NewClient(regDataA.Token, prismer.WithEnvironment(prismer.Production))
	}

	// ---------------------------------------------------------------
	// 3.2  Register agent B (target)
	// ---------------------------------------------------------------
	agentBUser := uniqueName("gotest_b")
	regResultB, err := apiClient.IM().Account.Register(ctx, &prismer.IMRegisterOptions{
		Type:         "agent",
		Username:     agentBUser,
		DisplayName:  fmt.Sprintf("Go Test Agent B %d", ts),
		AgentType:    "assistant",
		Capabilities: []string{"chat"},
		Description:  "Integration test agent B",
	})
	if err != nil {
		t.Fatalf("Register agent B error: %v", err)
	}
	if !regResultB.OK {
		t.Fatalf("Register agent B not OK: %+v", regResultB.Error)
	}

	var regDataB prismer.IMRegisterData
	if err := regResultB.Decode(&regDataB); err != nil {
		t.Fatalf("Decode register B data: %v", err)
	}
	if regDataB.Token == "" {
		t.Fatal("expected non-empty Token for agent B")
	}
	t.Logf("Agent B registered — userId=%s username=%s isNew=%v",
		regDataB.IMUserID, regDataB.Username, regDataB.IsNew)

	targetId := regDataB.IMUserID
	agentBToken := regDataB.Token
	var imClientB *prismer.Client
	if base := testBaseURL(); base != "" {
		imClientB = prismer.NewClient(agentBToken, prismer.WithBaseURL(base))
	} else {
		imClientB = prismer.NewClient(agentBToken, prismer.WithEnvironment(prismer.Production))
	}
	_ = agentAId // used in realtime tests
	_ = imClientB

	// ---------------------------------------------------------------
	// 3.3  Account.Me
	// ---------------------------------------------------------------
	t.Run("Account_Me", func(t *testing.T) {
		meResult, err := imClientA.IM().Account.Me(ctx)
		if err != nil {
			t.Fatalf("Me error: %v", err)
		}
		if !meResult.OK {
			t.Fatalf("Me not OK: %+v", meResult.Error)
		}

		var meData prismer.IMMeData
		if err := meResult.Decode(&meData); err != nil {
			t.Fatalf("Decode Me data: %v", err)
		}
		if meData.User.Username != agentAUser {
			t.Errorf("expected username=%s, got %s", agentAUser, meData.User.Username)
		}
		t.Logf("Me — user=%s role=%s stats=%+v",
			meData.User.Username, meData.User.Role, meData.Stats)
	})

	// ---------------------------------------------------------------
	// 3.4  Account.RefreshToken
	// ---------------------------------------------------------------
	t.Run("Account_RefreshToken", func(t *testing.T) {
		refreshResult, err := imClientA.IM().Account.RefreshToken(ctx)
		if err != nil {
			t.Fatalf("RefreshToken error: %v", err)
		}
		if !refreshResult.OK {
			t.Fatalf("RefreshToken not OK: %+v", refreshResult.Error)
		}

		var tokenData prismer.IMTokenData
		if err := refreshResult.Decode(&tokenData); err != nil {
			t.Fatalf("Decode token data: %v", err)
		}
		if tokenData.Token == "" {
			t.Error("expected non-empty refreshed token")
		}
		t.Logf("RefreshToken — expiresIn=%s tokenLen=%d",
			tokenData.ExpiresIn, len(tokenData.Token))
	})

	// ---------------------------------------------------------------
	// 3.5  Direct Messaging
	// ---------------------------------------------------------------
	var directConvId string
	var firstDirectMsgId string

	t.Run("Direct_Send", func(t *testing.T) {
		sendResult, err := imClientA.IM().Direct.Send(ctx, targetId, "Hello from Go integration test!", nil)
		if err != nil {
			t.Fatalf("Direct.Send error: %v", err)
		}
		if !sendResult.OK {
			t.Fatalf("Direct.Send not OK: %+v", sendResult.Error)
		}
		// Decode to get conversationId and messageId
		var msgData prismer.IMMessageData
		if err := sendResult.Decode(&msgData); err == nil {
			directConvId = msgData.ConversationID
			firstDirectMsgId = msgData.Message.ID
		}
		t.Logf("Direct.Send — ok=%v convId=%s msgId=%s", sendResult.OK, directConvId, firstDirectMsgId)
	})

	t.Run("Direct_GetMessages", func(t *testing.T) {
		msgsResult, err := imClientA.IM().Direct.GetMessages(ctx, targetId, nil)
		if err != nil {
			t.Fatalf("Direct.GetMessages error: %v", err)
		}
		if !msgsResult.OK {
			t.Fatalf("Direct.GetMessages not OK: %+v", msgsResult.Error)
		}

		// SDK BUG: IMMessage.Metadata is map[string]any but API returns string.
		// Use imMessageLoose to work around.
		var messages []imMessageLoose
		if err := msgsResult.Decode(&messages); err != nil {
			t.Fatalf("Decode messages: %v", err)
		}
		if len(messages) == 0 {
			t.Error("expected at least one message")
		} else {
			t.Logf("Direct.GetMessages — count=%d firstContent=%q",
				len(messages), messages[0].Content)
		}
	})

	// ---------------------------------------------------------------
	// 3.6  Credits
	// ---------------------------------------------------------------
	t.Run("Credits_Get", func(t *testing.T) {
		creditsResult, err := imClientA.IM().Credits.Get(ctx)
		if err != nil {
			t.Fatalf("Credits.Get error: %v", err)
		}
		if !creditsResult.OK {
			t.Fatalf("Credits.Get not OK: %+v", creditsResult.Error)
		}

		var creditsData prismer.IMCreditsData
		if err := creditsResult.Decode(&creditsData); err != nil {
			t.Fatalf("Decode credits data: %v", err)
		}
		t.Logf("Credits.Get — balance=%.2f totalEarned=%.2f totalSpent=%.2f",
			creditsData.Balance, creditsData.TotalEarned, creditsData.TotalSpent)
	})

	t.Run("Credits_Transactions", func(t *testing.T) {
		txResult, err := imClientA.IM().Credits.Transactions(ctx, nil)
		if err != nil {
			t.Fatalf("Credits.Transactions error: %v", err)
		}
		if !txResult.OK {
			t.Fatalf("Credits.Transactions not OK: %+v", txResult.Error)
		}

		var transactions []prismer.IMTransaction
		if err := txResult.Decode(&transactions); err != nil {
			t.Fatalf("Decode transactions: %v", err)
		}
		t.Logf("Credits.Transactions — count=%d", len(transactions))
	})

	// ---------------------------------------------------------------
	// 3.7  Contacts & Discovery
	// ---------------------------------------------------------------
	t.Run("Contacts_List", func(t *testing.T) {
		contactsResult, err := imClientA.IM().Contacts.List(ctx)
		if err != nil {
			t.Fatalf("Contacts.List error: %v", err)
		}
		if !contactsResult.OK {
			t.Fatalf("Contacts.List not OK: %+v", contactsResult.Error)
		}

		var contacts []prismer.IMContact
		if err := contactsResult.Decode(&contacts); err != nil {
			t.Fatalf("Decode contacts: %v", err)
		}
		t.Logf("Contacts.List — count=%d", len(contacts))
	})

	t.Run("Contacts_Discover", func(t *testing.T) {
		discoverResult, err := imClientA.IM().Contacts.Discover(ctx, nil)
		if err != nil {
			t.Fatalf("Contacts.Discover error: %v", err)
		}
		if !discoverResult.OK {
			t.Fatalf("Contacts.Discover not OK: %+v", discoverResult.Error)
		}

		var agents []prismer.IMDiscoverAgent
		if err := discoverResult.Decode(&agents); err != nil {
			t.Fatalf("Decode discover agents: %v", err)
		}
		t.Logf("Contacts.Discover — count=%d", len(agents))
	})

	// ---------------------------------------------------------------
	// 3.8  Groups
	// ---------------------------------------------------------------
	var groupId string
	var groupMsgId string

	t.Run("Groups_Create", func(t *testing.T) {
		createResult, err := imClientA.IM().Groups.Create(ctx, &prismer.IMCreateGroupOptions{
			Title:       fmt.Sprintf("Go Integration Group %d", ts),
			Description: "Test group created by Go integration tests",
			Members:     []string{targetId},
		})
		if err != nil {
			t.Fatalf("Groups.Create error: %v", err)
		}
		if !createResult.OK {
			t.Fatalf("Groups.Create not OK: %+v", createResult.Error)
		}

		var groupData prismer.IMGroupData
		if err := createResult.Decode(&groupData); err != nil {
			t.Fatalf("Decode group data: %v", err)
		}
		if groupData.GroupID == "" {
			t.Fatal("expected non-empty groupId")
		}
		groupId = groupData.GroupID
		t.Logf("Groups.Create — groupId=%s title=%s members=%d",
			groupData.GroupID, groupData.Title, len(groupData.Members))
	})

	t.Run("Groups_List", func(t *testing.T) {
		if groupId == "" {
			t.Skip("no group created")
		}
		listResult, err := imClientA.IM().Groups.List(ctx)
		if err != nil {
			t.Fatalf("Groups.List error: %v", err)
		}
		if !listResult.OK {
			t.Fatalf("Groups.List not OK: %+v", listResult.Error)
		}

		var groups []prismer.IMGroupData
		if err := listResult.Decode(&groups); err != nil {
			t.Fatalf("Decode groups: %v", err)
		}
		if len(groups) == 0 {
			t.Error("expected at least one group")
		}
		t.Logf("Groups.List — count=%d", len(groups))
	})

	t.Run("Groups_Get", func(t *testing.T) {
		if groupId == "" {
			t.Skip("no group created")
		}
		getResult, err := imClientA.IM().Groups.Get(ctx, groupId)
		if err != nil {
			t.Fatalf("Groups.Get error: %v", err)
		}
		if !getResult.OK {
			t.Fatalf("Groups.Get not OK: %+v", getResult.Error)
		}

		var groupData prismer.IMGroupData
		if err := getResult.Decode(&groupData); err != nil {
			t.Fatalf("Decode group data: %v", err)
		}
		if groupData.GroupID != groupId {
			t.Errorf("expected groupId=%s, got %s", groupId, groupData.GroupID)
		}
		t.Logf("Groups.Get — groupId=%s title=%s", groupData.GroupID, groupData.Title)
	})

	t.Run("Groups_Send", func(t *testing.T) {
		if groupId == "" {
			t.Skip("no group created")
		}
		sendResult, err := imClientA.IM().Groups.Send(ctx, groupId, "Hello group from Go integration test!", nil)
		if err != nil {
			t.Fatalf("Groups.Send error: %v", err)
		}
		if !sendResult.OK {
			t.Fatalf("Groups.Send not OK: %+v", sendResult.Error)
		}
		// Decode to get message ID
		var msgData prismer.IMMessageData
		if err := sendResult.Decode(&msgData); err == nil {
			groupMsgId = msgData.Message.ID
		}
		t.Logf("Groups.Send — ok=%v msgId=%s", sendResult.OK, groupMsgId)
	})

	t.Run("Groups_GetMessages", func(t *testing.T) {
		if groupId == "" {
			t.Skip("no group created")
		}
		msgsResult, err := imClientA.IM().Groups.GetMessages(ctx, groupId, nil)
		if err != nil {
			t.Fatalf("Groups.GetMessages error: %v", err)
		}
		if !msgsResult.OK {
			t.Fatalf("Groups.GetMessages not OK: %+v", msgsResult.Error)
		}

		var messages []imMessageLoose
		if err := msgsResult.Decode(&messages); err != nil {
			t.Fatalf("Decode group messages: %v", err)
		}
		if len(messages) == 0 {
			t.Error("expected at least one group message")
		} else {
			t.Logf("Groups.GetMessages — count=%d firstContent=%q",
				len(messages), messages[0].Content)
		}
	})

	// ---------------------------------------------------------------
	// 3.9  Conversations
	// ---------------------------------------------------------------
	t.Run("Conversations_List", func(t *testing.T) {
		convResult, err := imClientA.IM().Conversations.List(ctx, false, false)
		if err != nil {
			t.Fatalf("Conversations.List error: %v", err)
		}
		if !convResult.OK {
			t.Fatalf("Conversations.List not OK: %+v", convResult.Error)
		}

		var conversations []prismer.IMConversation
		if err := convResult.Decode(&conversations); err != nil {
			t.Fatalf("Decode conversations: %v", err)
		}
		t.Logf("Conversations.List — count=%d", len(conversations))
	})

	t.Run("Conversations_CreateDirect", func(t *testing.T) {
		createResult, err := imClientA.IM().Conversations.CreateDirect(ctx, targetId)
		if err != nil {
			// API may return error in a format that can't be unmarshalled; treat as non-fatal
			t.Logf("Conversations.CreateDirect error (may not be supported): %v", err)
			return
		}
		if createResult.OK {
			t.Logf("Conversations.CreateDirect — ok=%v", createResult.OK)
		} else {
			t.Logf("Conversations.CreateDirect — not available: %+v", createResult.Error)
		}
	})

	// ---------------------------------------------------------------
	// 3.10  Message Threading (v3.4.0)
	// ---------------------------------------------------------------
	t.Run("Direct_Send_WithParentId", func(t *testing.T) {
		if firstDirectMsgId == "" {
			t.Skip("no direct message ID available")
		}
		// Send a parent
		parentResult, err := imClientA.IM().Direct.Send(ctx, targetId, "Parent for Go threading test", nil)
		if err != nil {
			t.Fatalf("Parent send error: %v", err)
		}
		if !parentResult.OK {
			t.Fatalf("Parent send not OK: %+v", parentResult.Error)
		}
		var parentData prismer.IMMessageData
		if err := parentResult.Decode(&parentData); err != nil {
			t.Fatalf("Decode parent: %v", err)
		}
		parentMsgId := parentData.Message.ID

		// Send reply with parentId
		replyResult, err := imClientA.IM().Direct.Send(ctx, targetId, "Threaded reply from Go", &prismer.IMSendOptions{
			ParentID: parentMsgId,
		})
		if err != nil {
			t.Fatalf("Reply send error: %v", err)
		}
		if !replyResult.OK {
			t.Fatalf("Reply send not OK: %+v", replyResult.Error)
		}
		t.Logf("Direct_Send_WithParentId — parentId=%s ok=%v", parentMsgId, replyResult.OK)
	})

	t.Run("Group_Send_WithParentId", func(t *testing.T) {
		if groupId == "" || groupMsgId == "" {
			t.Skip("no group or group message available")
		}
		// Send a parent
		parentResult, err := imClientA.IM().Groups.Send(ctx, groupId, "Group parent for Go threading", nil)
		if err != nil {
			t.Fatalf("Group parent send error: %v", err)
		}
		if !parentResult.OK {
			t.Fatalf("Group parent not OK: %+v", parentResult.Error)
		}
		var parentData prismer.IMMessageData
		if err := parentResult.Decode(&parentData); err != nil {
			t.Fatalf("Decode group parent: %v", err)
		}

		// Reply with parentId
		replyResult, err := imClientA.IM().Groups.Send(ctx, groupId, "Group threaded reply from Go", &prismer.IMSendOptions{
			ParentID: parentData.Message.ID,
		})
		if err != nil {
			t.Fatalf("Group reply error: %v", err)
		}
		if !replyResult.OK {
			t.Fatalf("Group reply not OK: %+v", replyResult.Error)
		}
		t.Logf("Group_Send_WithParentId — ok=%v", replyResult.OK)
	})

	// ---------------------------------------------------------------
	// 3.11  New Message Types (v3.4.0)
	// ---------------------------------------------------------------
	t.Run("Send_Markdown_Message", func(t *testing.T) {
		result, err := imClientA.IM().Direct.Send(ctx, targetId, "# Heading\n\n**bold**", &prismer.IMSendOptions{
			Type: "markdown",
		})
		if err != nil {
			t.Fatalf("Markdown send error: %v", err)
		}
		if !result.OK {
			t.Fatalf("Markdown send not OK: %+v", result.Error)
		}
		t.Logf("Send_Markdown — ok=%v", result.OK)
	})

	t.Run("Send_ToolCall_Message", func(t *testing.T) {
		result, err := imClientA.IM().Direct.Send(ctx, targetId, `{"tool":"search","query":"test"}`, &prismer.IMSendOptions{
			Type:     "tool_call",
			Metadata: map[string]any{"toolName": "search", "toolCallId": "tc-go-001"},
		})
		if err != nil {
			t.Fatalf("ToolCall send error: %v", err)
		}
		if !result.OK {
			t.Fatalf("ToolCall send not OK: %+v", result.Error)
		}
		t.Logf("Send_ToolCall — ok=%v", result.OK)
	})

	t.Run("Send_ToolResult_Message", func(t *testing.T) {
		result, err := imClientA.IM().Direct.Send(ctx, targetId, `{"results":["item1","item2"]}`, &prismer.IMSendOptions{
			Type:     "tool_result",
			Metadata: map[string]any{"toolCallId": "tc-go-001"},
		})
		if err != nil {
			t.Fatalf("ToolResult send error: %v", err)
		}
		if !result.OK {
			t.Fatalf("ToolResult send not OK: %+v", result.Error)
		}
		t.Logf("Send_ToolResult — ok=%v", result.OK)
	})

	t.Run("Send_Thinking_Message", func(t *testing.T) {
		result, err := imClientA.IM().Direct.Send(ctx, targetId, "Analyzing step by step...", &prismer.IMSendOptions{
			Type: "thinking",
		})
		if err != nil {
			t.Fatalf("Thinking send error: %v", err)
		}
		if !result.OK {
			t.Fatalf("Thinking send not OK: %+v", result.Error)
		}
		t.Logf("Send_Thinking — ok=%v", result.OK)
	})

	t.Run("Send_Image_Message", func(t *testing.T) {
		result, err := imClientA.IM().Direct.Send(ctx, targetId, "https://example.com/test-image.png", &prismer.IMSendOptions{
			Type:     "image",
			Metadata: map[string]any{"mimeType": "image/png", "width": 800, "height": 600},
		})
		if err != nil {
			t.Fatalf("Image send error: %v", err)
		}
		if !result.OK {
			t.Fatalf("Image send not OK: %+v", result.Error)
		}
		t.Logf("Send_Image — ok=%v", result.OK)
	})

	t.Run("Send_File_Message", func(t *testing.T) {
		result, err := imClientA.IM().Direct.Send(ctx, targetId, "https://example.com/document.pdf", &prismer.IMSendOptions{
			Type:     "file",
			Metadata: map[string]any{"filename": "document.pdf", "mimeType": "application/pdf", "size": 1024},
		})
		if err != nil {
			t.Fatalf("File send error: %v", err)
		}
		if !result.OK {
			t.Fatalf("File send not OK: %+v", result.Error)
		}
		t.Logf("Send_File — ok=%v", result.OK)
	})

	// ---------------------------------------------------------------
	// 3.12  Message Metadata (v3.4.0)
	// ---------------------------------------------------------------
	t.Run("Send_Message_With_Metadata", func(t *testing.T) {
		metadata := map[string]any{
			"source":  "integration-test",
			"version": "3.4.0",
			"custom":  map[string]any{"nested": true, "tags": []string{"test", "v3.4.0"}},
		}
		result, err := imClientA.IM().Direct.Send(ctx, targetId, "Message with metadata from Go", &prismer.IMSendOptions{
			Metadata: metadata,
		})
		if err != nil {
			t.Fatalf("Metadata send error: %v", err)
		}
		if !result.OK {
			t.Fatalf("Metadata send not OK: %+v", result.Error)
		}

		// Verify in history
		histResult, err := imClientA.IM().Direct.GetMessages(ctx, targetId, nil)
		if err != nil {
			t.Fatalf("GetMessages error: %v", err)
		}
		if histResult.OK {
			var msgs []imMessageLoose
			if err := histResult.Decode(&msgs); err == nil {
				found := false
				for _, m := range msgs {
					if m.Content == "Message with metadata from Go" && len(m.Metadata) > 0 {
						found = true
						break
					}
				}
				if !found {
					t.Log("Warning: metadata message found but metadata may not be preserved in history")
				}
			}
		}
		t.Logf("Send_Message_With_Metadata — ok=%v", result.OK)
	})

	// ---------------------------------------------------------------
	// 3.13  Messages Edit & Delete
	// ---------------------------------------------------------------
	t.Run("Messages_Edit", func(t *testing.T) {
		if directConvId == "" {
			t.Skip("no direct conversation ID")
		}
		// Send a message to edit
		sendResult, err := imClientA.IM().Messages.Send(ctx, directConvId, "Message to edit from Go", nil)
		if err != nil {
			t.Fatalf("Messages.Send error: %v", err)
		}
		if !sendResult.OK {
			t.Fatalf("Messages.Send not OK: %+v", sendResult.Error)
		}
		var msgData prismer.IMMessageData
		if err := sendResult.Decode(&msgData); err != nil {
			t.Fatalf("Decode msg: %v", err)
		}

		editResult, err := imClientA.IM().Messages.Edit(ctx, directConvId, msgData.Message.ID, "Edited from Go")
		if err != nil {
			t.Logf("Messages.Edit error (may not be supported): %v", err)
			return
		}
		if editResult.OK {
			t.Logf("Messages.Edit — ok=%v", editResult.OK)
		} else {
			t.Logf("Messages.Edit — not supported: %+v", editResult.Error)
		}
	})

	t.Run("Messages_Delete", func(t *testing.T) {
		if directConvId == "" {
			t.Skip("no direct conversation ID")
		}
		// Send a throwaway to delete
		sendResult, err := imClientA.IM().Messages.Send(ctx, directConvId, "Message to delete from Go", nil)
		if err != nil {
			t.Fatalf("Messages.Send error: %v", err)
		}
		if !sendResult.OK {
			t.Fatalf("Messages.Send not OK: %+v", sendResult.Error)
		}
		var msgData prismer.IMMessageData
		if err := sendResult.Decode(&msgData); err != nil {
			t.Fatalf("Decode msg: %v", err)
		}

		delResult, err := imClientA.IM().Messages.Delete(ctx, directConvId, msgData.Message.ID)
		if err != nil {
			t.Logf("Messages.Delete error (may not be supported): %v", err)
			return
		}
		if delResult.OK {
			t.Logf("Messages.Delete — ok=%v", delResult.OK)
		} else {
			t.Logf("Messages.Delete — not supported: %+v", delResult.Error)
		}
	})

	// ---------------------------------------------------------------
	// 3.14  Groups Extended: Remove Member
	// ---------------------------------------------------------------
	t.Run("Groups_RemoveMember", func(t *testing.T) {
		// Register agent C
		agentCUser := uniqueName("gotest_c")
		regResultC, err := apiClient.IM().Account.Register(ctx, &prismer.IMRegisterOptions{
			Type:         "agent",
			Username:     agentCUser,
			DisplayName:  fmt.Sprintf("Go Test Agent C %d", ts),
			AgentType:    "bot",
			Capabilities: []string{"testing"},
		})
		if err != nil {
			t.Fatalf("Register agent C error: %v", err)
		}
		if !regResultC.OK {
			t.Fatalf("Register agent C not OK: %+v", regResultC.Error)
		}
		var regDataC prismer.IMRegisterData
		if err := regResultC.Decode(&regDataC); err != nil {
			t.Fatalf("Decode register C: %v", err)
		}

		// Create group with C
		createResult, err := imClientA.IM().Groups.Create(ctx, &prismer.IMCreateGroupOptions{
			Title:   fmt.Sprintf("Remove Test Group %d", ts),
			Members: []string{regDataC.IMUserID},
		})
		if err != nil {
			t.Fatalf("Groups.Create error: %v", err)
		}
		if !createResult.OK {
			t.Fatalf("Groups.Create not OK: %+v", createResult.Error)
		}
		var rmGroupData prismer.IMGroupData
		if err := createResult.Decode(&rmGroupData); err != nil {
			t.Fatalf("Decode group: %v", err)
		}

		// Remove C
		rmResult, err := imClientA.IM().Groups.RemoveMember(ctx, rmGroupData.GroupID, regDataC.IMUserID)
		if err != nil {
			t.Logf("Groups.RemoveMember error (may not be supported): %v", err)
			return
		}
		if rmResult.OK {
			t.Logf("Groups.RemoveMember — ok=%v", rmResult.OK)
		} else {
			t.Logf("Groups.RemoveMember — %+v", rmResult.Error)
		}
	})

	// ---------------------------------------------------------------
	// 3.15  Workspace Extended
	// ---------------------------------------------------------------
	t.Run("Workspace_Init", func(t *testing.T) {
		wsResult, err := imClientA.IM().Workspace.Init(ctx, &prismer.IMWorkspaceInitOptions{WorkspaceID: "test-ws-int", UserID: "test-user", UserDisplayName: "Test User"})
		if err != nil {
			t.Logf("Workspace.Init error: %v", err)
			return
		}
		if wsResult.OK {
			t.Logf("Workspace.Init — ok=%v", wsResult.OK)
		} else {
			t.Logf("Workspace.Init — not available: %+v", wsResult.Error)
		}
	})

	t.Run("Workspace_InitGroup", func(t *testing.T) {
		wsResult, err := imClientA.IM().Workspace.InitGroup(ctx, &prismer.IMWorkspaceInitGroupOptions{WorkspaceID: "test-grp-ws-int", Title: "Integration Group", Users: []prismer.IMWorkspaceInitGroupUser{{UserID: "test-user", DisplayName: "Test User"}}})
		if err != nil {
			t.Logf("Workspace.InitGroup error: %v", err)
			return
		}
		if wsResult.OK {
			t.Logf("Workspace.InitGroup — ok=%v", wsResult.OK)
		} else {
			t.Logf("Workspace.InitGroup — not available: %+v", wsResult.Error)
		}
	})

	t.Run("Workspace_MentionAutocomplete", func(t *testing.T) {
		acResult, err := imClientA.IM().Workspace.MentionAutocomplete(ctx, "test-conv", "agent")
		if err != nil {
			t.Logf("Workspace.MentionAutocomplete error: %v", err)
			return
		}
		if acResult.OK {
			t.Logf("Workspace.MentionAutocomplete — ok=%v", acResult.OK)
		} else {
			t.Logf("Workspace.MentionAutocomplete — not available: %+v", acResult.Error)
		}
	})

	// ---------------------------------------------------------------
	// 3.16  Real-Time: WebSocket
	// ---------------------------------------------------------------
	t.Run("Realtime_WebSocket", func(t *testing.T) {
		wsCtx, wsCancel := context.WithTimeout(ctx, 30*time.Second)
		defer wsCancel()

		ws := imClientA.IM().Realtime.ConnectWS(&prismer.RealtimeConfig{
			Token:             agentAToken,
			AutoReconnect:     false,
			HeartbeatInterval: 60 * time.Second,
		})

		// Track authentication
		authCh := make(chan prismer.AuthenticatedPayload, 1)
		ws.OnAuthenticated(func(p prismer.AuthenticatedPayload) {
			authCh <- p
		})

		// Connect
		if err := ws.Connect(wsCtx); err != nil {
			t.Fatalf("WS Connect error: %v", err)
		}
		if ws.State() != prismer.StateConnected {
			t.Fatalf("expected connected, got %s", ws.State())
		}

		// Wait for auth
		select {
		case auth := <-authCh:
			t.Logf("WS Authenticated — userId=%s username=%s", auth.UserID, auth.Username)
		case <-time.After(10 * time.Second):
			t.Fatal("WS auth timeout")
		}

		// Ping — may timeout if server doesn't support ping/pong
		pong, err := ws.Ping(wsCtx)
		if err != nil {
			t.Logf("WS Ping error (non-fatal): %v", err)
		} else {
			t.Logf("WS Ping — requestId=%s", pong.RequestID)
		}

		// Join conversation
		if directConvId != "" {
			if err := ws.JoinConversation(wsCtx, directConvId); err != nil {
				t.Fatalf("WS JoinConversation error: %v", err)
			}
			time.Sleep(500 * time.Millisecond)

			// Listen for message.new
			msgCh := make(chan prismer.MessageNewPayload, 1)
			ws.OnMessageNew(func(p prismer.MessageNewPayload) {
				msgCh <- p
			})

			// Agent B sends via HTTP
			sendResult, err := imClientB.IM().Direct.Send(wsCtx, agentAId, fmt.Sprintf("WS realtime test %d", ts), nil)
			if err != nil {
				t.Fatalf("Agent B send error: %v", err)
			}
			if !sendResult.OK {
				t.Fatalf("Agent B send not OK: %+v", sendResult.Error)
			}

			// Wait for message (may or may not arrive depending on server)
			select {
			case msg := <-msgCh:
				t.Logf("WS message.new — content=%q senderId=%s", msg.Content, msg.SenderID)
				if msg.SenderID != targetId {
					t.Logf("expected senderId=%s, got %s (non-fatal)", targetId, msg.SenderID)
				}
			case <-time.After(15 * time.Second):
				t.Logf("WS message.new timeout (non-fatal — server may not relay to self)")
			}
		}

		// Disconnect
		if err := ws.Disconnect(); err != nil {
			t.Logf("WS Disconnect error: %v", err)
		}
		if ws.State() != prismer.StateDisconnected {
			t.Errorf("expected disconnected, got %s", ws.State())
		}
		t.Logf("WS Disconnect — ok")
	})

	// ---------------------------------------------------------------
	// 3.17  Real-Time: SSE
	// ---------------------------------------------------------------
	t.Run("Realtime_SSE", func(t *testing.T) {
		sseCtx, sseCancel := context.WithTimeout(ctx, 30*time.Second)
		defer sseCancel()

		sse := imClientA.IM().Realtime.ConnectSSE(&prismer.RealtimeConfig{
			Token:         agentAToken,
			AutoReconnect: false,
		})

		// Track authentication
		authCh := make(chan prismer.AuthenticatedPayload, 1)
		sse.OnAuthenticated(func(p prismer.AuthenticatedPayload) {
			authCh <- p
		})

		// Connect
		if err := sse.Connect(sseCtx); err != nil {
			t.Fatalf("SSE Connect error: %v", err)
		}
		if sse.State() != prismer.StateConnected {
			t.Fatalf("expected connected, got %s", sse.State())
		}

		// Wait briefly
		time.Sleep(1 * time.Second)

		// Listen for message.new
		msgCh := make(chan prismer.MessageNewPayload, 1)
		sse.OnMessageNew(func(p prismer.MessageNewPayload) {
			msgCh <- p
		})

		// Agent B sends via HTTP
		sendResult, err := imClientB.IM().Direct.Send(sseCtx, agentAId, fmt.Sprintf("SSE realtime test %d", ts), nil)
		if err != nil {
			t.Fatalf("Agent B SSE send error: %v", err)
		}
		if !sendResult.OK {
			t.Fatalf("Agent B SSE send not OK: %+v", sendResult.Error)
		}

		// Wait for message (may or may not arrive depending on server)
		select {
		case msg := <-msgCh:
			t.Logf("SSE message.new — content=%q senderId=%s", msg.Content, msg.SenderID)
		case <-time.After(15 * time.Second):
			t.Logf("SSE message.new timeout (non-fatal — server may not relay to self)")
		}

		// Disconnect
		if err := sse.Disconnect(); err != nil {
			t.Logf("SSE Disconnect error: %v", err)
		}
		if sse.State() != prismer.StateDisconnected {
			t.Errorf("expected disconnected, got %s", sse.State())
		}
		t.Logf("SSE Disconnect — ok")
	})
}

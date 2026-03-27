package prismer_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	prismer "github.com/Prismer-AI/Prismer/sdk/golang"
)

// standaloneTransport rewrites /api/im/* → /api/* for the standalone IM server.
type standaloneTransport struct {
	base http.RoundTripper
}

func (t *standaloneTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.URL.Path = strings.Replace(req.URL.Path, "/api/im/", "/api/", 1)
	return t.base.RoundTrip(req)
}

var (
	baseURL = envOr("IM_BASE_URL", "http://localhost:3200")
	runID   = fmt.Sprintf("%d", time.Now().UnixNano()%1000000)
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func localClient(token string) *prismer.Client {
	return prismer.NewClient(token,
		prismer.WithBaseURL(baseURL),
		prismer.WithTimeout(15*time.Second),
		prismer.WithHTTPClient(&http.Client{
			Timeout:   15 * time.Second,
			Transport: &standaloneTransport{base: http.DefaultTransport},
		}),
	)
}

type testAgent struct {
	client *prismer.Client
	token  string
	userID string
}

func createAgent(t *testing.T, suffix string) testAgent {
	t.Helper()
	anon := localClient("")
	ctx := context.Background()

	res, err := anon.IM().Account.Register(ctx, &prismer.IMRegisterOptions{
		Type:        "agent",
		Username:    fmt.Sprintf("gofile-%s-%s", suffix, runID),
		DisplayName: fmt.Sprintf("GoFile %s", suffix),
	})
	if err != nil {
		t.Fatalf("Register error: %v", err)
	}
	if !res.OK {
		t.Fatalf("Register failed: %v", res.Error)
	}
	var reg prismer.IMRegisterData
	if err := res.Decode(&reg); err != nil {
		t.Fatalf("Decode register: %v", err)
	}

	return testAgent{
		client: localClient(reg.Token),
		token:  reg.Token,
		userID: reg.IMUserID,
	}
}

// ===========================================================================
// Tests
// ===========================================================================

func TestFileUpload(t *testing.T) {
	agentA := createAgent(t, "a")
	agentB := createAgent(t, "b")
	ctx := context.Background()

	// Create a direct conversation
	msgRes, err := agentA.client.IM().Direct.Send(ctx, agentB.userID, "hello for file test", nil)
	if err != nil {
		t.Fatalf("Direct send error: %v", err)
	}
	if !msgRes.OK {
		t.Fatalf("Direct send failed: %v", msgRes.Error)
	}
	var msgData prismer.IMMessageData
	if err := msgRes.Decode(&msgData); err != nil {
		t.Fatalf("Decode message: %v", err)
	}
	conversationID := msgData.ConversationID

	var uploadedID string

	t.Run("Upload bytes - happy path", func(t *testing.T) {
		data := []byte("Hello from Go SDK upload test")
		result, err := agentA.client.IM().Files.Upload(ctx, data, &prismer.UploadOptions{
			FileName: "test-upload.txt",
			MimeType: "text/plain",
		})
		if err != nil {
			t.Fatalf("Upload error: %v", err)
		}
		if result.UploadID == "" {
			t.Fatal("Expected non-empty uploadId")
		}
		if result.CdnURL == "" {
			t.Fatal("Expected non-empty cdnUrl")
		}
		if result.FileName != "test-upload.txt" {
			t.Fatalf("Expected fileName test-upload.txt, got %s", result.FileName)
		}
		if result.FileSize != int64(len(data)) {
			t.Fatalf("Expected fileSize %d, got %d", len(data), result.FileSize)
		}
		if result.MimeType != "text/plain" {
			t.Fatalf("Expected mimeType text/plain, got %s", result.MimeType)
		}
		uploadedID = result.UploadID
	})

	t.Run("Upload auto-detects MIME", func(t *testing.T) {
		data := []byte("# Markdown\n\nHello!")
		result, err := agentA.client.IM().Files.Upload(ctx, data, &prismer.UploadOptions{
			FileName: "readme.md",
		})
		if err != nil {
			t.Fatalf("Upload error: %v", err)
		}
		if result.MimeType != "text/markdown" {
			t.Fatalf("Expected text/markdown, got %s", result.MimeType)
		}
	})

	t.Run("UploadFile from path", func(t *testing.T) {
		tmpDir := t.TempDir()
		filePath := filepath.Join(tmpDir, "test-file.txt")
		if err := os.WriteFile(filePath, []byte("File path upload test"), 0644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		result, err := agentA.client.IM().Files.UploadFile(ctx, filePath, nil)
		if err != nil {
			t.Fatalf("UploadFile error: %v", err)
		}
		if result.FileName != "test-file.txt" {
			t.Fatalf("Expected test-file.txt, got %s", result.FileName)
		}
	})

	t.Run("SendFile - upload + message", func(t *testing.T) {
		data := []byte(`{"key":"value"}`)
		result, err := agentA.client.IM().Files.SendFile(ctx, conversationID, data, &prismer.SendFileOptions{
			FileName: "data.json",
			Content:  "Here is the data file",
		})
		if err != nil {
			t.Fatalf("SendFile error: %v", err)
		}
		if result.Upload.UploadID == "" {
			t.Fatal("Expected upload.uploadId")
		}
		if result.Upload.CdnURL == "" {
			t.Fatal("Expected upload.cdnUrl")
		}
		if result.Upload.MimeType != "application/json" {
			t.Fatalf("Expected application/json, got %s", result.Upload.MimeType)
		}
		if result.Message == nil {
			t.Fatal("Expected message data")
		}
	})

	t.Run("Quota reflects uploads", func(t *testing.T) {
		res, err := agentA.client.IM().Files.Quota(ctx)
		if err != nil {
			t.Fatalf("Quota error: %v", err)
		}
		if !res.OK {
			t.Fatalf("Quota failed: %v", res.Error)
		}
		var quota prismer.IMFileQuota
		if err := res.Decode(&quota); err != nil {
			t.Fatalf("Decode quota: %v", err)
		}
		if quota.Used <= 0 {
			t.Fatalf("Expected used > 0, got %d", quota.Used)
		}
		if quota.FileCount <= 0 {
			t.Fatalf("Expected fileCount > 0, got %d", quota.FileCount)
		}
	})

	t.Run("Error - missing fileName", func(t *testing.T) {
		_, err := agentA.client.IM().Files.Upload(ctx, []byte("no name"), nil)
		if err == nil {
			t.Fatal("Expected error for missing fileName")
		}
		if !strings.Contains(err.Error(), "fileName") {
			t.Fatalf("Expected error about fileName, got: %v", err)
		}
	})

	t.Run("Error - missing fileName for Upload", func(t *testing.T) {
		_, err := agentA.client.IM().Files.Upload(ctx, []byte("data"), &prismer.UploadOptions{})
		if err == nil {
			t.Fatal("Expected error for empty fileName")
		}
		if !strings.Contains(err.Error(), "fileName") {
			t.Fatalf("Expected error about fileName, got: %v", err)
		}
	})

	t.Run("Types returns MIME types", func(t *testing.T) {
		res, err := agentA.client.IM().Files.Types(ctx)
		if err != nil {
			t.Fatalf("Types error: %v", err)
		}
		if !res.OK {
			t.Fatalf("Types failed: %v", res.Error)
		}
	})

	t.Run("Delete - cleanup", func(t *testing.T) {
		if uploadedID == "" {
			t.Skip("No upload to delete")
		}
		res, err := agentA.client.IM().Files.Delete(ctx, uploadedID)
		if err != nil {
			t.Fatalf("Delete error: %v", err)
		}
		if !res.OK {
			t.Fatalf("Delete failed: %v", res.Error)
		}
	})
}

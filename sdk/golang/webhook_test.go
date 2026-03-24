package prismer

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ============================================================================
// Test Helpers
// ============================================================================

const testSecret = "test-webhook-secret-key"

func makeTestSignature(body, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func makeTestPayload() map[string]any {
	return map[string]any{
		"source":    "prismer_im",
		"event":     "message.new",
		"timestamp": 1700000000,
		"message": map[string]any{
			"id":             "msg-001",
			"type":           "text",
			"content":        "Hello from test",
			"senderId":       "user-001",
			"conversationId": "conv-001",
			"parentId":       nil,
			"metadata":       map[string]any{},
			"createdAt":      "2026-01-01T00:00:00Z",
		},
		"sender": map[string]any{
			"id":          "user-001",
			"username":    "testuser",
			"displayName": "Test User",
			"role":        "human",
		},
		"conversation": map[string]any{
			"id":    "conv-001",
			"type":  "direct",
			"title": nil,
		},
	}
}

func makeTestPayloadString() string {
	b, _ := json.Marshal(makeTestPayload())
	return string(b)
}

// ============================================================================
// VerifyWebhookSignature
// ============================================================================

func TestVerifyWebhookSignature(t *testing.T) {
	t.Run("valid signature", func(t *testing.T) {
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		if !VerifyWebhookSignature(body, sig, testSecret) {
			t.Fatal("expected valid signature")
		}
	})

	t.Run("valid without prefix", func(t *testing.T) {
		body := makeTestPayloadString()
		sig := strings.TrimPrefix(makeTestSignature(body, testSecret), "sha256=")
		if !VerifyWebhookSignature(body, sig, testSecret) {
			t.Fatal("expected valid signature without prefix")
		}
	})

	t.Run("wrong signature", func(t *testing.T) {
		body := makeTestPayloadString()
		sig := "sha256=" + strings.Repeat("0", 64)
		if VerifyWebhookSignature(body, sig, testSecret) {
			t.Fatal("expected invalid signature")
		}
	})

	t.Run("wrong secret", func(t *testing.T) {
		body := makeTestPayloadString()
		sig := makeTestSignature(body, "wrong-secret")
		if VerifyWebhookSignature(body, sig, testSecret) {
			t.Fatal("expected invalid signature with wrong secret")
		}
	})

	t.Run("tampered body", func(t *testing.T) {
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		if VerifyWebhookSignature(body+"tampered", sig, testSecret) {
			t.Fatal("expected invalid for tampered body")
		}
	})

	t.Run("empty body", func(t *testing.T) {
		if VerifyWebhookSignature("", "sha256=abc", testSecret) {
			t.Fatal("expected false for empty body")
		}
	})

	t.Run("empty signature", func(t *testing.T) {
		if VerifyWebhookSignature("body", "", testSecret) {
			t.Fatal("expected false for empty signature")
		}
	})

	t.Run("empty secret", func(t *testing.T) {
		if VerifyWebhookSignature("body", "sha256=abc", "") {
			t.Fatal("expected false for empty secret")
		}
	})

	t.Run("sha256= prefix only", func(t *testing.T) {
		if VerifyWebhookSignature("body", "sha256=", testSecret) {
			t.Fatal("expected false for sha256= prefix only")
		}
	})
}

// ============================================================================
// ParseWebhookPayload
// ============================================================================

func TestParseWebhookPayload(t *testing.T) {
	t.Run("valid payload", func(t *testing.T) {
		body := makeTestPayloadString()
		payload, err := ParseWebhookPayload(body)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if payload.Source != "prismer_im" {
			t.Fatalf("expected source prismer_im, got %s", payload.Source)
		}
		if payload.Event != "message.new" {
			t.Fatalf("expected event message.new, got %s", payload.Event)
		}
		if payload.Message.ID != "msg-001" {
			t.Fatalf("expected message id msg-001, got %s", payload.Message.ID)
		}
		if payload.Sender.Username != "testuser" {
			t.Fatalf("expected sender username testuser, got %s", payload.Sender.Username)
		}
		if payload.Conversation.Type != "direct" {
			t.Fatalf("expected conversation type direct, got %s", payload.Conversation.Type)
		}
	})

	t.Run("invalid JSON", func(t *testing.T) {
		_, err := ParseWebhookPayload("not json")
		if err == nil {
			t.Fatal("expected error for invalid JSON")
		}
	})

	t.Run("unknown source", func(t *testing.T) {
		data := makeTestPayload()
		data["source"] = "unknown"
		b, _ := json.Marshal(data)
		_, err := ParseWebhookPayload(string(b))
		if err == nil || !strings.Contains(err.Error(), "unknown webhook source") {
			t.Fatalf("expected unknown source error, got: %v", err)
		}
	})

	t.Run("missing event", func(t *testing.T) {
		data := makeTestPayload()
		data["event"] = ""
		b, _ := json.Marshal(data)
		_, err := ParseWebhookPayload(string(b))
		if err == nil || !strings.Contains(err.Error(), "missing event") {
			t.Fatalf("expected missing event error, got: %v", err)
		}
	})

	t.Run("missing message ID", func(t *testing.T) {
		data := makeTestPayload()
		msg := data["message"].(map[string]any)
		msg["id"] = ""
		b, _ := json.Marshal(data)
		_, err := ParseWebhookPayload(string(b))
		if err == nil || !strings.Contains(err.Error(), "missing required fields") {
			t.Fatalf("expected missing fields error, got: %v", err)
		}
	})
}

// ============================================================================
// NewPrismerWebhook
// ============================================================================

func TestNewPrismerWebhook(t *testing.T) {
	t.Run("empty secret", func(t *testing.T) {
		_, err := NewPrismerWebhook("", func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		if err == nil {
			t.Fatal("expected error for empty secret")
		}
	})

	t.Run("valid creation", func(t *testing.T) {
		wh, err := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if wh == nil {
			t.Fatal("expected non-nil webhook")
		}
	})
}

// ============================================================================
// PrismerWebhook.Verify / .Parse
// ============================================================================

func TestPrismerWebhookVerify(t *testing.T) {
	wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })

	t.Run("valid", func(t *testing.T) {
		body := makeTestPayloadString()
		if !wh.Verify(body, makeTestSignature(body, testSecret)) {
			t.Fatal("expected valid")
		}
	})

	t.Run("invalid", func(t *testing.T) {
		body := makeTestPayloadString()
		if wh.Verify(body, "sha256=bad") {
			t.Fatal("expected invalid")
		}
	})
}

func TestPrismerWebhookParse(t *testing.T) {
	wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })

	t.Run("valid", func(t *testing.T) {
		payload, err := wh.Parse(makeTestPayloadString())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if payload.Source != "prismer_im" {
			t.Fatal("wrong source")
		}
	})

	t.Run("invalid", func(t *testing.T) {
		_, err := wh.Parse("invalid")
		if err == nil {
			t.Fatal("expected error")
		}
	})
}

// ============================================================================
// PrismerWebhook.Handle
// ============================================================================

func TestPrismerWebhookHandle(t *testing.T) {
	t.Run("invalid signature", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		body := makeTestPayloadString()
		status, data := wh.Handle(body, "sha256=bad")
		if status != 401 {
			t.Fatalf("expected 401, got %d", status)
		}
		m := data.(map[string]string)
		if m["error"] != "Invalid signature" {
			t.Fatalf("unexpected error: %s", m["error"])
		}
	})

	t.Run("malformed payload", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		body := `{"source": "unknown"}`
		sig := makeTestSignature(body, testSecret)
		status, _ := wh.Handle(body, sig)
		if status != 400 {
			t.Fatalf("expected 400, got %d", status)
		}
	})

	t.Run("success void", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		status, data := wh.Handle(body, sig)
		if status != 200 {
			t.Fatalf("expected 200, got %d", status)
		}
		m := data.(map[string]bool)
		if !m["ok"] {
			t.Fatal("expected ok:true")
		}
	})

	t.Run("success with reply", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) {
			return &WebhookReply{Content: "Echo: " + p.Message.Content}, nil
		})
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		status, data := wh.Handle(body, sig)
		if status != 200 {
			t.Fatalf("expected 200, got %d", status)
		}
		reply := data.(*WebhookReply)
		if reply.Content != "Echo: Hello from test" {
			t.Fatalf("unexpected reply: %s", reply.Content)
		}
	})

	t.Run("handler error", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) {
			return nil, fmt.Errorf("Something broke")
		})
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		status, data := wh.Handle(body, sig)
		if status != 500 {
			t.Fatalf("expected 500, got %d", status)
		}
		m := data.(map[string]string)
		if !strings.Contains(m["error"], "Something broke") {
			t.Fatalf("unexpected error: %s", m["error"])
		}
	})
}

// ============================================================================
// PrismerWebhook.HTTPHandler
// ============================================================================

func TestPrismerWebhookHTTPHandler(t *testing.T) {
	t.Run("GET returns 405", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		req := httptest.NewRequest(http.MethodGet, "/webhook", nil)
		w := httptest.NewRecorder()
		wh.HTTPHandler().ServeHTTP(w, req)
		if w.Code != 405 {
			t.Fatalf("expected 405, got %d", w.Code)
		}
	})

	t.Run("invalid signature returns 401", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		body := makeTestPayloadString()
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
		req.Header.Set("X-Prismer-Signature", "sha256=bad")
		w := httptest.NewRecorder()
		wh.HTTPHandler().ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("expected 401, got %d", w.Code)
		}
	})

	t.Run("valid returns 200", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) { return nil, nil })
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
		req.Header.Set("X-Prismer-Signature", sig)
		w := httptest.NewRecorder()
		wh.HTTPHandler().ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		var result map[string]any
		json.NewDecoder(w.Body).Decode(&result)
		if result["ok"] != true {
			t.Fatal("expected ok:true")
		}
	})

	t.Run("reply returned", func(t *testing.T) {
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) {
			return &WebhookReply{Content: "Reply!", Type: "markdown"}, nil
		})
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
		req.Header.Set("X-Prismer-Signature", sig)
		w := httptest.NewRecorder()
		wh.HTTPHandler().ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("expected 200, got %d", w.Code)
		}

		respBody, _ := io.ReadAll(w.Body)
		var result map[string]any
		json.Unmarshal(respBody, &result)
		if result["content"] != "Reply!" {
			t.Fatalf("unexpected content: %v", result["content"])
		}
		if result["type"] != "markdown" {
			t.Fatalf("unexpected type: %v", result["type"])
		}
	})

	t.Run("payload passed to handler", func(t *testing.T) {
		var received *WebhookPayload
		wh, _ := NewPrismerWebhook(testSecret, func(p *WebhookPayload) (*WebhookReply, error) {
			received = p
			return nil, nil
		})
		body := makeTestPayloadString()
		sig := makeTestSignature(body, testSecret)
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
		req.Header.Set("X-Prismer-Signature", sig)
		w := httptest.NewRecorder()
		wh.HTTPHandler().ServeHTTP(w, req)

		if received == nil {
			t.Fatal("handler was not called")
		}
		if received.Message.Content != "Hello from test" {
			t.Fatalf("unexpected content: %s", received.Message.Content)
		}
		if received.Sender.Role != "human" {
			t.Fatalf("unexpected role: %s", received.Sender.Role)
		}
		if received.Conversation.ID != "conv-001" {
			t.Fatalf("unexpected conversation: %s", received.Conversation.ID)
		}
	})
}

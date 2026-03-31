package prismer

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ============================================================================
// Webhook Types
// ============================================================================

// WebhookPayload represents a Prismer IM webhook payload (POST to agent endpoint).
type WebhookPayload struct {
	Source       string              `json:"source"`
	Event        string              `json:"event"`
	Timestamp    int64               `json:"timestamp"`
	Message      WebhookMessage      `json:"message"`
	Sender       WebhookSender       `json:"sender"`
	Conversation WebhookConversation `json:"conversation"`
}

// WebhookMessage represents a message in a webhook payload.
type WebhookMessage struct {
	ID             string         `json:"id"`
	Type           string         `json:"type"`
	Content        string         `json:"content"`
	SenderID       string         `json:"senderId"`
	ConversationID string         `json:"conversationId"`
	ParentID       *string        `json:"parentId"`
	Metadata       map[string]any `json:"metadata"`
	CreatedAt      string         `json:"createdAt"`
}

// WebhookSender represents sender information in a webhook payload.
type WebhookSender struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"` // "human" or "agent"
}

// WebhookConversation represents conversation information in a webhook payload.
type WebhookConversation struct {
	ID    string  `json:"id"`
	Type  string  `json:"type"` // "direct" or "group"
	Title *string `json:"title"`
}

// WebhookReply is an optional reply from a webhook handler.
type WebhookReply struct {
	Content string `json:"content"`
	Type    string `json:"type,omitempty"` // "text", "markdown", or "code"
}

// WebhookHandlerFunc is the callback signature for handling webhook payloads.
type WebhookHandlerFunc func(payload *WebhookPayload) (*WebhookReply, error)

// ============================================================================
// Standalone Functions
// ============================================================================

// VerifyWebhookSignature verifies a Prismer IM webhook signature using HMAC-SHA256.
// Uses constant-time comparison to prevent timing attacks.
func VerifyWebhookSignature(body, signature, secret string) bool {
	if body == "" || signature == "" || secret == "" {
		return false
	}

	sig := signature
	if strings.HasPrefix(sig, "sha256=") {
		sig = sig[7:]
	}
	if sig == "" {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	expected := hex.EncodeToString(mac.Sum(nil))

	if len(sig) != len(expected) {
		return false
	}

	return subtle.ConstantTimeCompare([]byte(sig), []byte(expected)) == 1
}

// ParseWebhookPayload parses a raw webhook body into a typed WebhookPayload.
func ParseWebhookPayload(body string) (*WebhookPayload, error) {
	var payload WebhookPayload
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return nil, fmt.Errorf("invalid JSON in webhook body: %w", err)
	}

	if payload.Source != "prismer_im" {
		return nil, fmt.Errorf("unknown webhook source: %s", payload.Source)
	}
	if payload.Event == "" {
		return nil, fmt.Errorf("missing event field in webhook payload")
	}
	if payload.Message.ID == "" || payload.Sender.ID == "" || payload.Conversation.ID == "" {
		return nil, fmt.Errorf("missing required fields in webhook payload (message, sender, conversation)")
	}

	return &payload, nil
}

// ============================================================================
// PrismerWebhook
// ============================================================================

// PrismerWebhook handles Prismer IM webhook verification, parsing, and dispatch.
type PrismerWebhook struct {
	secret    string
	onMessage WebhookHandlerFunc
}

// NewPrismerWebhook creates a new webhook handler.
func NewPrismerWebhook(secret string, onMessage WebhookHandlerFunc) (*PrismerWebhook, error) {
	if secret == "" {
		return nil, fmt.Errorf("webhook secret is required")
	}
	return &PrismerWebhook{
		secret:    secret,
		onMessage: onMessage,
	}, nil
}

// Verify verifies an HMAC-SHA256 signature.
func (w *PrismerWebhook) Verify(body, signature string) bool {
	return VerifyWebhookSignature(body, signature, w.secret)
}

// Parse parses a raw body into a typed WebhookPayload.
func (w *PrismerWebhook) Parse(body string) (*WebhookPayload, error) {
	return ParseWebhookPayload(body)
}

// Handle processes a webhook request (verify + parse + call handler).
// Returns the status code and response body for the caller to write.
func (w *PrismerWebhook) Handle(body, signature string) (int, any) {
	if !w.Verify(body, signature) {
		return http.StatusUnauthorized, map[string]string{"error": "Invalid signature"}
	}

	payload, err := w.Parse(body)
	if err != nil {
		return http.StatusBadRequest, map[string]string{"error": err.Error()}
	}

	reply, err := w.onMessage(payload)
	if err != nil {
		return http.StatusInternalServerError, map[string]string{"error": err.Error()}
	}

	if reply != nil {
		return http.StatusOK, reply
	}
	return http.StatusOK, map[string]bool{"ok": true}
}

// HTTPHandler returns an http.Handler that processes webhook requests.
//
// Example:
//
//	wh, _ := prismer.NewPrismerWebhook("secret", handler)
//	http.Handle("/webhook", wh.HTTPHandler())
func (w *PrismerWebhook) HTTPHandler() http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(rw).Encode(map[string]string{"error": "Method not allowed"})
			return
		}

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(rw).Encode(map[string]string{"error": "Failed to read body"})
			return
		}
		defer r.Body.Close()

		body := string(bodyBytes)
		signature := r.Header.Get("X-Prismer-Signature")

		statusCode, data := w.Handle(body, signature)

		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(statusCode)
		json.NewEncoder(rw).Encode(data)
	})
}

// HTTPHandlerFunc returns an http.HandlerFunc for convenience.
func (w *PrismerWebhook) HTTPHandlerFunc() http.HandlerFunc {
	return w.HTTPHandler().ServeHTTP
}

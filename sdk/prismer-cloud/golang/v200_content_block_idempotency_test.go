// v2.0 §3.0.2 Gap A-④ + §4.6 — ContentBlock + sendMessage X-Idempotency-Key
//
// Wave 3 Agent D1 (track 14 §3.0.2): protocol-layer SDK upgrades.
//
//	1. ContentBlock 8-variant struct + constructors marshal/unmarshal correctly.
//	2. ChatMessage content polymorphism (string | []ContentBlock) round-trips.
//	3. MessagesClient/DirectClient/GroupsClient.Send + SendBlocks stamp
//	   X-Idempotency-Key header (auto + explicit + retry).
//	4. ContentBlock[] serialises into body.contentBlocks.
package prismer

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
)

var uuidV4Re = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// ─────────────────────────────────────────────────────────────────────────────
// 1. ContentBlock 8 variants — constructor + JSON round-trip
// ─────────────────────────────────────────────────────────────────────────────

func TestContentBlockAllVariantsRoundTrip(t *testing.T) {
	blocks := []ContentBlock{
		NewTextBlock("hi"),
		NewImageBlock("a1", "image/png", "pic"),
		NewAudioBlock("a2", "audio/mpeg", 120),
		NewVideoBlock("a3", "video/mp4", 4000, "https://x/y.jpg"),
		NewFileBlock("a4", "application/pdf", "spec.pdf"),
		NewToolUseBlock("t1", "image_generate", json.RawMessage(`{"prompt":"cat"}`)),
		NewToolResultBlock("t1", []ContentBlock{NewTextBlock("ok")}),
		NewReasoningBlock("thinking", false),
	}
	wantKinds := []ContentBlockKind{
		ContentBlockKindText, ContentBlockKindImage, ContentBlockKindAudio,
		ContentBlockKindVideo, ContentBlockKindFile, ContentBlockKindToolUse,
		ContentBlockKindToolResult, ContentBlockKindReasoning,
	}
	for i, b := range blocks {
		if b.Kind != wantKinds[i] {
			t.Errorf("block[%d] kind = %q, want %q", i, b.Kind, wantKinds[i])
		}
	}

	// JSON round-trip — and verify discriminator + variant fields present
	data, err := json.Marshal(blocks)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	js := string(data)
	for _, want := range []string{
		`"kind":"text"`, `"kind":"image"`, `"kind":"audio"`, `"kind":"video"`,
		`"kind":"file"`, `"kind":"tool_use"`, `"kind":"tool_result"`, `"kind":"reasoning"`,
		`"assetId":"a1"`, `"mediaType":"image/png"`, `"thumbnailUrl":"https://x/y.jpg"`,
		`"toolName":"image_generate"`, `"inputJson":{"prompt":"cat"}`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("marshalled JSON missing %q\ngot: %s", want, js)
		}
	}

	var back []ContentBlock
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back[6].Kind != ContentBlockKindToolResult || len(back[6].Output) != 1 || back[6].Output[0].Text != "ok" {
		t.Errorf("nested tool_result lost in round-trip: %+v", back[6])
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ChatMessage content polymorphism (string | []ContentBlock)
// ─────────────────────────────────────────────────────────────────────────────

func TestChatMessageStringContent(t *testing.T) {
	m := ChatMessage{Role: "user", Content: "hello"}
	data, _ := json.Marshal(m)
	if !strings.Contains(string(data), `"content":"hello"`) {
		t.Errorf("string content not emitted: %s", data)
	}
	var back ChatMessage
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Content != "hello" || len(back.Blocks) != 0 {
		t.Errorf("round-trip mismatch: %+v", back)
	}
}

func TestChatMessageBlocksContent(t *testing.T) {
	m := ChatMessage{Role: "user", Blocks: []ContentBlock{
		NewTextBlock("see"),
		NewImageBlock("a1", "image/png", ""),
	}}
	data, _ := json.Marshal(m)
	if !strings.Contains(string(data), `"content":[`) {
		t.Errorf("blocks content should be array: %s", data)
	}
	var back ChatMessage
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(back.Blocks) != 2 || back.Blocks[1].Kind != ContentBlockKindImage {
		t.Errorf("blocks round-trip mismatch: %+v", back)
	}
}

func TestTaskInputFlattensExtra(t *testing.T) {
	ti := TaskInput{
		Prompt:   "fallback",
		Messages: []ChatMessage{{Role: "user", Content: "hi"}},
		Extra:    map[string]interface{}{"captureScreenshot": true},
	}
	data, _ := json.Marshal(ti)
	js := string(data)
	for _, want := range []string{`"prompt":"fallback"`, `"messages":[`, `"captureScreenshot":true`} {
		if !strings.Contains(js, want) {
			t.Errorf("TaskInput JSON missing %q\ngot: %s", want, js)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. generateIdempotencyKey + buildSendPayload unit tests
// ─────────────────────────────────────────────────────────────────────────────

func TestGenerateIdempotencyKeyUUID(t *testing.T) {
	for i := 0; i < 100; i++ {
		k := generateIdempotencyKey()
		if !uuidV4Re.MatchString(k) {
			t.Fatalf("generateIdempotencyKey returned %q which is not RFC 4122 v4", k)
		}
	}
	// uniqueness
	seen := make(map[string]struct{})
	for i := 0; i < 100; i++ {
		seen[generateIdempotencyKey()] = struct{}{}
	}
	if len(seen) != 100 {
		t.Errorf("expected 100 unique keys, got %d", len(seen))
	}
}

func TestBuildSendPayloadStringAutoKey(t *testing.T) {
	body, key := buildSendPayload("hello", nil)
	if body["content"] != "hello" || body["type"] != "text" {
		t.Errorf("body content/type wrong: %+v", body)
	}
	if body["idempotencyKey"] != key {
		t.Errorf("body.idempotencyKey != key")
	}
	if !uuidV4Re.MatchString(key) {
		t.Errorf("auto key not uuid v4: %q", key)
	}
}

func TestBuildSendPayloadExplicitKey(t *testing.T) {
	opts := &IMSendOptions{IdempotencyKey: "my-custom"}
	body, key := buildSendPayload("retry", opts)
	if key != "my-custom" || body["idempotencyKey"] != "my-custom" {
		t.Errorf("explicit key not honoured: key=%q body=%+v", key, body)
	}
}

func TestBuildSendPayloadBlocksWithBlocks(t *testing.T) {
	blocks := []ContentBlock{NewTextBlock("x"), NewImageBlock("a", "image/png", "")}
	body, key := buildSendPayloadBlocks(blocks, nil)
	if body["content"] != "" {
		t.Errorf("body.content should be empty placeholder, got %v", body["content"])
	}
	got, ok := body["contentBlocks"].([]ContentBlock)
	if !ok || len(got) != 2 || got[1].Kind != ContentBlockKindImage {
		t.Errorf("body.contentBlocks not set: %+v", body["contentBlocks"])
	}
	if !uuidV4Re.MatchString(key) {
		t.Errorf("auto key not uuid v4: %q", key)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. End-to-end: httptest server observes X-Idempotency-Key behaviour
// ─────────────────────────────────────────────────────────────────────────────

type capturedCall struct {
	Method  string
	Path    string
	Header  http.Header
	Body    map[string]interface{}
}

func newCapturingServer(t *testing.T) (*httptest.Server, *[]capturedCall) {
	t.Helper()
	var mu sync.Mutex
	calls := []capturedCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		calls = append(calls, capturedCall{
			Method: r.Method, Path: r.URL.Path, Header: r.Header.Clone(), Body: body,
		})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"ok":true,"success":true,"data":{"message":{"id":"m1","boundarySeq":1}}}`))
	}))
	return srv, &calls
}

func TestMessagesClientAutoIdempotencyHeader(t *testing.T) {
	srv, calls := newCapturingServer(t)
	defer srv.Close()
	c := NewClient("sk-prismer-test", WithBaseURL(srv.URL))

	_, err := c.IM().Messages.Send(context.Background(), "cid-1", "hello", nil)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(*calls))
	}
	got := (*calls)[0]
	if got.Path != "/api/im/messages/cid-1" {
		t.Errorf("unexpected path: %s", got.Path)
	}
	key := got.Header.Get("X-Idempotency-Key")
	if !uuidV4Re.MatchString(key) {
		t.Errorf("X-Idempotency-Key not uuid v4: %q", key)
	}
	if got.Body["idempotencyKey"] != key {
		t.Errorf("body.idempotencyKey != header (offline-path mirror missing)")
	}
}

func TestTwoSendsHaveDistinctKeys(t *testing.T) {
	srv, calls := newCapturingServer(t)
	defer srv.Close()
	c := NewClient("sk-prismer-test", WithBaseURL(srv.URL))

	_, _ = c.IM().Messages.Send(context.Background(), "cid-1", "first", nil)
	_, _ = c.IM().Messages.Send(context.Background(), "cid-1", "second", nil)
	if len(*calls) != 2 {
		t.Fatalf("expected 2 calls")
	}
	k1 := (*calls)[0].Header.Get("X-Idempotency-Key")
	k2 := (*calls)[1].Header.Get("X-Idempotency-Key")
	if k1 == "" || k2 == "" || k1 == k2 {
		t.Errorf("expected two distinct uuids, got %q vs %q", k1, k2)
	}
}

func TestRetryReusesExplicitKey(t *testing.T) {
	srv, calls := newCapturingServer(t)
	defer srv.Close()
	c := NewClient("sk-prismer-test", WithBaseURL(srv.URL))

	shared := "11111111-2222-4333-8444-555555555555"
	for i := 0; i < 3; i++ {
		_, _ = c.IM().Messages.Send(context.Background(), "cid-1", "crashy",
			&IMSendOptions{IdempotencyKey: shared})
	}
	if len(*calls) != 3 {
		t.Fatalf("expected 3 calls")
	}
	for i, c := range *calls {
		if c.Header.Get("X-Idempotency-Key") != shared {
			t.Errorf("call[%d] header key = %q, want %q", i, c.Header.Get("X-Idempotency-Key"), shared)
		}
		if c.Body["idempotencyKey"] != shared {
			t.Errorf("call[%d] body.idempotencyKey wrong", i)
		}
	}
}

func TestDirectAndGroupsAlsoStampHeader(t *testing.T) {
	srv, calls := newCapturingServer(t)
	defer srv.Close()
	c := NewClient("sk-prismer-test", WithBaseURL(srv.URL))

	_, _ = c.IM().Direct.Send(context.Background(), "u1", "dm", nil)
	_, _ = c.IM().Groups.Send(context.Background(), "g1", "gm", nil)
	if (*calls)[0].Path != "/api/im/direct/u1/messages" {
		t.Errorf("direct path wrong: %s", (*calls)[0].Path)
	}
	if (*calls)[1].Path != "/api/im/groups/g1/messages" {
		t.Errorf("groups path wrong: %s", (*calls)[1].Path)
	}
	k1 := (*calls)[0].Header.Get("X-Idempotency-Key")
	k2 := (*calls)[1].Header.Get("X-Idempotency-Key")
	if !uuidV4Re.MatchString(k1) || !uuidV4Re.MatchString(k2) || k1 == k2 {
		t.Errorf("direct/groups keys not distinct uuids: %q vs %q", k1, k2)
	}
}

func TestSendBlocksWiresContentBlocks(t *testing.T) {
	srv, calls := newCapturingServer(t)
	defer srv.Close()
	c := NewClient("sk-prismer-test", WithBaseURL(srv.URL))

	blocks := []ContentBlock{
		NewTextBlock("see:"),
		NewImageBlock("a1", "image/png", "screenshot"),
	}
	_, err := c.IM().Messages.SendBlocks(context.Background(), "cid-1", blocks, nil)
	if err != nil {
		t.Fatalf("send blocks: %v", err)
	}
	got := (*calls)[0]
	if got.Body["content"] != "" {
		t.Errorf("expected empty placeholder content during double-write window, got %v", got.Body["content"])
	}
	cb, ok := got.Body["contentBlocks"].([]interface{})
	if !ok || len(cb) != 2 {
		t.Fatalf("contentBlocks not in body: %+v", got.Body["contentBlocks"])
	}
	first, _ := cb[0].(map[string]interface{})
	if first["kind"] != "text" || first["text"] != "see:" {
		t.Errorf("first block wrong: %+v", first)
	}
	if !uuidV4Re.MatchString(got.Header.Get("X-Idempotency-Key")) {
		t.Errorf("missing X-Idempotency-Key on SendBlocks")
	}
}

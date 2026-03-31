package prismer

import (
	"encoding/json"
	"testing"
)

// ============================================================================
// TestSafeSlug — path traversal, null bytes, slashes, empty, unicode
// ============================================================================

func TestSafeSlug(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantSafe bool // result must not contain .., /, \, or \x00
	}{
		{"plain slug", "my-skill", true},
		{"path traversal double dot", "../../etc/passwd", true},
		{"embedded double dot", "skill..name", true},
		{"forward slash", "a/b/c", true},
		{"backslash", `a\b\c`, true},
		{"null byte", "skill\x00evil", true},
		{"null byte in middle", "abc\x00def", true},
		{"empty string", "", true},
		{"only dots", "..", true},
		{"mixed traversal", "../../../.ssh/id_rsa", true},
		{"unicode chars", "skill-\u4e2d\u6587", true},
		{"unicode with traversal", "\u4e2d../\u6587", true},
		{"spaces", "my skill name", true},
		{"dots only triple", "...", true},
		{"dot-slash combo", "./hidden", true},
		{"backslash traversal", `..\..\windows`, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := safeSlug(tt.input)

			// Must never contain dangerous sequences
			for _, bad := range []string{"..", "/", "\\", "\x00"} {
				if contains(result, bad) {
					t.Errorf("safeSlug(%q) = %q, still contains %q", tt.input, result, bad)
				}
			}

			// For non-empty input with valid chars, result should be non-empty
			// (empty input may return "." from filepath.Base)
			t.Logf("safeSlug(%q) = %q", tt.input, result)
		})
	}
}

func contains(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// ============================================================================
// TestGuessMimeType — all extension mappings, unknown, empty, case insensitive
// ============================================================================

func TestGuessMimeType(t *testing.T) {
	tests := []struct {
		name     string
		fileName string
		want     string // expected MIME type (empty = just check non-empty)
	}{
		// Custom fallback mappings
		{"markdown", "README.md", "text/markdown"},
		{"yaml", "config.yaml", "text/yaml"},
		{"yml", "config.yml", "text/yaml"},
		{"webp image", "photo.webp", "image/webp"},
		{"webm video", "video.webm", "video/webm"},

		// Standard Go mime types
		{"json", "data.json", "application/json"},
		{"html", "index.html", "text/html"},
		{"css", "style.css", "text/css"},
		{"javascript", "app.js", ""},    // varies by platform
		{"png", "image.png", "image/png"},
		{"jpeg", "photo.jpg", "image/jpeg"},
		{"gif", "anim.gif", "image/gif"},
		{"pdf", "doc.pdf", "application/pdf"},
		{"xml", "data.xml", ""},          // varies by platform
		{"plain text", "notes.txt", ""},  // usually text/plain

		// Unknown / missing extension
		{"no extension", "Makefile", "application/octet-stream"},
		{"empty string", "", "application/octet-stream"},
		{"unknown ext", "data.xyz123", "application/octet-stream"},
		{"dot only", ".", "application/octet-stream"},

		// Case sensitivity — Go's mime.TypeByExtension is case-insensitive
		{"uppercase MD", "README.MD", ""},
		{"mixed case Json", "data.Json", ""},

		// Path with directories
		{"path with dirs", "/some/path/to/file.md", "text/markdown"},
		{"nested yaml", "configs/app.yaml", "text/yaml"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := guessMimeType(tt.fileName)

			if got == "" {
				t.Errorf("guessMimeType(%q) returned empty string", tt.fileName)
				return
			}

			if tt.want != "" && got != tt.want {
				t.Errorf("guessMimeType(%q) = %q, want %q", tt.fileName, got, tt.want)
			}

			// Verify no charset parameter is included
			for i := range got {
				if got[i] == ';' {
					t.Errorf("guessMimeType(%q) = %q, should not contain charset parameter", tt.fileName, got)
					break
				}
			}

			t.Logf("guessMimeType(%q) = %q", tt.fileName, got)
		})
	}
}

// ============================================================================
// TestAPIErrorUnmarshalJSON — string format, object format, malformed JSON
// ============================================================================

func TestAPIErrorUnmarshalJSON(t *testing.T) {
	t.Run("string format", func(t *testing.T) {
		data := []byte(`"Something went wrong"`)
		var e APIError
		if err := json.Unmarshal(data, &e); err != nil {
			t.Fatalf("Unmarshal string error: %v", err)
		}
		if e.Code != "ERROR" {
			t.Errorf("expected Code=ERROR, got %q", e.Code)
		}
		if e.Message != "Something went wrong" {
			t.Errorf("expected Message='Something went wrong', got %q", e.Message)
		}
		if e.Error() != "ERROR: Something went wrong" {
			t.Errorf("Error() = %q", e.Error())
		}
	})

	t.Run("object format", func(t *testing.T) {
		data := []byte(`{"code":"NOT_FOUND","message":"Resource not found"}`)
		var e APIError
		if err := json.Unmarshal(data, &e); err != nil {
			t.Fatalf("Unmarshal object error: %v", err)
		}
		if e.Code != "NOT_FOUND" {
			t.Errorf("expected Code=NOT_FOUND, got %q", e.Code)
		}
		if e.Message != "Resource not found" {
			t.Errorf("expected Message='Resource not found', got %q", e.Message)
		}
		if e.Error() != "NOT_FOUND: Resource not found" {
			t.Errorf("Error() = %q", e.Error())
		}
	})

	t.Run("object without code", func(t *testing.T) {
		data := []byte(`{"message":"Just a message"}`)
		var e APIError
		if err := json.Unmarshal(data, &e); err != nil {
			t.Fatalf("Unmarshal error: %v", err)
		}
		if e.Code != "" {
			t.Errorf("expected empty Code, got %q", e.Code)
		}
		if e.Message != "Just a message" {
			t.Errorf("expected Message='Just a message', got %q", e.Message)
		}
		// Error() without code should just return message
		if e.Error() != "Just a message" {
			t.Errorf("Error() = %q", e.Error())
		}
	})

	t.Run("empty string", func(t *testing.T) {
		data := []byte(`""`)
		var e APIError
		if err := json.Unmarshal(data, &e); err != nil {
			t.Fatalf("Unmarshal error: %v", err)
		}
		if e.Code != "ERROR" {
			t.Errorf("expected Code=ERROR, got %q", e.Code)
		}
		if e.Message != "" {
			t.Errorf("expected empty Message, got %q", e.Message)
		}
	})

	t.Run("malformed JSON", func(t *testing.T) {
		data := []byte(`{invalid json}`)
		var e APIError
		err := json.Unmarshal(data, &e)
		if err == nil {
			t.Error("expected error for malformed JSON, got nil")
		}
	})

	t.Run("null JSON", func(t *testing.T) {
		data := []byte(`null`)
		var e APIError
		// json.Unmarshal with null should not fail, but fields stay zero
		err := json.Unmarshal(data, &e)
		// null is not a string, falls through to alias path; alias unmarshal of null is a no-op
		if err != nil {
			t.Logf("null unmarshal returned error (acceptable): %v", err)
		}
	})

	t.Run("numeric JSON", func(t *testing.T) {
		data := []byte(`42`)
		var e APIError
		err := json.Unmarshal(data, &e)
		// 42 is not a string and not a valid object — should fail
		if err == nil {
			t.Error("expected error for numeric JSON, got nil")
		}
	})
}

// ============================================================================
// TestIMResultDecode — nil data, valid JSON, malformed JSON
// ============================================================================

func TestIMResultDecode(t *testing.T) {
	t.Run("nil data", func(t *testing.T) {
		r := &IMResult{OK: true, Data: nil}
		var target map[string]interface{}
		err := r.Decode(&target)
		if err != nil {
			t.Errorf("Decode nil data should not error, got: %v", err)
		}
		if target != nil {
			t.Errorf("expected nil target after decoding nil data, got %v", target)
		}
	})

	t.Run("valid JSON object", func(t *testing.T) {
		r := &IMResult{
			OK:   true,
			Data: json.RawMessage(`{"name":"test","count":42}`),
		}
		var target struct {
			Name  string `json:"name"`
			Count int    `json:"count"`
		}
		err := r.Decode(&target)
		if err != nil {
			t.Fatalf("Decode error: %v", err)
		}
		if target.Name != "test" {
			t.Errorf("expected name=test, got %q", target.Name)
		}
		if target.Count != 42 {
			t.Errorf("expected count=42, got %d", target.Count)
		}
	})

	t.Run("valid JSON array", func(t *testing.T) {
		r := &IMResult{
			OK:   true,
			Data: json.RawMessage(`[1,2,3]`),
		}
		var target []int
		err := r.Decode(&target)
		if err != nil {
			t.Fatalf("Decode error: %v", err)
		}
		if len(target) != 3 {
			t.Errorf("expected 3 items, got %d", len(target))
		}
	})

	t.Run("malformed JSON", func(t *testing.T) {
		r := &IMResult{
			OK:   true,
			Data: json.RawMessage(`{broken`),
		}
		var target map[string]interface{}
		err := r.Decode(&target)
		if err == nil {
			t.Error("expected error for malformed JSON, got nil")
		}
	})

	t.Run("empty JSON object", func(t *testing.T) {
		r := &IMResult{
			OK:   true,
			Data: json.RawMessage(`{}`),
		}
		var target map[string]interface{}
		err := r.Decode(&target)
		if err != nil {
			t.Fatalf("Decode error: %v", err)
		}
		if len(target) != 0 {
			t.Errorf("expected empty map, got %v", target)
		}
	})

	t.Run("string JSON", func(t *testing.T) {
		r := &IMResult{
			OK:   true,
			Data: json.RawMessage(`"hello"`),
		}
		var target string
		err := r.Decode(&target)
		if err != nil {
			t.Fatalf("Decode error: %v", err)
		}
		if target != "hello" {
			t.Errorf("expected 'hello', got %q", target)
		}
	})
}

// ============================================================================
// TestPaginationQuery — nil opts, zero values, partial fill
// ============================================================================

func TestPaginationQuery(t *testing.T) {
	t.Run("nil opts", func(t *testing.T) {
		result := paginationQuery(nil)
		if result != nil {
			t.Errorf("expected nil for nil opts, got %v", result)
		}
	})

	t.Run("zero values", func(t *testing.T) {
		opts := &IMPaginationOptions{Limit: 0, Offset: 0}
		result := paginationQuery(opts)
		if result != nil {
			t.Errorf("expected nil for zero values, got %v", result)
		}
	})

	t.Run("only limit", func(t *testing.T) {
		opts := &IMPaginationOptions{Limit: 25}
		result := paginationQuery(opts)
		if result == nil {
			t.Fatal("expected non-nil result")
		}
		if result["limit"] != "25" {
			t.Errorf("expected limit=25, got %q", result["limit"])
		}
		if _, exists := result["offset"]; exists {
			t.Errorf("offset should not be set, got %q", result["offset"])
		}
	})

	t.Run("only offset", func(t *testing.T) {
		opts := &IMPaginationOptions{Offset: 10}
		result := paginationQuery(opts)
		if result == nil {
			t.Fatal("expected non-nil result")
		}
		if result["offset"] != "10" {
			t.Errorf("expected offset=10, got %q", result["offset"])
		}
		if _, exists := result["limit"]; exists {
			t.Errorf("limit should not be set, got %q", result["limit"])
		}
	})

	t.Run("both values", func(t *testing.T) {
		opts := &IMPaginationOptions{Limit: 50, Offset: 100}
		result := paginationQuery(opts)
		if result == nil {
			t.Fatal("expected non-nil result")
		}
		if result["limit"] != "50" {
			t.Errorf("expected limit=50, got %q", result["limit"])
		}
		if result["offset"] != "100" {
			t.Errorf("expected offset=100, got %q", result["offset"])
		}
	})

	t.Run("large values", func(t *testing.T) {
		opts := &IMPaginationOptions{Limit: 999999, Offset: 888888}
		result := paginationQuery(opts)
		if result == nil {
			t.Fatal("expected non-nil result")
		}
		if result["limit"] != "999999" {
			t.Errorf("expected limit=999999, got %q", result["limit"])
		}
		if result["offset"] != "888888" {
			t.Errorf("expected offset=888888, got %q", result["offset"])
		}
	})

	t.Run("negative values treated as zero", func(t *testing.T) {
		// Negative values should not pass the > 0 check
		opts := &IMPaginationOptions{Limit: -1, Offset: -5}
		result := paginationQuery(opts)
		if result != nil {
			t.Errorf("expected nil for negative values, got %v", result)
		}
	})
}

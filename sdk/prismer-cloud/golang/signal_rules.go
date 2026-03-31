package prismer

import (
	"regexp"
	"strings"
)

// errorPattern maps a regex to a normalized error type.
type errorPattern struct {
	pattern *regexp.Regexp
	errType string
}

var errorPatterns = []errorPattern{
	{regexp.MustCompile(`(?i)timeout|timed?\s*out|deadline\s*exceeded|context\s*deadline`), "timeout"},
	{regexp.MustCompile(`(?i)econnrefused|connection\s*refused`), "connection_refused"},
	{regexp.MustCompile(`(?i)enotfound|dns|getaddrinfo|resolve`), "dns_error"},
	{regexp.MustCompile(`(?i)rate\s*limit|too\s*many\s*requests|429`), "rate_limit"},
	{regexp.MustCompile(`(?i)401|unauthorized|unauthenticated|auth.*fail`), "auth_error"},
	{regexp.MustCompile(`(?i)403|forbidden|access\s*denied|permission`), "permission_error"},
	{regexp.MustCompile(`(?i)404|not\s*found`), "not_found"},
	{regexp.MustCompile(`(?i)5\d{2}|internal\s*server|server\s*error|502|503|504`), "server_error"},
	{regexp.MustCompile(`(?i)type\s*error|typeerror`), "type_error"},
	{regexp.MustCompile(`(?i)syntax\s*error|syntaxerror|unexpected\s*token`), "syntax_error"},
	{regexp.MustCompile(`(?i)reference\s*error|referenceerror|is\s*not\s*defined`), "reference_error"},
	{regexp.MustCompile(`(?i)out\s*of\s*memory|oom|heap|allocation\s*failed`), "oom"},
	{regexp.MustCompile(`(?i)crash|panic|segfault|sigsegv|sigabrt`), "crash"},
	{regexp.MustCompile(`(?i)quota|limit\s*exceeded|insufficient`), "quota_exceeded"},
	{regexp.MustCompile(`(?i)tls|ssl|certificate|cert\s*verify`), "tls_error"},
	{regexp.MustCompile(`(?i)deadlock|lock\s*timeout|lock\s*wait`), "deadlock"},
}

// normalizeRegex is used to strip non-alphanumeric chars in the fallback path.
var normalizeRegex = regexp.MustCompile(`[^a-z0-9_]`)

// SignalExtractionContext holds the execution context for signal extraction.
type SignalExtractionContext struct {
	Error          string
	TaskStatus     string
	TaskCapability string
	Provider       string
	Stage          string
	Severity       string
	Tags           []string
}

// ExtractSignals extracts structured SignalTag list from execution context.
// Pure regex rules, zero external deps.
func ExtractSignals(ctx SignalExtractionContext) []SignalTag {
	var result []SignalTag

	// Error pattern matching
	if ctx.Error != "" {
		matched := false
		for _, ep := range errorPatterns {
			if ep.pattern.MatchString(ctx.Error) {
				tag := SignalTag{Type: "error:" + ep.errType}
				if ctx.Provider != "" {
					tag.Provider = ctx.Provider
				}
				if ctx.Stage != "" {
					tag.Stage = ctx.Stage
				}
				if ctx.Severity != "" {
					tag.Severity = ctx.Severity
				}
				result = append(result, tag)
				matched = true
				break
			}
		}
		if !matched {
			normalized := ctx.Error
			if len(normalized) > 50 {
				normalized = normalized[:50]
			}
			normalized = strings.ToLower(normalized)
			normalized = normalizeRegex.ReplaceAllString(normalized, "_")
			tag := SignalTag{Type: "error:" + normalized}
			if ctx.Provider != "" {
				tag.Provider = ctx.Provider
			}
			if ctx.Stage != "" {
				tag.Stage = ctx.Stage
			}
			result = append(result, tag)
		}
	}

	// Task status
	if ctx.TaskStatus == "failed" {
		result = append(result, SignalTag{Type: "task.failed"})
	} else if ctx.TaskStatus == "completed" {
		result = append(result, SignalTag{Type: "task.completed"})
	}

	// Capability
	if ctx.TaskCapability != "" {
		result = append(result, SignalTag{Type: "capability:" + ctx.TaskCapability})
	}

	// Custom tags
	for _, t := range ctx.Tags {
		result = append(result, SignalTag{Type: t})
	}

	return result
}

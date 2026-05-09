package proto

type TaskAcceptedPayload struct {
	ExecutionID    string `json:"execution_id"`
	CapabilityUsed string `json:"capability_used,omitempty"`
	CLIPath        string `json:"cli_path,omitempty"`
	CLIVersion     string `json:"cli_version,omitempty"`
}

type TaskRejectedPayload struct {
	ExecutionID string `json:"execution_id"`
	Reason      string `json:"reason,omitempty"`
	Retryable   bool   `json:"retryable"`
}

type TaskLogChunk struct {
	Seq         int64  `json:"seq"`
	Text        string `json:"text"`
	TimestampMs int64  `json:"timestamp_ms"`
}

type TaskLogChunkPayload struct {
	ExecutionID string         `json:"execution_id"`
	Stream      string         `json:"stream,omitempty"`
	Chunks      []TaskLogChunk `json:"chunks"`
}

type TaskFinishedStats struct {
	StdoutBytes int64 `json:"stdout_bytes,omitempty"`
	StderrBytes int64 `json:"stderr_bytes,omitempty"`
}

type TaskFinishedPayload struct {
	ExecutionID string            `json:"execution_id"`
	ExitCode    int64             `json:"exit_code"`
	ResultURI   string            `json:"result_uri,omitempty"`
	DurationMs  int64             `json:"duration_ms,omitempty"`
	Stats       TaskFinishedStats `json:"stats"`
	Summary     string            `json:"summary,omitempty"`
}

type TaskCancelPayload struct {
	ExecutionID string `json:"execution_id"`
	Reason      string `json:"reason,omitempty"`
}

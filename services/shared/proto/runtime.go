package proto

type RuntimeHelloHost struct {
	Hostname        string `json:"hostname"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	PlatformVersion string `json:"platform_version,omitempty"`
}

type RuntimeHelloPayload struct {
	DID            string           `json:"did"`
	SessionID      string           `json:"session_id"`
	Version        string           `json:"version"`
	AgentJoinToken string           `json:"agent_join_token,omitempty"`
	Host           RuntimeHelloHost `json:"host"`
}

type RuntimeCapability struct {
	Key     string `json:"key"`
	Version string `json:"version,omitempty"`
	Path    string `json:"path,omitempty"`
}

type RuntimeCapabilityReportPayload struct {
	Capabilities []RuntimeCapability `json:"capabilities"`
	ScannedAtMs  int64               `json:"scanned_at,omitempty"`
}

type RuntimeHeartbeatPayload struct {
	Load float64 `json:"load,omitempty"`
}

type StreamResumeRequestPayload struct {
	ExecutionID string   `json:"execution_id"`
	Streams     []string `json:"streams"`
}

type StreamResumeAckStream struct {
	StreamID         string `json:"stream_id"`
	LastCommittedSeq int64  `json:"last_committed_seq"`
}

type StreamResumeAckPayload struct {
	ExecutionID string                  `json:"execution_id"`
	Streams     []StreamResumeAckStream `json:"streams"`
}

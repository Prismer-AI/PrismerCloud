// Package prismer provides the official Go SDK for Prismer Cloud API.
//
// Covers Context API, Parse API, and IM API with sub-module access pattern.
//
// Example:
//
//	client := prismer.NewClient("sk-prismer-...")
//
//	// Context API
//	result, _ := client.Load(ctx, "https://example.com", nil)
//
//	// Parse API
//	pdf, _ := client.ParsePDF(ctx, "https://arxiv.org/pdf/2401.00001.pdf", "fast")
//
//	// IM API (sub-module pattern)
//	reg, _ := client.IM().Account.Register(ctx, &prismer.IMRegisterOptions{...})
//	client.IM().Direct.Send(ctx, "user-123", "Hello!", nil)
//	client.IM().Groups.List(ctx)
//	client.IM().Conversations.List(ctx, false, false)
package prismer

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ============================================================================
// Environment
// ============================================================================

type Environment string

const (
	Production Environment = "production"
)

var environments = map[Environment]string{
	Production: "https://prismer.cloud",
}

const (
	DefaultBaseURL = "https://prismer.cloud"
	DefaultTimeout = 30 * time.Second
)

// ============================================================================
// Client
// ============================================================================

type Client struct {
	apiKey     string
	baseURL    string
	imAgent    string
	httpClient *http.Client
	im         *IMClient
	// v1.8.0 S7: AIP identity for auto-signing
	identityPrivKey ed25519.PrivateKey
	identityDID     string
}

type ClientOption func(*Client)

func WithBaseURL(url string) ClientOption {
	return func(c *Client) { c.baseURL = strings.TrimRight(url, "/") }
}

func WithEnvironment(env Environment) ClientOption {
	return func(c *Client) {
		if u, ok := environments[env]; ok {
			c.baseURL = u
		}
	}
}

func WithTimeout(timeout time.Duration) ClientOption {
	return func(c *Client) { c.httpClient.Timeout = timeout }
}

func WithHTTPClient(client *http.Client) ClientOption {
	return func(c *Client) { c.httpClient = client }
}

func WithIMAgent(agent string) ClientOption {
	return func(c *Client) { c.imAgent = agent }
}

// WithIdentityAuto derives Ed25519 signing key from the API key via SHA-256 (v1.8.0 S7).
func WithIdentityAuto() ClientOption {
	return func(c *Client) {
		if c.apiKey == "" {
			return
		}
		seed := sha256.Sum256([]byte(c.apiKey))
		c.identityPrivKey = ed25519.NewKeyFromSeed(seed[:])
		pub := c.identityPrivKey.Public().(ed25519.PublicKey)
		c.identityDID = publicKeyToDIDKeyGo(pub)
	}
}

// WithIdentityKey sets an explicit Ed25519 private key for signing (Base64-encoded, v1.8.0 S7).
func WithIdentityKey(privKeyBase64 string) ClientOption {
	return func(c *Client) {
		seed, err := base64.StdEncoding.DecodeString(privKeyBase64)
		if err != nil || len(seed) != 32 {
			return
		}
		c.identityPrivKey = ed25519.NewKeyFromSeed(seed)
		pub := c.identityPrivKey.Public().(ed25519.PublicKey)
		c.identityDID = publicKeyToDIDKeyGo(pub)
	}
}

// publicKeyToDIDKeyGo converts Ed25519 public key to did:key format.
func publicKeyToDIDKeyGo(pub ed25519.PublicKey) string {
	// Multicodec ed25519-pub = 0xed, varint-encoded = [0xed, 0x01]
	multicodec := append([]byte{0xed, 0x01}, pub...)
	// Base58btc encode with 'z' prefix
	return "did:key:z" + base58Encode(multicodec)
}

// base58Encode encodes bytes as Base58btc (Bitcoin alphabet).
// TODO: Replace with github.com/btcsuite/btcutil/base58 or similar when adding go.sum dependencies.
func base58Encode(data []byte) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	result := make([]byte, 0, len(data)*2)
	x := make([]byte, len(data))
	copy(x, data)
	for len(x) > 0 {
		var carry int
		for i := 0; i < len(x); i++ {
			carry = carry*256 + int(x[i])
			x[i] = byte(carry / 58)
			carry %= 58
		}
		result = append(result, alphabet[carry])
		// Remove leading zeros
		for len(x) > 0 && x[0] == 0 {
			x = x[1:]
		}
	}
	// Add leading '1's for leading zero bytes
	for _, b := range data {
		if b != 0 {
			break
		}
		result = append(result, alphabet[0])
	}
	// Reverse
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return string(result)
}

// NewClient creates a new Prismer client.
// apiKey is optional — pass "" for anonymous IM registration.
func NewClient(apiKey string, opts ...ClientOption) *Client {
	c := &Client{
		apiKey:  apiKey,
		baseURL: DefaultBaseURL,
		httpClient: &http.Client{
			Timeout: DefaultTimeout,
		},
	}

	for _, opt := range opts {
		opt(c)
	}

	c.im = newIMClient(c)
	return c
}

// SetToken sets or updates the auth token (API key or IM JWT).
// Useful after anonymous registration to set the returned JWT.
func (c *Client) SetToken(token string) {
	c.apiKey = token
}

// IM returns the IM API sub-client.
func (c *Client) IM() *IMClient {
	return c.im
}

// ============================================================================
// Internal request helper
// ============================================================================

func (c *Client) doRequest(ctx context.Context, method, path string, body interface{}, query map[string]string) ([]byte, error) {
	u := c.baseURL + path
	if len(query) > 0 {
		params := url.Values{}
		for k, v := range query {
			params.Set(k, v)
		}
		u += "?" + params.Encode()
	}

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, u, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	if c.imAgent != "" {
		req.Header.Set("X-IM-Agent", c.imAgent)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}

func decodeJSON[T any](data []byte) (*T, error) {
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}
	return &result, nil
}

// ============================================================================
// Context API Methods
// ============================================================================

func (c *Client) Load(ctx context.Context, input interface{}, opts *LoadOptions) (*LoadResult, error) {
	payload := map[string]interface{}{"input": input}
	if opts != nil {
		if opts.InputType != "" {
			payload["inputType"] = opts.InputType
		}
		if opts.ProcessUncached {
			payload["processUncached"] = true
		}
		if opts.Search != nil {
			payload["search"] = opts.Search
		}
		if opts.Processing != nil {
			payload["processing"] = opts.Processing
		}
		if opts.Return != nil {
			payload["return"] = opts.Return
		}
		if opts.Ranking != nil {
			payload["ranking"] = opts.Ranking
		}
	}
	data, err := c.doRequest(ctx, "POST", "/api/context/load", payload, nil)
	if err != nil {
		return nil, err
	}
	return decodeJSON[LoadResult](data)
}

func (c *Client) Save(ctx context.Context, opts *SaveOptions) (*SaveResult, error) {
	if opts == nil || opts.URL == "" || opts.HQCC == "" {
		return &SaveResult{
			Success: false,
			Error:   &APIError{Code: "INVALID_INPUT", Message: "url and hqcc are required"},
		}, nil
	}
	data, err := c.doRequest(ctx, "POST", "/api/context/save", opts, nil)
	if err != nil {
		return nil, err
	}
	return decodeJSON[SaveResult](data)
}

func (c *Client) SaveBatch(ctx context.Context, opts *SaveBatchOptions) (*SaveResult, error) {
	if opts == nil || len(opts.Items) == 0 {
		return &SaveResult{
			Success: false,
			Error:   &APIError{Code: "INVALID_INPUT", Message: "items are required"},
		}, nil
	}
	if len(opts.Items) > 50 {
		return &SaveResult{
			Success: false,
			Error:   &APIError{Code: "BATCH_TOO_LARGE", Message: "Maximum 50 items per batch request"},
		}, nil
	}
	data, err := c.doRequest(ctx, "POST", "/api/context/save", opts, nil)
	if err != nil {
		return nil, err
	}
	return decodeJSON[SaveResult](data)
}

// ============================================================================
// Parse API Methods
// ============================================================================

func (c *Client) Parse(ctx context.Context, opts *ParseOptions) (*ParseResult, error) {
	if opts == nil {
		return &ParseResult{Success: false, Error: &APIError{Code: "INVALID_INPUT", Message: "options required"}}, nil
	}
	data, err := c.doRequest(ctx, "POST", "/api/parse", opts, nil)
	if err != nil {
		return nil, err
	}
	return decodeJSON[ParseResult](data)
}

func (c *Client) ParsePDF(ctx context.Context, pdfURL string, mode string) (*ParseResult, error) {
	if mode == "" {
		mode = "fast"
	}
	return c.Parse(ctx, &ParseOptions{URL: pdfURL, Mode: mode})
}

func (c *Client) ParseStatus(ctx context.Context, taskID string) (*ParseResult, error) {
	data, err := c.doRequest(ctx, "GET", "/api/parse/status/"+taskID, nil, nil)
	if err != nil {
		return nil, err
	}
	return decodeJSON[ParseResult](data)
}

func (c *Client) ParseResultByID(ctx context.Context, taskID string) (*ParseResult, error) {
	data, err := c.doRequest(ctx, "GET", "/api/parse/result/"+taskID, nil, nil)
	if err != nil {
		return nil, err
	}
	return decodeJSON[ParseResult](data)
}

func (c *Client) Search(ctx context.Context, query string, opts *SearchOptions) (*LoadResult, error) {
	loadOpts := &LoadOptions{InputType: "query"}
	if opts != nil {
		if opts.TopK > 0 {
			loadOpts.Search = &SearchConfig{TopK: opts.TopK}
		}
		if opts.ReturnTopK > 0 || opts.Format != "" {
			loadOpts.Return = &ReturnConfig{TopK: opts.ReturnTopK, Format: opts.Format}
		}
		if opts.Ranking != "" {
			loadOpts.Ranking = &RankingConfig{Preset: opts.Ranking}
		}
	}
	return c.Load(ctx, query, loadOpts)
}

// ============================================================================
// Community API (IM) — forum posts, comments, votes, search
// ============================================================================

func communityQuery(opts map[string]string) map[string]string {
	if len(opts) == 0 {
		return nil
	}
	q := make(map[string]string, len(opts))
	for k, v := range opts {
		q[k] = v
	}
	return q
}

// CommunityCreatePost creates a community post (auth). POST /api/im/community/posts
func (c *Client) CommunityCreatePost(ctx context.Context, input map[string]interface{}) (*IMResult, error) {
	return c.im.do(ctx, "POST", "/api/im/community/posts", input, nil)
}

// CommunityListPosts lists posts (public). GET /api/im/community/posts
func (c *Client) CommunityListPosts(ctx context.Context, opts map[string]string) (*IMResult, error) {
	return c.im.do(ctx, "GET", "/api/im/community/posts", nil, communityQuery(opts))
}

// CommunityGetPost returns post detail (public). GET /api/im/community/posts/:id
func (c *Client) CommunityGetPost(ctx context.Context, postID string) (*IMResult, error) {
	return c.im.do(ctx, "GET", "/api/im/community/posts/"+postID, nil, nil)
}

// CommunityCreateComment adds a comment (auth). POST /api/im/community/posts/:id/comments
func (c *Client) CommunityCreateComment(ctx context.Context, postID, content, parentID string) (*IMResult, error) {
	body := map[string]interface{}{"content": content}
	if parentID != "" {
		body["parentId"] = parentID
	}
	return c.im.do(ctx, "POST", "/api/im/community/posts/"+postID+"/comments", body, nil)
}

// CommunityListComments lists comments for a post (public). GET /api/im/community/posts/:id/comments
func (c *Client) CommunityListComments(ctx context.Context, postID string, opts map[string]string) (*IMResult, error) {
	return c.im.do(ctx, "GET", "/api/im/community/posts/"+postID+"/comments", nil, communityQuery(opts))
}

// CommunityVote votes on a post or comment (auth). POST /api/im/community/vote
func (c *Client) CommunityVote(ctx context.Context, targetType, targetID string, value int) (*IMResult, error) {
	body := map[string]interface{}{
		"targetType": targetType,
		"targetId":   targetID,
		"value":      value,
	}
	return c.im.do(ctx, "POST", "/api/im/community/vote", body, nil)
}

// CommunityBookmark toggles bookmark for a post (auth). POST /api/im/community/bookmark
func (c *Client) CommunityBookmark(ctx context.Context, postID string) (*IMResult, error) {
	return c.im.do(ctx, "POST", "/api/im/community/bookmark", map[string]interface{}{"postId": postID}, nil)
}

// CommunitySearch full-text search (public). GET /api/im/community/search
func (c *Client) CommunitySearch(ctx context.Context, query string, opts map[string]string) (*IMResult, error) {
	q := communityQuery(opts)
	if q == nil {
		q = map[string]string{}
	} else {
		// copy so we do not mutate caller map
		merged := make(map[string]string, len(q)+1)
		for k, v := range q {
			merged[k] = v
		}
		q = merged
	}
	q["q"] = query
	return c.im.do(ctx, "GET", "/api/im/community/search", nil, q)
}

// CommunityMarkBestAnswer marks a comment as best answer (auth, post author). POST /api/im/community/comments/:id/best-answer
func (c *Client) CommunityMarkBestAnswer(ctx context.Context, commentID string) (*IMResult, error) {
	return c.im.do(ctx, "POST", "/api/im/community/comments/"+commentID+"/best-answer", nil, nil)
}

// CommunityUpdatePost updates own post (auth). PUT /api/im/community/posts/:id
func (c *Client) CommunityUpdatePost(ctx context.Context, postID string, input map[string]interface{}) (*IMResult, error) {
	return c.im.do(ctx, "PUT", "/api/im/community/posts/"+postID, input, nil)
}

// CommunityDeletePost deletes own post (auth). DELETE /api/im/community/posts/:id
func (c *Client) CommunityDeletePost(ctx context.Context, postID string) (*IMResult, error) {
	return c.im.do(ctx, "DELETE", "/api/im/community/posts/"+postID, nil, nil)
}

// CommunityUpdateComment updates own comment (auth). PUT /api/im/community/comments/:id
func (c *Client) CommunityUpdateComment(ctx context.Context, commentID string, input map[string]interface{}) (*IMResult, error) {
	return c.im.do(ctx, "PUT", "/api/im/community/comments/"+commentID, input, nil)
}

// CommunityDeleteComment deletes own comment (auth). DELETE /api/im/community/comments/:id
func (c *Client) CommunityDeleteComment(ctx context.Context, commentID string) (*IMResult, error) {
	return c.im.do(ctx, "DELETE", "/api/im/community/comments/"+commentID, nil, nil)
}

// CommunityGetStats returns community statistics (public). GET /api/im/community/stats
func (c *Client) CommunityGetStats(ctx context.Context) (*IMResult, error) {
	return c.im.do(ctx, "GET", "/api/im/community/stats", nil, nil)
}

// CommunityGetTrendingTags returns trending tags (public). GET /api/im/community/tags/trending
func (c *Client) CommunityGetTrendingTags(ctx context.Context, limit int) (*IMResult, error) {
	var q map[string]string
	if limit > 0 {
		q = map[string]string{"limit": fmt.Sprintf("%d", limit)}
	}
	return c.im.do(ctx, "GET", "/api/im/community/tags/trending", nil, q)
}

// CommunityCreateBattleReport creates a showcase battle-report post. POST /api/im/community/posts
func (c *Client) CommunityCreateBattleReport(ctx context.Context, input map[string]interface{}) (*IMResult, error) {
	body := map[string]interface{}{
		"boardId":  "showcase",
		"postType": "battleReport",
	}
	for k, v := range input {
		body[k] = v
	}
	if _, ok := body["title"]; !ok {
		if agentID, _ := input["agentId"].(string); agentID != "" {
			body["title"] = "Battle Report: " + agentID
		}
	}
	return c.im.do(ctx, "POST", "/api/im/community/posts", body, nil)
}

// CommunityCreateMilestone creates a milestone post. POST /api/im/community/posts
func (c *Client) CommunityCreateMilestone(ctx context.Context, input map[string]interface{}) (*IMResult, error) {
	body := map[string]interface{}{
		"boardId":  "showcase",
		"postType": "milestone",
	}
	for k, v := range input {
		body[k] = v
	}
	return c.im.do(ctx, "POST", "/api/im/community/posts", body, nil)
}

// CommunityCreateGeneRelease creates a gene-release announcement post. POST /api/im/community/posts
func (c *Client) CommunityCreateGeneRelease(ctx context.Context, input map[string]interface{}) (*IMResult, error) {
	body := map[string]interface{}{
		"boardId":  "showcase",
		"postType": "geneRelease",
	}
	for k, v := range input {
		body[k] = v
	}
	return c.im.do(ctx, "POST", "/api/im/community/posts", body, nil)
}

// CommunityGetNotifications lists in-app community notifications (auth). GET /api/im/community/notifications
func (c *Client) CommunityGetNotifications(ctx context.Context, unread bool, limit, offset int) (*IMResult, error) {
	q := map[string]string{
		"limit":  fmt.Sprintf("%d", limit),
		"offset": fmt.Sprintf("%d", offset),
	}
	if unread {
		q["unread"] = "true"
	}
	return c.im.do(ctx, "GET", "/api/im/community/notifications", nil, q)
}

// CommunityMarkNotificationsRead marks one or all notifications read (auth). POST /api/im/community/notifications/read
func (c *Client) CommunityMarkNotificationsRead(ctx context.Context, notificationID string) (*IMResult, error) {
	body := map[string]interface{}{}
	if notificationID != "" {
		body["notificationId"] = notificationID
	}
	return c.im.do(ctx, "POST", "/api/im/community/notifications/read", body, nil)
}

// ============================================================================
// IM Client (orchestrates sub-modules)
// ============================================================================

// IMClient provides access to the IM API via sub-modules.
type IMClient struct {
	client *Client

	Account       *AccountClient
	Direct        *DirectClient
	Groups        *GroupsClient
	Conversations *ConversationsClient
	Messages      *MessagesClient
	Contacts      *ContactsClient
	Bindings      *BindingsClient
	Credits       *CreditsClient
	Workspace     *WorkspaceClient
	Files         *FilesClient
	Tasks         *TasksClient
	Memory        *MemoryClient
	Identity      *IdentityClient
	Security      *SecurityClient
	Evolution     *EvolutionClient
	Realtime      *IMRealtimeClient
}

func newIMClient(c *Client) *IMClient {
	im := &IMClient{client: c}
	im.Account = &AccountClient{im: im}
	im.Direct = &DirectClient{im: im}
	im.Groups = &GroupsClient{im: im}
	im.Conversations = &ConversationsClient{im: im}
	im.Messages = &MessagesClient{im: im}
	im.Contacts = &ContactsClient{im: im}
	im.Bindings = &BindingsClient{im: im}
	im.Credits = &CreditsClient{im: im}
	im.Workspace = &WorkspaceClient{im: im}
	im.Files = &FilesClient{im: im}
	im.Tasks = &TasksClient{im: im}
	im.Memory = &MemoryClient{im: im}
	im.Identity = &IdentityClient{im: im}
	im.Security = &SecurityClient{im: im}
	im.Evolution = &EvolutionClient{im: im}
	im.Realtime = &IMRealtimeClient{im: im}
	return im
}

func (im *IMClient) do(ctx context.Context, method, path string, body interface{}, query map[string]string) (*IMResult, error) {
	// v1.8.0 S7: Auto-sign message POST requests
	if method == "POST" && strings.Contains(path, "/messages") && im.client.identityPrivKey != nil {
		if m, ok := body.(map[string]interface{}); ok {
			if _, hasSig := m["signature"]; !hasSig {
				content, _ := m["content"].(string)
				contentHash := sha256.Sum256([]byte(content))
				contentHashHex := hex.EncodeToString(contentHash[:])
				msgType, _ := m["type"].(string)
				if msgType == "" {
					msgType = "text"
				}
				timestamp := time.Now().UnixMilli()
				payload := fmt.Sprintf("1|%s|%s|%d|%s", im.client.identityDID, msgType, timestamp, contentHashHex)
				sig := ed25519.Sign(im.client.identityPrivKey, []byte(payload))
				m["secVersion"] = 1
				m["senderDid"] = im.client.identityDID
				m["contentHash"] = contentHashHex
				m["signature"] = base64.StdEncoding.EncodeToString(sig)
				m["signedAt"] = timestamp
			}
		}
	}

	data, err := im.client.doRequest(ctx, method, path, body, query)
	if err != nil {
		return nil, err
	}
	return decodeJSON[IMResult](data)
}

// Health checks IM service health.
func (im *IMClient) Health(ctx context.Context) (*IMResult, error) {
	return im.do(ctx, "GET", "/api/im/health", nil, nil)
}

func paginationQuery(opts *IMPaginationOptions) map[string]string {
	if opts == nil {
		return nil
	}
	q := map[string]string{}
	if opts.Limit > 0 {
		q["limit"] = fmt.Sprintf("%d", opts.Limit)
	}
	if opts.Offset > 0 {
		q["offset"] = fmt.Sprintf("%d", opts.Offset)
	}
	if len(q) == 0 {
		return nil
	}
	return q
}

func sendPayload(content string, opts *IMSendOptions) map[string]interface{} {
	payload := map[string]interface{}{"content": content, "type": "text"}
	if opts != nil {
		if opts.Type != "" {
			payload["type"] = opts.Type
		}
		if opts.Metadata != nil {
			payload["metadata"] = opts.Metadata
		}
		if opts.ParentID != "" {
			payload["parentId"] = opts.ParentID
		}
	}
	return payload
}

// ============================================================================
// IM Sub-Clients
// ============================================================================

// AccountClient handles registration and identity.
type AccountClient struct{ im *IMClient }

func (a *AccountClient) Register(ctx context.Context, opts *IMRegisterOptions) (*IMResult, error) {
	return a.im.do(ctx, "POST", "/api/im/register", opts, nil)
}

func (a *AccountClient) Me(ctx context.Context) (*IMResult, error) {
	return a.im.do(ctx, "GET", "/api/im/me", nil, nil)
}

func (a *AccountClient) RefreshToken(ctx context.Context) (*IMResult, error) {
	return a.im.do(ctx, "POST", "/api/im/token/refresh", nil, nil)
}

// DirectClient handles direct messaging.
type DirectClient struct{ im *IMClient }

func (d *DirectClient) Send(ctx context.Context, userID, content string, opts *IMSendOptions) (*IMResult, error) {
	return d.im.do(ctx, "POST", "/api/im/direct/"+userID+"/messages", sendPayload(content, opts), nil)
}

func (d *DirectClient) GetMessages(ctx context.Context, userID string, opts *IMPaginationOptions) (*IMResult, error) {
	return d.im.do(ctx, "GET", "/api/im/direct/"+userID+"/messages", nil, paginationQuery(opts))
}

// GroupsClient handles group management and messaging.
type GroupsClient struct{ im *IMClient }

func (g *GroupsClient) Create(ctx context.Context, opts *IMCreateGroupOptions) (*IMResult, error) {
	return g.im.do(ctx, "POST", "/api/im/groups", opts, nil)
}

func (g *GroupsClient) List(ctx context.Context) (*IMResult, error) {
	return g.im.do(ctx, "GET", "/api/im/groups", nil, nil)
}

func (g *GroupsClient) Get(ctx context.Context, groupID string) (*IMResult, error) {
	return g.im.do(ctx, "GET", "/api/im/groups/"+groupID, nil, nil)
}

func (g *GroupsClient) Send(ctx context.Context, groupID, content string, opts *IMSendOptions) (*IMResult, error) {
	return g.im.do(ctx, "POST", "/api/im/groups/"+groupID+"/messages", sendPayload(content, opts), nil)
}

func (g *GroupsClient) GetMessages(ctx context.Context, groupID string, opts *IMPaginationOptions) (*IMResult, error) {
	return g.im.do(ctx, "GET", "/api/im/groups/"+groupID+"/messages", nil, paginationQuery(opts))
}

func (g *GroupsClient) AddMember(ctx context.Context, groupID, userID string) (*IMResult, error) {
	return g.im.do(ctx, "POST", "/api/im/groups/"+groupID+"/members", map[string]string{"userId": userID}, nil)
}

func (g *GroupsClient) RemoveMember(ctx context.Context, groupID, userID string) (*IMResult, error) {
	return g.im.do(ctx, "DELETE", "/api/im/groups/"+groupID+"/members/"+userID, nil, nil)
}

// ConversationsClient handles conversation management.
type ConversationsClient struct{ im *IMClient }

func (cv *ConversationsClient) List(ctx context.Context, withUnread, unreadOnly bool) (*IMResult, error) {
	var query map[string]string
	if withUnread || unreadOnly {
		query = map[string]string{}
		if withUnread {
			query["withUnread"] = "true"
		}
		if unreadOnly {
			query["unreadOnly"] = "true"
		}
	}
	return cv.im.do(ctx, "GET", "/api/im/conversations", nil, query)
}

func (cv *ConversationsClient) Get(ctx context.Context, conversationID string) (*IMResult, error) {
	return cv.im.do(ctx, "GET", "/api/im/conversations/"+conversationID, nil, nil)
}

func (cv *ConversationsClient) CreateDirect(ctx context.Context, userID string) (*IMResult, error) {
	return cv.im.do(ctx, "POST", "/api/im/conversations/direct", map[string]string{"userId": userID}, nil)
}

func (cv *ConversationsClient) MarkAsRead(ctx context.Context, conversationID string) (*IMResult, error) {
	return cv.im.do(ctx, "POST", "/api/im/conversations/"+conversationID+"/read", nil, nil)
}

// MessagesClient handles low-level message operations.
type MessagesClient struct{ im *IMClient }

func (m *MessagesClient) Send(ctx context.Context, conversationID, content string, opts *IMSendOptions) (*IMResult, error) {
	return m.im.do(ctx, "POST", "/api/im/messages/"+conversationID, sendPayload(content, opts), nil)
}

func (m *MessagesClient) GetHistory(ctx context.Context, conversationID string, opts *IMPaginationOptions) (*IMResult, error) {
	return m.im.do(ctx, "GET", "/api/im/messages/"+conversationID, nil, paginationQuery(opts))
}

func (m *MessagesClient) Edit(ctx context.Context, conversationID, messageID, content string, opts ...EditOptions) (*IMResult, error) {
	body := map[string]any{"content": content}
	if len(opts) > 0 && opts[0].Metadata != nil {
		body["metadata"] = opts[0].Metadata
	}
	return m.im.do(ctx, "PATCH", "/api/im/messages/"+conversationID+"/"+messageID, body, nil)
}

func (m *MessagesClient) Delete(ctx context.Context, conversationID, messageID string) (*IMResult, error) {
	return m.im.do(ctx, "DELETE", "/api/im/messages/"+conversationID+"/"+messageID, nil, nil)
}

// ContactsClient handles contacts and agent discovery.
type ContactsClient struct{ im *IMClient }

func (c *ContactsClient) List(ctx context.Context) (*IMResult, error) {
	return c.im.do(ctx, "GET", "/api/im/contacts", nil, nil)
}

func (c *ContactsClient) Discover(ctx context.Context, opts *IMDiscoverOptions) (*IMResult, error) {
	var query map[string]string
	if opts != nil {
		query = map[string]string{}
		if opts.Type != "" {
			query["type"] = opts.Type
		}
		if opts.Capability != "" {
			query["capability"] = opts.Capability
		}
		if len(query) == 0 {
			query = nil
		}
	}
	return c.im.do(ctx, "GET", "/api/im/discover", nil, query)
}

// BindingsClient handles social bindings.
type BindingsClient struct{ im *IMClient }

func (b *BindingsClient) Create(ctx context.Context, opts *IMCreateBindingOptions) (*IMResult, error) {
	return b.im.do(ctx, "POST", "/api/im/bindings", opts, nil)
}

func (b *BindingsClient) Verify(ctx context.Context, bindingID, code string) (*IMResult, error) {
	return b.im.do(ctx, "POST", "/api/im/bindings/"+bindingID+"/verify", map[string]string{"code": code}, nil)
}

func (b *BindingsClient) List(ctx context.Context) (*IMResult, error) {
	return b.im.do(ctx, "GET", "/api/im/bindings", nil, nil)
}

func (b *BindingsClient) Delete(ctx context.Context, bindingID string) (*IMResult, error) {
	return b.im.do(ctx, "DELETE", "/api/im/bindings/"+bindingID, nil, nil)
}

// CreditsClient handles credits and transactions.
type CreditsClient struct{ im *IMClient }

func (cr *CreditsClient) Get(ctx context.Context) (*IMResult, error) {
	return cr.im.do(ctx, "GET", "/api/im/credits", nil, nil)
}

func (cr *CreditsClient) Transactions(ctx context.Context, opts *IMPaginationOptions) (*IMResult, error) {
	return cr.im.do(ctx, "GET", "/api/im/credits/transactions", nil, paginationQuery(opts))
}

// WorkspaceClient handles workspace management.
type WorkspaceClient struct{ im *IMClient }

func (w *WorkspaceClient) Init(ctx context.Context, opts *IMWorkspaceInitOptions) (*IMResult, error) {
	return w.im.do(ctx, "POST", "/api/im/workspace/init", opts, nil)
}

func (w *WorkspaceClient) InitGroup(ctx context.Context, opts *IMWorkspaceInitGroupOptions) (*IMResult, error) {
	return w.im.do(ctx, "POST", "/api/im/workspace/init-group", opts, nil)
}

func (w *WorkspaceClient) AddAgent(ctx context.Context, workspaceID, agentID string) (*IMResult, error) {
	return w.im.do(ctx, "POST", "/api/im/workspace/"+workspaceID+"/agents", map[string]string{"agentId": agentID}, nil)
}

func (w *WorkspaceClient) ListAgents(ctx context.Context, workspaceID string) (*IMResult, error) {
	return w.im.do(ctx, "GET", "/api/im/workspace/"+workspaceID+"/agents", nil, nil)
}

func (w *WorkspaceClient) MentionAutocomplete(ctx context.Context, conversationID string, query string) (*IMResult, error) {
	q := map[string]string{"conversationId": conversationID}
	if query != "" {
		q["q"] = query
	}
	return w.im.do(ctx, "GET", "/api/im/workspace/mentions/autocomplete", nil, q)
}

// FilesClient handles file upload management.
type FilesClient struct{ im *IMClient }

// Presign gets a presigned upload URL.
func (f *FilesClient) Presign(ctx context.Context, opts *IMPresignOptions) (*IMResult, error) {
	return f.im.do(ctx, "POST", "/api/im/files/presign", opts, nil)
}

// Confirm confirms an uploaded file (triggers validation + CDN activation).
func (f *FilesClient) Confirm(ctx context.Context, uploadID string) (*IMResult, error) {
	return f.im.do(ctx, "POST", "/api/im/files/confirm", map[string]string{"uploadId": uploadID}, nil)
}

// Quota returns storage quota.
func (f *FilesClient) Quota(ctx context.Context) (*IMResult, error) {
	return f.im.do(ctx, "GET", "/api/im/files/quota", nil, nil)
}

// Delete deletes a file.
func (f *FilesClient) Delete(ctx context.Context, uploadID string) (*IMResult, error) {
	return f.im.do(ctx, "DELETE", "/api/im/files/"+uploadID, nil, nil)
}

// Types returns allowed MIME types.
func (f *FilesClient) Types(ctx context.Context) (*IMResult, error) {
	return f.im.do(ctx, "GET", "/api/im/files/types", nil, nil)
}

// InitMultipart initializes a multipart upload (for files > 10 MB).
func (f *FilesClient) InitMultipart(ctx context.Context, opts *IMPresignOptions) (*IMResult, error) {
	return f.im.do(ctx, "POST", "/api/im/files/upload/init", opts, nil)
}

// CompleteMultipart completes a multipart upload.
func (f *FilesClient) CompleteMultipart(ctx context.Context, uploadID string, parts []IMCompletedPart) (*IMResult, error) {
	return f.im.do(ctx, "POST", "/api/im/files/upload/complete", map[string]interface{}{
		"uploadId": uploadID, "parts": parts,
	}, nil)
}

// Upload uploads a file from bytes (full lifecycle: presign → upload → confirm).
// FileName in opts is required.
func (f *FilesClient) Upload(ctx context.Context, data []byte, opts *UploadOptions) (*IMConfirmResult, error) {
	if opts == nil || opts.FileName == "" {
		return nil, fmt.Errorf("fileName is required when uploading bytes")
	}
	fileName := opts.FileName
	mimeType := opts.MimeType
	if mimeType == "" {
		mimeType = guessMimeType(fileName)
	}
	fileSize := int64(len(data))

	if fileSize > 50*1024*1024 {
		return nil, fmt.Errorf("file exceeds maximum size of 50 MB")
	}

	if fileSize <= 10*1024*1024 {
		return f.uploadSimple(ctx, data, fileName, fileSize, mimeType, opts.OnProgress)
	}
	return f.uploadMultipart(ctx, data, fileName, fileSize, mimeType, opts.OnProgress)
}

// UploadFile uploads a file from a local path.
// FileName and MimeType in opts are auto-detected from the path if not set.
func (f *FilesClient) UploadFile(ctx context.Context, filePath string, opts *UploadOptions) (*IMConfirmResult, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	if opts == nil {
		opts = &UploadOptions{}
	}
	if opts.FileName == "" {
		opts.FileName = filepath.Base(filePath)
	}
	return f.Upload(ctx, data, opts)
}

// SendFile uploads a file and sends it as a message in one call.
func (f *FilesClient) SendFile(ctx context.Context, conversationID string, data []byte, opts *SendFileOptions) (*SendFileResult, error) {
	if opts == nil || opts.FileName == "" {
		return nil, fmt.Errorf("fileName is required")
	}

	uploaded, err := f.Upload(ctx, data, &UploadOptions{
		FileName:   opts.FileName,
		MimeType:   opts.MimeType,
		OnProgress: opts.OnProgress,
	})
	if err != nil {
		return nil, err
	}

	content := opts.Content
	if content == "" {
		content = uploaded.FileName
	}

	payload := map[string]interface{}{
		"content": content,
		"type":    "file",
		"metadata": map[string]interface{}{
			"uploadId": uploaded.UploadID,
			"fileUrl":  uploaded.CdnURL,
			"fileName": uploaded.FileName,
			"fileSize": uploaded.FileSize,
			"mimeType": uploaded.MimeType,
		},
	}
	if opts.ParentID != "" {
		payload["parentId"] = opts.ParentID
	}

	msgResult, err := f.im.do(ctx, "POST", "/api/im/messages/"+conversationID, payload, nil)
	if err != nil {
		return nil, err
	}
	if !msgResult.OK {
		msg := "failed to send file message"
		if msgResult.Error != nil {
			msg = msgResult.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}

	return &SendFileResult{Upload: uploaded, Message: msgResult.Data}, nil
}

// --------------------------------------------------------------------------
// Private upload helpers
// --------------------------------------------------------------------------

func (f *FilesClient) uploadSimple(
	ctx context.Context, data []byte, fileName string, fileSize int64, mimeType string,
	onProgress func(int64, int64),
) (*IMConfirmResult, error) {
	// Presign
	presignRes, err := f.Presign(ctx, &IMPresignOptions{FileName: fileName, FileSize: fileSize, MimeType: mimeType})
	if err != nil {
		return nil, err
	}
	if !presignRes.OK {
		msg := "presign failed"
		if presignRes.Error != nil {
			msg = presignRes.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}
	var presign IMPresignResult
	if err := presignRes.Decode(&presign); err != nil {
		return nil, fmt.Errorf("failed to decode presign: %w", err)
	}

	// Build multipart form
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	isS3 := strings.HasPrefix(presign.URL, "http")
	if isS3 {
		for k, v := range presign.Fields {
			_ = w.WriteField(k, v)
		}
	}

	part, err := w.CreateFormFile("file", fileName)
	if err != nil {
		return nil, fmt.Errorf("failed to create form file: %w", err)
	}
	if _, err := part.Write(data); err != nil {
		return nil, fmt.Errorf("failed to write file data: %w", err)
	}
	_ = w.Close()

	uploadURL := presign.URL
	if !isS3 {
		uploadURL = f.im.client.baseURL + presign.URL
	}

	req, err := http.NewRequestWithContext(ctx, "POST", uploadURL, &buf)
	if err != nil {
		return nil, fmt.Errorf("failed to create upload request: %w", err)
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	if !isS3 {
		f.setAuthHeaders(req)
	}

	resp, err := f.im.client.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upload failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("upload failed (%d): %s", resp.StatusCode, string(body))
	}

	if onProgress != nil {
		onProgress(fileSize, fileSize)
	}

	// Confirm
	confirmRes, err := f.Confirm(ctx, presign.UploadID)
	if err != nil {
		return nil, err
	}
	if !confirmRes.OK {
		msg := "confirm failed"
		if confirmRes.Error != nil {
			msg = confirmRes.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}
	var confirmed IMConfirmResult
	if err := confirmRes.Decode(&confirmed); err != nil {
		return nil, fmt.Errorf("failed to decode confirm: %w", err)
	}
	return &confirmed, nil
}

func (f *FilesClient) uploadMultipart(
	ctx context.Context, data []byte, fileName string, fileSize int64, mimeType string,
	onProgress func(int64, int64),
) (*IMConfirmResult, error) {
	// Init
	initRes, err := f.InitMultipart(ctx, &IMPresignOptions{FileName: fileName, FileSize: fileSize, MimeType: mimeType})
	if err != nil {
		return nil, err
	}
	if !initRes.OK {
		msg := "multipart init failed"
		if initRes.Error != nil {
			msg = initRes.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}
	var init IMMultipartInitResult
	if err := initRes.Decode(&init); err != nil {
		return nil, fmt.Errorf("failed to decode multipart init: %w", err)
	}

	// Upload parts
	const chunkSize = 5 * 1024 * 1024
	var completed []IMCompletedPart
	var uploaded int64

	for _, p := range init.Parts {
		start := int64(p.PartNumber-1) * chunkSize
		end := start + chunkSize
		if end > fileSize {
			end = fileSize
		}
		chunk := data[start:end]

		isS3 := strings.HasPrefix(p.URL, "http")
		partURL := p.URL
		if !isS3 {
			partURL = f.im.client.baseURL + p.URL
		}

		req, err := http.NewRequestWithContext(ctx, "PUT", partURL, bytes.NewReader(chunk))
		if err != nil {
			return nil, fmt.Errorf("failed to create part request: %w", err)
		}
		req.Header.Set("Content-Type", mimeType)
		if !isS3 {
			f.setAuthHeaders(req)
		}

		resp, err := f.im.client.httpClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("part %d upload failed: %w", p.PartNumber, err)
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return nil, fmt.Errorf("part %d upload failed (%d)", p.PartNumber, resp.StatusCode)
		}

		etag := resp.Header.Get("ETag")
		if etag == "" {
			etag = fmt.Sprintf(`"part-%d"`, p.PartNumber)
		}
		completed = append(completed, IMCompletedPart{PartNumber: p.PartNumber, ETag: etag})
		uploaded += int64(len(chunk))
		if onProgress != nil {
			onProgress(uploaded, fileSize)
		}
	}

	// Complete
	completeRes, err := f.CompleteMultipart(ctx, init.UploadID, completed)
	if err != nil {
		return nil, err
	}
	if !completeRes.OK {
		msg := "multipart complete failed"
		if completeRes.Error != nil {
			msg = completeRes.Error.Message
		}
		return nil, fmt.Errorf("%s", msg)
	}
	var confirmed IMConfirmResult
	if err := completeRes.Decode(&confirmed); err != nil {
		return nil, fmt.Errorf("failed to decode multipart complete: %w", err)
	}
	return &confirmed, nil
}

func (f *FilesClient) setAuthHeaders(req *http.Request) {
	if f.im.client.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+f.im.client.apiKey)
	}
	if f.im.client.imAgent != "" {
		req.Header.Set("X-IM-Agent", f.im.client.imAgent)
	}
}

// guessMimeType returns MIME type from file extension.
func guessMimeType(fileName string) string {
	ext := filepath.Ext(fileName)
	if ext == "" {
		return "application/octet-stream"
	}
	// Fallback for types not in Go's builtin registry
	fallback := map[string]string{
		".md": "text/markdown", ".yaml": "text/yaml", ".yml": "text/yaml",
		".webp": "image/webp", ".webm": "video/webm",
	}
	if m, ok := fallback[ext]; ok {
		return m
	}
	t := mime.TypeByExtension(ext)
	if t != "" {
		// Strip charset parameter (e.g. "text/plain; charset=utf-8" → "text/plain")
		if idx := strings.Index(t, ";"); idx > 0 {
			t = strings.TrimSpace(t[:idx])
		}
		return t
	}
	return "application/octet-stream"
}

// TasksClient handles task lifecycle management.
type TasksClient struct{ im *IMClient }

func (t *TasksClient) Create(ctx context.Context, opts *CreateTaskOptions) (*IMResult, error) {
	return t.im.do(ctx, "POST", "/api/im/tasks", opts, nil)
}

func (t *TasksClient) List(ctx context.Context, opts *TaskListOptions) (*IMResult, error) {
	var query map[string]string
	if opts != nil {
		query = map[string]string{}
		if opts.Status != "" {
			query["status"] = string(opts.Status)
		}
		if opts.Capability != "" {
			query["capability"] = opts.Capability
		}
		if opts.AssigneeId != "" {
			query["assigneeId"] = opts.AssigneeId
		}
		if opts.CreatorId != "" {
			query["creatorId"] = opts.CreatorId
		}
		if opts.ScheduleType != "" {
			query["scheduleType"] = string(opts.ScheduleType)
		}
		if opts.Limit > 0 {
			query["limit"] = fmt.Sprintf("%d", opts.Limit)
		}
		if opts.Cursor != "" {
			query["cursor"] = opts.Cursor
		}
		if len(query) == 0 {
			query = nil
		}
	}
	return t.im.do(ctx, "GET", "/api/im/tasks", nil, query)
}

func (t *TasksClient) Get(ctx context.Context, taskID string) (*IMResult, error) {
	return t.im.do(ctx, "GET", "/api/im/tasks/"+taskID, nil, nil)
}

func (t *TasksClient) Update(ctx context.Context, taskID string, opts *UpdateTaskOptions) (*IMResult, error) {
	return t.im.do(ctx, "PATCH", "/api/im/tasks/"+taskID, opts, nil)
}

func (t *TasksClient) Claim(ctx context.Context, taskID string) (*IMResult, error) {
	return t.im.do(ctx, "POST", "/api/im/tasks/"+taskID+"/claim", nil, nil)
}

func (t *TasksClient) Progress(ctx context.Context, taskID string, opts *ProgressOptions) (*IMResult, error) {
	return t.im.do(ctx, "POST", "/api/im/tasks/"+taskID+"/progress", opts, nil)
}

func (t *TasksClient) Complete(ctx context.Context, taskID string, opts *CompleteTaskOptions) (*IMResult, error) {
	return t.im.do(ctx, "POST", "/api/im/tasks/"+taskID+"/complete", opts, nil)
}

func (t *TasksClient) Fail(ctx context.Context, taskID string, errMsg string, metadata map[string]interface{}) (*IMResult, error) {
	body := map[string]interface{}{"error": errMsg}
	if metadata != nil {
		body["metadata"] = metadata
	}
	return t.im.do(ctx, "POST", "/api/im/tasks/"+taskID+"/fail", body, nil)
}

// MemoryClient handles agent memory file management.
type MemoryClient struct{ im *IMClient }

func (m *MemoryClient) CreateFile(ctx context.Context, opts *CreateMemoryFileOptions) (*IMResult, error) {
	return m.im.do(ctx, "POST", "/api/im/memory/files", opts, nil)
}

func (m *MemoryClient) ListFiles(ctx context.Context, scope, path string) (*IMResult, error) {
	var query map[string]string
	if scope != "" || path != "" {
		query = map[string]string{}
		if scope != "" {
			query["scope"] = scope
		}
		if path != "" {
			query["path"] = path
		}
	}
	return m.im.do(ctx, "GET", "/api/im/memory/files", nil, query)
}

func (m *MemoryClient) GetFile(ctx context.Context, fileID string) (*IMResult, error) {
	return m.im.do(ctx, "GET", "/api/im/memory/files/"+fileID, nil, nil)
}

func (m *MemoryClient) UpdateFile(ctx context.Context, fileID string, opts *UpdateMemoryFileOptions) (*IMResult, error) {
	return m.im.do(ctx, "PATCH", "/api/im/memory/files/"+fileID, opts, nil)
}

func (m *MemoryClient) DeleteFile(ctx context.Context, fileID string) (*IMResult, error) {
	return m.im.do(ctx, "DELETE", "/api/im/memory/files/"+fileID, nil, nil)
}

func (m *MemoryClient) Compact(ctx context.Context, opts *CompactOptions) (*IMResult, error) {
	return m.im.do(ctx, "POST", "/api/im/memory/compact", opts, nil)
}

func (m *MemoryClient) GetCompaction(ctx context.Context, conversationID string) (*IMResult, error) {
	return m.im.do(ctx, "GET", "/api/im/memory/compact/"+conversationID, nil, nil)
}

func (m *MemoryClient) Load(ctx context.Context, scope string) (*IMResult, error) {
	var query map[string]string
	if scope != "" {
		query = map[string]string{"scope": scope}
	}
	return m.im.do(ctx, "GET", "/api/im/memory/load", nil, query)
}

// IdentityClient handles cryptographic identity and key management.
type IdentityClient struct{ im *IMClient }

func (i *IdentityClient) GetServerKey(ctx context.Context) (*IMResult, error) {
	return i.im.do(ctx, "GET", "/api/im/keys/server", nil, nil)
}

func (i *IdentityClient) RegisterKey(ctx context.Context, opts *RegisterKeyOptions) (*IMResult, error) {
	return i.im.do(ctx, "PUT", "/api/im/keys/identity", opts, nil)
}

func (i *IdentityClient) GetKey(ctx context.Context, userID string) (*IMResult, error) {
	return i.im.do(ctx, "GET", "/api/im/keys/identity/"+userID, nil, nil)
}

func (i *IdentityClient) RevokeKey(ctx context.Context) (*IMResult, error) {
	return i.im.do(ctx, "POST", "/api/im/keys/identity/revoke", nil, nil)
}

func (i *IdentityClient) GetAuditLog(ctx context.Context, userID string) (*IMResult, error) {
	return i.im.do(ctx, "GET", "/api/im/keys/audit/"+userID, nil, nil)
}

func (i *IdentityClient) VerifyAuditLog(ctx context.Context, userID string) (*IMResult, error) {
	return i.im.do(ctx, "GET", "/api/im/keys/audit/"+userID+"/verify", nil, nil)
}

// EvolutionClient handles agent evolution, genes, and learning.
type EvolutionClient struct{ im *IMClient }

// Public endpoints

func (e *EvolutionClient) GetStats(ctx context.Context) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/public/stats", nil, nil)
}

func (e *EvolutionClient) GetHotGenes(ctx context.Context, limit int) (*IMResult, error) {
	var query map[string]string
	if limit > 0 {
		query = map[string]string{"limit": fmt.Sprintf("%d", limit)}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/public/hot", nil, query)
}

func (e *EvolutionClient) BrowseGenes(ctx context.Context, opts *GeneListOptions) (*IMResult, error) {
	var query map[string]string
	if opts != nil {
		query = map[string]string{}
		if opts.Category != "" {
			query["category"] = opts.Category
		}
		if opts.Search != "" {
			query["search"] = opts.Search
		}
		if opts.Sort != "" {
			query["sort"] = opts.Sort
		}
		if opts.Page > 0 {
			query["page"] = fmt.Sprintf("%d", opts.Page)
		}
		if opts.Limit > 0 {
			query["limit"] = fmt.Sprintf("%d", opts.Limit)
		}
		if len(query) == 0 {
			query = nil
		}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/public/genes", nil, query)
}

func (e *EvolutionClient) GetPublicGene(ctx context.Context, geneID string) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/public/genes/"+geneID, nil, nil)
}

func (e *EvolutionClient) GetGeneCapsules(ctx context.Context, geneID string, limit int) (*IMResult, error) {
	var query map[string]string
	if limit > 0 {
		query = map[string]string{"limit": fmt.Sprintf("%d", limit)}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/public/genes/"+geneID+"/capsules", nil, query)
}

func (e *EvolutionClient) GetGeneLineage(ctx context.Context, geneID string) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/public/genes/"+geneID+"/lineage", nil, nil)
}

func (e *EvolutionClient) GetFeed(ctx context.Context, limit int) (*IMResult, error) {
	var query map[string]string
	if limit > 0 {
		query = map[string]string{"limit": fmt.Sprintf("%d", limit)}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/public/feed", nil, query)
}

// Authenticated endpoints

func (e *EvolutionClient) Analyze(ctx context.Context, opts *AnalyzeOptions) (*IMResult, error) {
	var query map[string]string
	if opts != nil && opts.Scope != "" {
		query = map[string]string{"scope": opts.Scope}
	}
	return e.im.do(ctx, "POST", "/api/im/evolution/analyze", opts, query)
}

func (e *EvolutionClient) Record(ctx context.Context, opts *RecordOutcomeOptions) (*IMResult, error) {
	var query map[string]string
	if opts != nil && opts.Scope != "" {
		query = map[string]string{"scope": opts.Scope}
	}
	return e.im.do(ctx, "POST", "/api/im/evolution/record", opts, query)
}

// Evolve is a one-step convenience: analyze context → get gene → auto-record outcome.
func (e *EvolutionClient) Evolve(ctx context.Context, analyzeOpts *AnalyzeOptions, outcome string, score float64, summary string) (*IMResult, error) {
	analysis, err := e.Analyze(ctx, analyzeOpts)
	if err != nil {
		return nil, err
	}
	var data map[string]interface{}
	if err := json.Unmarshal(analysis.Data, &data); err != nil || data["gene_id"] == nil {
		return analysis, nil // no gene matched or unparseable
	}
	geneID, _ := data["gene_id"].(string)
	action, _ := data["action"].(string)
	if geneID == "" || (action != "apply_gene" && action != "explore") {
		return analysis, nil
	}
	signals, _ := data["signals"].([]interface{})
	var signalStrs []string
	for _, s := range signals {
		if str, ok := s.(string); ok {
			signalStrs = append(signalStrs, str)
		} else if m, ok := s.(map[string]interface{}); ok {
			if t, ok := m["type"].(string); ok {
				signalStrs = append(signalStrs, t)
			}
		}
	}
	if summary == "" {
		if outcome == "success" {
			summary = "Resolved using " + geneID
		} else {
			summary = "Failed using " + geneID
		}
	}
	s := score
	_, err = e.Record(ctx, &RecordOutcomeOptions{
		GeneID:  geneID,
		Signals: signalStrs,
		Outcome: outcome,
		Score:   &s,
		Summary: summary,
		Scope:   analyzeOpts.Scope,
	})
	if err != nil {
		return nil, err
	}
	resultData, _ := json.Marshal(map[string]interface{}{
		"analysis": data, "recorded": true,
	})
	return &IMResult{OK: true, Data: resultData}, nil
}

func (e *EvolutionClient) Distill(ctx context.Context, dryRun bool) (*IMResult, error) {
	var query map[string]string
	if dryRun {
		query = map[string]string{"dry_run": "true"}
	}
	return e.im.do(ctx, "POST", "/api/im/evolution/distill", nil, query)
}

func (e *EvolutionClient) ListGenes(ctx context.Context, signals string, scope string) (*IMResult, error) {
	var query map[string]string
	if signals != "" || scope != "" {
		query = map[string]string{}
		if signals != "" {
			query["signals"] = signals
		}
		if scope != "" {
			query["scope"] = scope
		}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/genes", nil, query)
}

func (e *EvolutionClient) CreateGene(ctx context.Context, opts *CreateGeneOptions) (*IMResult, error) {
	var query map[string]string
	if opts != nil && opts.Scope != "" {
		query = map[string]string{"scope": opts.Scope}
	}
	return e.im.do(ctx, "POST", "/api/im/evolution/genes", opts, query)
}

func (e *EvolutionClient) DeleteGene(ctx context.Context, geneID string) (*IMResult, error) {
	return e.im.do(ctx, "DELETE", "/api/im/evolution/genes/"+geneID, nil, nil)
}

func (e *EvolutionClient) PublishGene(ctx context.Context, geneID string) (*IMResult, error) {
	return e.im.do(ctx, "POST", "/api/im/evolution/genes/"+geneID+"/publish", nil, nil)
}

func (e *EvolutionClient) ImportGene(ctx context.Context, geneID string) (*IMResult, error) {
	return e.im.do(ctx, "POST", "/api/im/evolution/genes/import", map[string]string{"gene_id": geneID}, nil)
}

func (e *EvolutionClient) ForkGene(ctx context.Context, opts *ForkGeneOptions) (*IMResult, error) {
	return e.im.do(ctx, "POST", "/api/im/evolution/genes/fork", opts, nil)
}

func (e *EvolutionClient) GetEdges(ctx context.Context, signalKey, geneID string, limit int, scope string) (*IMResult, error) {
	var query map[string]string
	if signalKey != "" || geneID != "" || limit > 0 || scope != "" {
		query = map[string]string{}
		if signalKey != "" {
			query["signal_key"] = signalKey
		}
		if geneID != "" {
			query["gene_id"] = geneID
		}
		if limit > 0 {
			query["limit"] = fmt.Sprintf("%d", limit)
		}
		if scope != "" {
			query["scope"] = scope
		}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/edges", nil, query)
}

func (e *EvolutionClient) GetPersonality(ctx context.Context, agentID string) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/personality/"+agentID, nil, nil)
}

func (e *EvolutionClient) GetCapsules(ctx context.Context, page, limit int) (*IMResult, error) {
	var query map[string]string
	if page > 0 || limit > 0 {
		query = map[string]string{}
		if page > 0 {
			query["page"] = fmt.Sprintf("%d", page)
		}
		if limit > 0 {
			query["limit"] = fmt.Sprintf("%d", limit)
		}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/capsules", nil, query)
}

func (e *EvolutionClient) GetReport(ctx context.Context, agentID string) (*IMResult, error) {
	var query map[string]string
	if agentID != "" {
		query = map[string]string{"agent_id": agentID}
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/report", nil, query)
}

// ListScopes returns available evolution scopes.
func (e *EvolutionClient) ListScopes(ctx context.Context) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/scopes", nil, nil)
}

// GetStories returns recent evolution stories for L1 narrative embedding.
func (e *EvolutionClient) GetStories(ctx context.Context, limit, sinceMinutes int) (*IMResult, error) {
	q := map[string]string{}
	if limit > 0 {
		q["limit"] = fmt.Sprintf("%d", limit)
	}
	if sinceMinutes > 0 {
		q["since"] = fmt.Sprintf("%d", sinceMinutes)
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/stories", nil, q)
}

// GetMetrics returns north-star A/B metrics comparison.
func (e *EvolutionClient) GetMetrics(ctx context.Context) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/metrics", nil, nil)
}

// CollectMetrics triggers a metrics snapshot.
func (e *EvolutionClient) CollectMetrics(ctx context.Context, windowHours int) (*IMResult, error) {
	body := map[string]int{"window_hours": windowHours}
	return e.im.do(ctx, "POST", "/api/im/evolution/metrics/collect", body, nil)
}

// SearchSkills searches the skills catalog.
func (e *EvolutionClient) SearchSkills(ctx context.Context, query, category string, limit int) (*IMResult, error) {
	q := map[string]string{}
	if query != "" {
		q["query"] = query
	}
	if category != "" {
		q["category"] = category
	}
	if limit > 0 {
		q["limit"] = fmt.Sprintf("%d", limit)
	}
	return e.im.do(ctx, "GET", "/api/im/skills/search", nil, q)
}

// InstallSkill installs a skill — creates cloud record + Gene, returns content for local install.
// scope is optional; pass "" to use the default scope.
func (e *EvolutionClient) InstallSkill(ctx context.Context, slugOrID string, scope string) (*IMResult, error) {
	var body interface{}
	if scope != "" {
		body = map[string]string{"scope": scope}
	}
	return e.im.do(ctx, "POST", "/api/im/skills/"+url.PathEscape(slugOrID)+"/install", body, nil)
}

// GetWorkspace fetches the workspace superset view with optional slot filtering.
func (e *EvolutionClient) GetWorkspace(ctx context.Context, scope string, slots []string, includeContent bool) (*IMResult, error) {
	q := map[string]string{}
	if scope != "" {
		q["scope"] = scope
	}
	if len(slots) > 0 {
		q["slots"] = strings.Join(slots, ",")
	}
	if includeContent {
		q["includeContent"] = "true"
	}
	return e.im.do(ctx, "GET", "/api/im/workspace/view", nil, q)
}

// UninstallSkill uninstalls a skill.
func (e *EvolutionClient) UninstallSkill(ctx context.Context, slugOrID string) (*IMResult, error) {
	return e.im.do(ctx, "DELETE", "/api/im/skills/"+url.PathEscape(slugOrID)+"/install", nil, nil)
}

// InstalledSkills lists installed skills for this agent.
func (e *EvolutionClient) InstalledSkills(ctx context.Context) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/skills/installed", nil, nil)
}

// GetSkillContent gets full skill content (SKILL.md + package info).
func (e *EvolutionClient) GetSkillContent(ctx context.Context, slugOrID string) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/skills/"+url.PathEscape(slugOrID)+"/content", nil, nil)
}

// ── Local Skill Sync ────────────────────────────────────

// SkillLocalResult holds the result of a local skill install/uninstall.
type SkillLocalResult struct {
	CloudResult *IMResult
	LocalPaths  []string
	Errors      []string
}

// safeSlug sanitizes a slug to prevent directory traversal attacks.
func safeSlug(s string) string {
	s = strings.ReplaceAll(s, "..", "")
	s = strings.ReplaceAll(s, "/", "")
	s = strings.ReplaceAll(s, "\\", "")
	s = strings.ReplaceAll(s, "\x00", "")
	return filepath.Base(s)
}

// InstallSkillLocal installs a skill on cloud and writes SKILL.md to local filesystem
// for Claude Code, OpenClaw, and OpenCode.
// platforms: "claude-code", "openclaw", "opencode", or empty for all.
// project: if true, writes to project-level paths (e.g. .claude/skills/) instead of global (~/).
// projectRoot: project root directory for project-level installs (defaults to ".").
func (e *EvolutionClient) InstallSkillLocal(ctx context.Context, slugOrID string, platforms []string, project bool, projectRoot string) (*SkillLocalResult, error) {
	// 1. Cloud install
	cloudRes, err := e.InstallSkill(ctx, slugOrID, "")
	if err != nil {
		return nil, err
	}
	result := &SkillLocalResult{CloudResult: cloudRes}

	if cloudRes.Data == nil {
		return result, nil
	}

	// 2. Extract content and slug from response
	data := asMap(cloudRes.Data)
	skillData := asMap(data["skill"])
	content, _ := skillData["content"].(string)
	slug, _ := skillData["slug"].(string)
	if slug == "" {
		slug = slugOrID
	}
	slug = safeSlug(slug)
	if slug == "" || slug == "." {
		return result, nil
	}

	// 3. If no content in install response, fetch it
	if content == "" {
		contentRes, err := e.GetSkillContent(ctx, slugOrID)
		if err == nil && contentRes.Data != nil {
			cd := asMap(contentRes.Data)
			content, _ = cd["content"].(string)
		}
	}
	if content == "" {
		return result, nil
	}

	// 4. Determine target paths
	home, err := os.UserHomeDir()
	if err != nil {
		result.Errors = append(result.Errors, "cannot determine home dir: "+err.Error())
		return result, nil
	}

	if projectRoot == "" {
		projectRoot = "."
	}

	type platformPath struct {
		name string
		dir  string
	}

	pluginDir := os.Getenv("PRISMER_PLUGIN_DIR")
	if pluginDir == "" {
		pluginDir = filepath.Join(home, ".claude", "plugins", "prismer")
	}

	var allPaths []platformPath
	if project {
		allPaths = []platformPath{
			{"claude-code", filepath.Join(projectRoot, ".claude", "skills", slug)},
			{"openclaw", filepath.Join(projectRoot, "skills", slug)},
			{"opencode", filepath.Join(projectRoot, ".opencode", "skills", slug)},
			{"plugin", filepath.Join(projectRoot, ".claude", "plugins", "prismer", "skills", slug)},
		}
	} else {
		allPaths = []platformPath{
			{"claude-code", filepath.Join(home, ".claude", "skills", slug)},
			{"openclaw", filepath.Join(home, ".openclaw", "skills", slug)},
			{"opencode", filepath.Join(home, ".config", "opencode", "skills", slug)},
			{"plugin", filepath.Join(pluginDir, "skills", slug)},
		}
	}

	// Filter by requested platforms
	targets := allPaths
	if len(platforms) > 0 {
		targets = nil
		platformSet := map[string]bool{}
		for _, p := range platforms {
			platformSet[p] = true
		}
		for _, p := range allPaths {
			if platformSet[p.name] {
				targets = append(targets, p)
			}
		}
	}

	// 5. Write SKILL.md to each target
	for _, t := range targets {
		if err := os.MkdirAll(t.dir, 0o755); err != nil {
			result.Errors = append(result.Errors, t.name+": "+err.Error())
			continue
		}
		fp := filepath.Join(t.dir, "SKILL.md")
		if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
			result.Errors = append(result.Errors, t.name+": "+err.Error())
			continue
		}
		result.LocalPaths = append(result.LocalPaths, fp)
	}

	return result, nil
}

// UninstallSkillLocal uninstalls a skill from cloud and removes local SKILL.md files.
func (e *EvolutionClient) UninstallSkillLocal(ctx context.Context, slugOrID string) (*SkillLocalResult, error) {
	cloudRes, err := e.UninstallSkill(ctx, slugOrID)
	if err != nil {
		return nil, err
	}
	result := &SkillLocalResult{CloudResult: cloudRes}

	safe := safeSlug(slugOrID)
	if safe == "" || safe == "." {
		return result, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return result, nil
	}

	pluginDir := os.Getenv("PRISMER_PLUGIN_DIR")
	if pluginDir == "" {
		pluginDir = filepath.Join(home, ".claude", "plugins", "prismer")
	}

	dirs := []string{
		filepath.Join(home, ".claude", "skills", safe),
		filepath.Join(home, ".openclaw", "skills", safe),
		filepath.Join(home, ".config", "opencode", "skills", safe),
		filepath.Join(pluginDir, "skills", safe),
	}

	for _, dir := range dirs {
		if _, err := os.Stat(dir); err == nil {
			if err := os.RemoveAll(dir); err != nil {
				result.Errors = append(result.Errors, err.Error())
			} else {
				result.LocalPaths = append(result.LocalPaths, dir)
			}
		}
	}

	return result, nil
}

// SyncSkillsLocalResult holds the result of a bulk local sync.
type SyncSkillsLocalResult struct {
	Synced int
	Failed int
	Paths  []string
}

// SyncSkillsLocal syncs all installed skills to local filesystem.
func (e *EvolutionClient) SyncSkillsLocal(ctx context.Context, platforms []string) (*SyncSkillsLocalResult, error) {
	result := &SyncSkillsLocalResult{}

	installed, err := e.InstalledSkills(ctx)
	if err != nil {
		return result, err
	}
	if installed.Data == nil {
		return result, nil
	}

	records := asList(installed.Data)
	home, err := os.UserHomeDir()
	if err != nil {
		return result, err
	}

	for _, rec := range records {
		r := asMap(rec)
		skillData := asMap(r["skill"])
		rawSlug, _ := skillData["slug"].(string)
		if rawSlug == "" {
			result.Failed++
			continue
		}
		slug := safeSlug(rawSlug)
		if slug == "" || slug == "." {
			result.Failed++
			continue
		}

		contentRes, err := e.GetSkillContent(ctx, slug)
		if err != nil || contentRes.Data == nil {
			result.Failed++
			continue
		}
		cd := asMap(contentRes.Data)
		content, _ := cd["content"].(string)
		if content == "" {
			result.Failed++
			continue
		}

		pluginDir := os.Getenv("PRISMER_PLUGIN_DIR")
		if pluginDir == "" {
			pluginDir = filepath.Join(home, ".claude", "plugins", "prismer")
		}

		type pp struct{ name, dir string }
		allPaths := []pp{
			{"claude-code", filepath.Join(home, ".claude", "skills", slug)},
			{"openclaw", filepath.Join(home, ".openclaw", "skills", slug)},
			{"opencode", filepath.Join(home, ".config", "opencode", "skills", slug)},
			{"plugin", filepath.Join(pluginDir, "skills", slug)},
		}

		targets := allPaths
		if len(platforms) > 0 {
			targets = nil
			ps := map[string]bool{}
			for _, p := range platforms {
				ps[p] = true
			}
			for _, p := range allPaths {
				if ps[p.name] {
					targets = append(targets, p)
				}
			}
		}

		for _, t := range targets {
			os.MkdirAll(t.dir, 0o755)
			fp := filepath.Join(t.dir, "SKILL.md")
			if err := os.WriteFile(fp, []byte(content), 0o644); err == nil {
				result.Paths = append(result.Paths, fp)
			}
		}
		result.Synced++
	}

	return result, nil
}

// ── P0: Report, Achievements, Sync ─────────────────────

// SubmitReport submits a raw-context evolution report (auto-creates signals + gene match).
func (e *EvolutionClient) SubmitReport(ctx context.Context, rawContext, outcome string, opts map[string]interface{}) (*IMResult, error) {
	body := map[string]interface{}{"raw_context": rawContext, "outcome": outcome}
	if opts != nil {
		for k, v := range opts {
			body[k] = v
		}
	}
	return e.im.do(ctx, "POST", "/api/im/evolution/report", body, nil)
}

// GetReportStatus gets the status of a submitted report by traceId.
func (e *EvolutionClient) GetReportStatus(ctx context.Context, traceID string) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/report/"+traceID, nil, nil)
}

// GetAchievements gets evolution achievements for the current agent.
func (e *EvolutionClient) GetAchievements(ctx context.Context) (*IMResult, error) {
	return e.im.do(ctx, "GET", "/api/im/evolution/achievements", nil, nil)
}

// GetSyncSnapshot gets a sync snapshot (global gene/edge state since a sequence number).
func (e *EvolutionClient) GetSyncSnapshot(ctx context.Context, since int64) (*IMResult, error) {
	q := map[string]string{"scope": "global"}
	if since > 0 {
		q["since"] = fmt.Sprintf("%d", since)
	}
	return e.im.do(ctx, "GET", "/api/im/evolution/sync/snapshot", nil, q)
}

// Sync performs bidirectional sync: push local outcomes and pull remote updates.
func (e *EvolutionClient) Sync(ctx context.Context, pushOutcomes []interface{}, pullSince int64) (*IMResult, error) {
	body := map[string]interface{}{}
	if len(pushOutcomes) > 0 {
		body["push"] = map[string]interface{}{"outcomes": pushOutcomes}
	}
	if pullSince >= 0 {
		body["pull"] = map[string]interface{}{"since": pullSince}
	}
	return e.im.do(ctx, "POST", "/api/im/evolution/sync", body, nil)
}

// ExportGeneAsSkill exports a Gene as a Skill.
func (e *EvolutionClient) ExportGeneAsSkill(ctx context.Context, geneID string, opts map[string]interface{}) (*IMResult, error) {
	return e.im.do(ctx, "POST", "/api/im/evolution/genes/"+geneID+"/export-skill", opts, nil)
}

// ============================================================================
// SecurityClient — Conversation security: E2E encryption settings & keys
// ============================================================================

// SecurityClient handles conversation security settings and key management.
type SecurityClient struct{ im *IMClient }

// GetConversationSecurity gets conversation security settings.
func (s *SecurityClient) GetConversationSecurity(ctx context.Context, conversationID string) (*IMResult, error) {
	return s.im.do(ctx, "GET", "/api/im/conversations/"+conversationID+"/security", nil, nil)
}

// SetConversationSecurity updates conversation security settings.
func (s *SecurityClient) SetConversationSecurity(ctx context.Context, conversationID string, opts map[string]interface{}) (*IMResult, error) {
	return s.im.do(ctx, "PATCH", "/api/im/conversations/"+conversationID+"/security", opts, nil)
}

// UploadKey uploads a public key for a conversation.
func (s *SecurityClient) UploadKey(ctx context.Context, conversationID, publicKey string, algorithm string) (*IMResult, error) {
	body := map[string]interface{}{"publicKey": publicKey}
	if algorithm != "" {
		body["algorithm"] = algorithm
	}
	return s.im.do(ctx, "POST", "/api/im/conversations/"+conversationID+"/keys", body, nil)
}

// GetKeys gets keys for a conversation.
func (s *SecurityClient) GetKeys(ctx context.Context, conversationID string) (*IMResult, error) {
	return s.im.do(ctx, "GET", "/api/im/conversations/"+conversationID+"/keys", nil, nil)
}

// RevokeKey revokes a key for a specific user in a conversation.
func (s *SecurityClient) RevokeKey(ctx context.Context, conversationID, keyUserID string) (*IMResult, error) {
	return s.im.do(ctx, "DELETE", "/api/im/conversations/"+conversationID+"/keys/"+keyUserID, nil, nil)
}

// IMRealtimeClient handles real-time connection factory.
type IMRealtimeClient struct{ im *IMClient }

// WSUrl returns the WebSocket URL.
func (r *IMRealtimeClient) WSUrl(token string) string {
	base := strings.Replace(r.im.client.baseURL, "https://", "wss://", 1)
	base = strings.Replace(base, "http://", "ws://", 1)
	if token != "" {
		return base + "/ws?token=" + token
	}
	return base + "/ws"
}

// SSEUrl returns the SSE URL.
func (r *IMRealtimeClient) SSEUrl(token string) string {
	if token != "" {
		return r.im.client.baseURL + "/sse?token=" + token
	}
	return r.im.client.baseURL + "/sse"
}

// ConnectWS creates a WebSocket real-time client. Call Connect() to establish connection.
func (r *IMRealtimeClient) ConnectWS(config *RealtimeConfig) *RealtimeWSClient {
	cfg := *config
	cfg.defaults()
	return &RealtimeWSClient{
		baseURL:      r.im.client.baseURL,
		config:       &cfg,
		state:        StateDisconnected,
		dispatcher:   newEventDispatcher(),
		recon:        newReconnector(&cfg),
		pendingPings: make(map[string]chan PongPayload),
	}
}

// ConnectSSE creates an SSE real-time client. Call Connect() to establish connection.
func (r *IMRealtimeClient) ConnectSSE(config *RealtimeConfig) *RealtimeSSEClient {
	cfg := *config
	cfg.defaults()
	return &RealtimeSSEClient{
		baseURL:    r.im.client.baseURL,
		config:     &cfg,
		state:      StateDisconnected,
		dispatcher: newEventDispatcher(),
		recon:      newReconnector(&cfg),
	}
}

// ============================================================================
// Internal helpers
// ============================================================================

func asMap(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return map[string]interface{}{}
}

func asList(v interface{}) []interface{} {
	if l, ok := v.([]interface{}); ok {
		return l
	}
	return nil
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"
)

// getIMClient creates a Prismer client authenticated with the IM token.
func getIMClient() *prismer.Client {
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}
	if cfg.Auth.IMToken == "" {
		fmt.Fprintln(os.Stderr, "No IM token. Run 'prismer register' first.")
		os.Exit(1)
	}

	var opts []prismer.ClientOption
	if cfg.Default.BaseURL != "" {
		opts = append(opts, prismer.WithBaseURL(cfg.Default.BaseURL))
	} else if cfg.Default.Environment != "" && cfg.Default.Environment != "production" {
		opts = append(opts, prismer.WithEnvironment(prismer.Environment(cfg.Default.Environment)))
	}

	return prismer.NewClient(cfg.Auth.IMToken, opts...)
}

// imBaseURL returns the base URL for the IM API based on config.
func imBaseURL() string {
	cfg, _ := loadConfig()
	if cfg != nil && cfg.Default.BaseURL != "" {
		return cfg.Default.BaseURL
	}
	env := ""
	if cfg != nil {
		env = cfg.Default.Environment
	}
	switch env {
	case "test", "development":
		return "https://cloud.prismer.dev"
	default:
		return "https://prismer.cloud"
	}
}

// imRawRequest makes a raw HTTP request to the IM API using the stored JWT token.
// method is "GET" or "POST" etc. path includes the full /api/im/... path.
// body is serialized as JSON (if not nil). query params are appended if provided.
func imRawRequest(ctx context.Context, method, path string, body interface{}, query map[string]string) (map[string]interface{}, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}
	if cfg.Auth.IMToken == "" {
		return nil, fmt.Errorf("no IM token; run 'prismer register' first")
	}

	base := imBaseURL()
	reqURL, err := url.Parse(base + path)
	if err != nil {
		return nil, err
	}

	if len(query) > 0 {
		q := reqURL.Query()
		for k, v := range query {
			q.Set(k, v)
		}
		reqURL.RawQuery = q.Encode()
	}

	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, reqURL.String(), bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Auth.IMToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w (body: %s)", err, string(data))
	}
	return result, nil
}

// getAPIClient creates a Prismer client authenticated with the API key.
func getAPIClient() *prismer.Client {
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}
	if cfg.Default.APIKey == "" {
		fmt.Fprintln(os.Stderr, "No API key. Run 'prismer init <api-key>' first.")
		os.Exit(1)
	}

	var opts []prismer.ClientOption
	if cfg.Default.BaseURL != "" {
		opts = append(opts, prismer.WithBaseURL(cfg.Default.BaseURL))
	} else if cfg.Default.Environment != "" && cfg.Default.Environment != "production" {
		opts = append(opts, prismer.WithEnvironment(prismer.Environment(cfg.Default.Environment)))
	}

	return prismer.NewClient(cfg.Default.APIKey, opts...)
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"
	toml "github.com/pelletier/go-toml/v2"
	"github.com/spf13/cobra"
)

// ============================================================================
// Config types
// ============================================================================

// Config represents the CLI configuration stored in ~/.prismer/config.toml.
type Config struct {
	Default ConfigDefault `toml:"default"`
	Auth    ConfigAuth    `toml:"auth"`
}

// ConfigDefault holds general SDK settings.
type ConfigDefault struct {
	APIKey      string `toml:"api_key"`
	Environment string `toml:"environment"`
	BaseURL     string `toml:"base_url"`
}

// ConfigAuth holds IM authentication state.
type ConfigAuth struct {
	IMToken        string `toml:"im_token"`
	IMUserID       string `toml:"im_user_id"`
	IMUsername      string `toml:"im_username"`
	IMTokenExpires string `toml:"im_token_expires"`
}

// ============================================================================
// Config helpers
// ============================================================================

// configDir returns the path to ~/.prismer, creating it if needed.
func configDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	dir := filepath.Join(home, ".prismer")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("cannot create config directory: %w", err)
	}
	return dir, nil
}

// configPath returns the full path to the config file.
func configPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.toml"), nil
}

// loadConfig reads and parses the config file.
// If the file does not exist, it returns a zero-value Config.
func loadConfig() (*Config, error) {
	path, err := configPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, fmt.Errorf("cannot read config: %w", err)
	}
	var cfg Config
	if err := toml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("cannot parse config: %w", err)
	}
	return &cfg, nil
}

// saveConfig writes the config struct back to disk as TOML.
func saveConfig(cfg *Config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	data, err := toml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("cannot marshal config: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("cannot write config: %w", err)
	}
	return nil
}

// setConfigValue sets a config field using dot notation (e.g. "default.api_key").
func setConfigValue(cfg *Config, key, value string) error {
	parts := strings.SplitN(key, ".", 2)
	if len(parts) != 2 {
		return fmt.Errorf("key must use dot notation: section.field (e.g. default.api_key)")
	}
	section, field := parts[0], parts[1]

	switch section {
	case "default":
		switch field {
		case "api_key":
			cfg.Default.APIKey = value
		case "environment":
			cfg.Default.Environment = value
		case "base_url":
			cfg.Default.BaseURL = value
		default:
			return fmt.Errorf("unknown field %q in section [default]", field)
		}
	case "auth":
		switch field {
		case "im_token":
			cfg.Auth.IMToken = value
		case "im_user_id":
			cfg.Auth.IMUserID = value
		case "im_username":
			cfg.Auth.IMUsername = value
		case "im_token_expires":
			cfg.Auth.IMTokenExpires = value
		default:
			return fmt.Errorf("unknown field %q in section [auth]", field)
		}
	default:
		return fmt.Errorf("unknown config section %q (valid: default, auth)", section)
	}
	return nil
}

// ============================================================================
// Root command
// ============================================================================

var rootCmd = &cobra.Command{
	Use:   "prismer",
	Short: "Prismer SDK CLI",
	Long:  "Command-line interface for the Prismer Cloud SDK.\nManage configuration, register IM agents, and check status.",
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

// ============================================================================
// Top-level shortcut commands
// ============================================================================

func init() {
	// -- send (shortcut for: im send) --

	var sendType string
	var sendReplyTo string
	var sendJSON bool

	sendShortcutCmd := &cobra.Command{
		Use:   "send <user-id> <message>",
		Short: "Send a direct message (shortcut for: im send)",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			userID, message := args[0], args[1]
			client := getIMClient()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			var opts *prismer.IMSendOptions
			if sendType != "" && sendType != "text" {
				opts = &prismer.IMSendOptions{Type: sendType}
			}
			if sendReplyTo != "" {
				if opts == nil {
					opts = &prismer.IMSendOptions{}
				}
				opts.ParentID = sendReplyTo
			}

			result, err := client.IM().Direct.Send(ctx, userID, message, opts)
			if err != nil {
				return fmt.Errorf("request failed: %w", err)
			}
			if !result.OK {
				return imError(result)
			}
			if sendJSON {
				fmt.Println(string(result.Data))
				return nil
			}
			var data prismer.IMMessageData
			if err := result.Decode(&data); err != nil {
				return fmt.Errorf("failed to decode response: %w", err)
			}
			fmt.Printf("Message sent (conversation: %s)\n", data.ConversationID)
			return nil
		},
	}
	sendShortcutCmd.Flags().StringVarP(&sendType, "type", "t", "text", "Message type: text, markdown, code, etc.")
	sendShortcutCmd.Flags().StringVar(&sendReplyTo, "reply-to", "", "Reply to a message ID")
	sendShortcutCmd.Flags().BoolVar(&sendJSON, "json", false, "Output raw JSON")
	rootCmd.AddCommand(sendShortcutCmd)

	// -- load (shortcut for: context load) --

	var loadFormat string
	var loadJSON bool

	loadShortcutCmd := &cobra.Command{
		Use:   "load <url...>",
		Short: "Load URL(s) into compressed HQCC (shortcut for: context load)",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := getAPIClient()
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			var input interface{}
			if len(args) == 1 {
				input = args[0]
			} else {
				input = args
			}

			var opts *prismer.LoadOptions
			if loadFormat != "" {
				opts = &prismer.LoadOptions{
					Return: &prismer.ReturnConfig{Format: loadFormat},
				}
			}
			result, err := client.Load(ctx, input, opts)
			if err != nil {
				return fmt.Errorf("request failed: %w", err)
			}
			if !result.Success {
				if result.Error != nil {
					return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
				}
				return fmt.Errorf("API returned an error (no details)")
			}
			if loadJSON {
				data, _ := json.MarshalIndent(result, "", "  ")
				fmt.Println(string(data))
				return nil
			}
			results := result.Results
			if len(results) == 0 && result.Result != nil {
				results = []prismer.LoadResultItem{*result.Result}
			}
			for _, r := range results {
				fmt.Printf("URL:    %s\n", r.URL)
				fmt.Printf("Status: %v\n", boolStr(r.Cached, "cached", "loaded"))
				if r.HQCC != "" {
					content := r.HQCC
					if len(content) > 2000 {
						content = content[:2000]
					}
					fmt.Printf("\n--- HQCC ---\n%s\n\n", content)
				}
			}
			return nil
		},
	}
	loadShortcutCmd.Flags().StringVarP(&loadFormat, "format", "f", "hqcc", "Return format: hqcc, raw, both")
	loadShortcutCmd.Flags().BoolVar(&loadJSON, "json", false, "Output raw JSON")
	rootCmd.AddCommand(loadShortcutCmd)

	// -- search (shortcut for: context search) --

	var searchTopK int
	var searchJSON bool

	searchShortcutCmd := &cobra.Command{
		Use:   "search <query>",
		Short: "Search web content (shortcut for: context search)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := getAPIClient()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			var opts *prismer.SearchOptions
			if searchTopK > 0 {
				opts = &prismer.SearchOptions{TopK: searchTopK}
			}
			result, err := client.Search(ctx, args[0], opts)
			if err != nil {
				return fmt.Errorf("request failed: %w", err)
			}
			if !result.Success {
				if result.Error != nil {
					return fmt.Errorf("API error: %s: %s", result.Error.Code, result.Error.Message)
				}
				return fmt.Errorf("search failed")
			}
			if searchJSON {
				data, _ := json.MarshalIndent(result, "", "  ")
				fmt.Println(string(data))
				return nil
			}
			if len(result.Results) == 0 {
				fmt.Println("No results.")
				return nil
			}
			for i, r := range result.Results {
				score := ""
				if r.Ranking != nil {
					score = fmt.Sprintf("  score: %.3f", r.Ranking.Score)
				}
				fmt.Printf("%d. %s%s\n", i+1, r.URL, score)
				if r.HQCC != "" {
					snippet := r.HQCC
					if len(snippet) > 200 {
						snippet = snippet[:200]
					}
					fmt.Printf("   %s\n", snippet)
				}
			}
			return nil
		},
	}
	searchShortcutCmd.Flags().IntVarP(&searchTopK, "top-k", "k", 5, "Number of results")
	searchShortcutCmd.Flags().BoolVar(&searchJSON, "json", false, "Output raw JSON")
	rootCmd.AddCommand(searchShortcutCmd)

	// -- recall (shortcut for: memory recall) --

	var recallScope string
	var recallLimit int
	var recallJSON bool

	recallCmd := &cobra.Command{
		Use:   "recall <query>",
		Short: "Search across memory, cache, and evolution (shortcut for: memory recall)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			q := map[string]string{"q": args[0]}
			if recallScope != "" {
				q["scope"] = recallScope
			}
			if recallLimit > 0 {
				q["limit"] = fmt.Sprintf("%d", recallLimit)
			}

			result, err := imRawRequest(ctx, "GET", "/api/im/recall", nil, q)
			if err != nil {
				return fmt.Errorf("request failed: %w", err)
			}
			if recallJSON {
				b, _ := json.MarshalIndent(result, "", "  ")
				fmt.Println(string(b))
				return nil
			}
			// Extract data array from result
			raw := result["data"]
			items := asList(raw)
			if len(items) == 0 {
				fmt.Printf("No results for %q.\n", args[0])
				return nil
			}
			for _, item := range items {
				im := asMap(item)
				source, _ := im["source"].(string)
				title, _ := im["title"].(string)
				score, _ := im["score"].(float64)
				snippet, _ := im["snippet"].(string)
				fmt.Printf("[%s] %s  (score: %.2f)\n", strings.ToUpper(source), title, score)
				if snippet != "" {
					if len(snippet) > 200 {
						snippet = snippet[:200]
					}
					fmt.Printf("  %s\n", snippet)
				}
			}
			return nil
		},
	}
	recallCmd.Flags().StringVar(&recallScope, "scope", "all", "Scope: all, memory, cache, evolution")
	recallCmd.Flags().IntVarP(&recallLimit, "limit", "n", 10, "Max results")
	recallCmd.Flags().BoolVar(&recallJSON, "json", false, "Output raw JSON")
	rootCmd.AddCommand(recallCmd)

	// -- discover (shortcut for: im discover) --

	var discoverType string
	var discoverCapability string
	var discoverJSON bool

	discoverShortcutCmd := &cobra.Command{
		Use:   "discover",
		Short: "Discover available agents (shortcut for: im discover)",
		RunE: func(cmd *cobra.Command, args []string) error {
			client := getIMClient()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			var opts *prismer.IMDiscoverOptions
			if discoverType != "" || discoverCapability != "" {
				opts = &prismer.IMDiscoverOptions{
					Type:       discoverType,
					Capability: discoverCapability,
				}
			}
			result, err := client.IM().Contacts.Discover(ctx, opts)
			if err != nil {
				return fmt.Errorf("request failed: %w", err)
			}
			if !result.OK {
				return imError(result)
			}
			if discoverJSON {
				fmt.Println(string(result.Data))
				return nil
			}
			var agents []prismer.IMDiscoverAgent
			if err := result.Decode(&agents); err != nil {
				return fmt.Errorf("failed to decode response: %w", err)
			}
			if len(agents) == 0 {
				fmt.Println("No agents found.")
				return nil
			}
			fmt.Printf("%-20s  %-14s  %-10s  %s\n", "Username", "Type", "Status", "Display Name")
			for _, a := range agents {
				caps := ""
				if len(a.Capabilities) > 0 {
					caps = " [" + strings.Join(a.Capabilities, ", ") + "]"
				}
				fmt.Printf("%-20s  %-14s  %-10s  %s%s\n",
					a.Username, a.AgentType, a.Status, a.DisplayName, caps)
			}
			return nil
		},
	}
	discoverShortcutCmd.Flags().StringVar(&discoverType, "type", "", "Filter by agent type")
	discoverShortcutCmd.Flags().StringVar(&discoverCapability, "capability", "", "Filter by capability")
	discoverShortcutCmd.Flags().BoolVar(&discoverJSON, "json", false, "Output raw JSON")
	rootCmd.AddCommand(discoverShortcutCmd)
}

// boolStr returns trueVal if b is true, falseVal otherwise.
func boolStr(b bool, trueVal, falseVal string) string {
	if b {
		return trueVal
	}
	return falseVal
}

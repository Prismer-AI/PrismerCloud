package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(initCmd)
}

var initCmd = &cobra.Command{
	Use:   "init [api-key]",
	Short: "Initialize Prismer. With key: store and verify. Without: auto-register with free credits.",
	Long: `Initialize the Prismer CLI.

With API key:    prismer init sk-prismer-live-xxx  → verify + store
Without API key: prismer init                      → auto-register with free agent credits

Get your API key at: https://prismer.cloud/dashboard`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := loadConfig()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		if len(args) == 1 {
			// ── Path B: Human provides API key ──
			apiKey := args[0]
			if !strings.HasPrefix(apiKey, "sk-prismer-") {
				fmt.Println("Invalid key format. API keys start with sk-prismer-")
				fmt.Println("Get your key at: https://prismer.cloud/dashboard")
				return fmt.Errorf("invalid API key format")
			}

			// Verify key
			baseURL := cfg.Default.BaseURL
			if baseURL == "" {
				baseURL = "https://prismer.cloud"
			}
			client := &http.Client{Timeout: 5 * time.Second}
			req, _ := http.NewRequest("GET", baseURL+"/api/version", nil)
			req.Header.Set("Authorization", "Bearer "+apiKey)
			resp, err := client.Do(req)
			if err != nil {
				fmt.Printf("Could not verify key (%v). Saving anyway.\n", err)
			} else {
				resp.Body.Close()
				if resp.StatusCode == 401 {
					fmt.Println("API key is invalid or expired.")
					fmt.Println("Get a new key at: https://prismer.cloud/dashboard")
					return fmt.Errorf("invalid API key")
				}
				fmt.Println("API key verified.")
			}

			cfg.Default.APIKey = apiKey
			if cfg.Default.Environment == "" {
				cfg.Default.Environment = "production"
			}
			if err := saveConfig(cfg); err != nil {
				return fmt.Errorf("failed to save config: %w", err)
			}
			path, _ := configPath()
			fmt.Printf("Saved to %s\n", path)
			fmt.Println("You can now use all Prismer CLI, plugin, and MCP features.")
			return nil
		}

		// ── Path A: Auto-register with free agent credits ──
		if strings.HasPrefix(cfg.Default.APIKey, "sk-prismer-") {
			fmt.Printf("Already configured (%s...)\n", cfg.Default.APIKey[:20])
			return nil
		}
		if cfg.Auth.IMToken != "" {
			fmt.Println("Already registered as agent (IM token exists).")
			fmt.Println("For more credits, get API key: https://prismer.cloud/dashboard")
			return nil
		}

		baseURL := cfg.Default.BaseURL
		if baseURL == "" {
			baseURL = "https://prismer.cloud"
		}
		username := fmt.Sprintf("go-cli-%d", time.Now().Unix())

		body, _ := json.Marshal(map[string]string{
			"username":    username,
			"displayName": username,
			"type":        "agent",
		})
		resp, err := http.Post(baseURL+"/api/im/register", "application/json", bytes.NewReader(body))
		if err != nil {
			fmt.Printf("Auto-registration failed: %v\n", err)
			fmt.Println("Get API key manually: https://prismer.cloud/dashboard")
			return err
		}
		defer resp.Body.Close()

		var result struct {
			OK   bool `json:"ok"`
			Data struct {
				Token    string `json:"token"`
				IMUserID string `json:"imUserId"`
				UserID   string `json:"userId"`
				Username string `json:"username"`
			} `json:"data"`
			Error *struct{ Message string } `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || !result.OK {
			msg := "unknown error"
			if result.Error != nil {
				msg = result.Error.Message
			}
			fmt.Printf("Auto-registration failed: %s\n", msg)
			fmt.Println("Get API key manually: https://prismer.cloud/dashboard")
			return fmt.Errorf("registration failed: %s", msg)
		}

		cfg.Auth.IMToken = result.Data.Token
		cfg.Auth.IMUserID = result.Data.IMUserID
		if cfg.Auth.IMUserID == "" {
			cfg.Auth.IMUserID = result.Data.UserID
		}
		cfg.Auth.IMUsername = result.Data.Username
		if err := saveConfig(cfg); err != nil {
			return fmt.Errorf("failed to save config: %w", err)
		}

		fmt.Println("Registered with free agent credits.")
		fmt.Printf("  Username: %s\n", cfg.Auth.IMUsername)
		fmt.Printf("  User ID:  %s\n", cfg.Auth.IMUserID)
		fmt.Println("")
		fmt.Println("For more credits, get API key: https://prismer.cloud/dashboard")
		return nil
	},
}

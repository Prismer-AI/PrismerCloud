package main

import (
	"context"
	"fmt"
	"time"

	prismer "github.com/Prismer-AI/Prismer/sdk/golang"
	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(statusCmd)
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current configuration and account status",
	Long:  "Display the current configuration, check if the IM token is expired, and fetch live account info.",
	RunE: func(cmd *cobra.Command, args []string) error {
		cfg, err := loadConfig()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		// Print config summary.
		fmt.Println("Configuration:")
		fmt.Printf("  Environment: %s\n", valueOrDefault(cfg.Default.Environment, "(not set)"))
		if cfg.Default.BaseURL != "" {
			fmt.Printf("  Base URL:    %s\n", cfg.Default.BaseURL)
		}
		if cfg.Default.APIKey != "" {
			masked := maskKey(cfg.Default.APIKey)
			fmt.Printf("  API Key:     %s\n", masked)
		} else {
			fmt.Println("  API Key:     (not set)")
		}

		fmt.Println()
		fmt.Println("Auth:")
		if cfg.Auth.IMUsername != "" {
			fmt.Printf("  IM Username: %s\n", cfg.Auth.IMUsername)
			fmt.Printf("  IM User ID:  %s\n", cfg.Auth.IMUserID)
		} else {
			fmt.Println("  IM Username: (not registered)")
		}

		// Check token expiry.
		tokenStatus := "none"
		if cfg.Auth.IMToken != "" {
			if cfg.Auth.IMTokenExpires != "" {
				expires, err := time.Parse(time.RFC3339, cfg.Auth.IMTokenExpires)
				if err == nil {
					if time.Now().Before(expires) {
						tokenStatus = fmt.Sprintf("valid (expires %s)", expires.Format(time.RFC3339))
					} else {
						tokenStatus = fmt.Sprintf("EXPIRED (expired %s)", expires.Format(time.RFC3339))
					}
				} else {
					tokenStatus = fmt.Sprintf("set (expires in %s)", cfg.Auth.IMTokenExpires)
				}
			} else {
				tokenStatus = "present (no expiry set)"
			}
		}
		fmt.Printf("  Token:       %s\n", tokenStatus)

		// If we have an IM token, try live status via me() (requires JWT, not API key).
		if cfg.Auth.IMToken != "" {
			fmt.Println()
			fmt.Println("Live status:")

			var opts []prismer.ClientOption
			if cfg.Default.BaseURL != "" {
				opts = append(opts, prismer.WithBaseURL(cfg.Default.BaseURL))
			} else if cfg.Default.Environment != "" && cfg.Default.Environment != "production" {
				opts = append(opts, prismer.WithEnvironment(prismer.Environment(cfg.Default.Environment)))
			}

			client := prismer.NewClient(cfg.Auth.IMToken, opts...)

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			result, err := client.IM().Account.Me(ctx)
			if err != nil {
				fmt.Printf("  Error fetching account info: %v\n", err)
				return nil
			}
			if !result.OK {
				if result.Error != nil {
					fmt.Printf("  API error: %s: %s\n", result.Error.Code, result.Error.Message)
				} else {
					fmt.Println("  API returned an error (no details)")
				}
				return nil
			}

			var me prismer.IMMeData
			if err := result.Decode(&me); err != nil {
				fmt.Printf("  Error decoding response: %v\n", err)
				return nil
			}

			fmt.Printf("  Username:      %s\n", me.User.Username)
			fmt.Printf("  Display Name:  %s\n", me.User.DisplayName)
			fmt.Printf("  Role:          %s\n", me.User.Role)
			fmt.Printf("  Conversations: %d\n", me.Stats.ConversationCount)
			fmt.Printf("  Contacts:      %d\n", me.Stats.ContactCount)
			fmt.Printf("  Messages Sent: %d\n", me.Stats.MessagesSent)
			fmt.Printf("  Unread:        %d\n", me.Stats.UnreadCount)
			fmt.Printf("  Credits:       %.2f\n", me.Credits.Balance)
		}

		return nil
	},
}

// maskKey shows the first 12 and last 4 characters of a key.
func maskKey(key string) string {
	if len(key) <= 16 {
		return key[:4] + "..." + key[len(key)-4:]
	}
	return key[:12] + "..." + key[len(key)-4:]
}

func valueOrDefault(val, def string) string {
	if val == "" {
		return def
	}
	return val
}

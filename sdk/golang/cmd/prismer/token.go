package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

var tokenCmd = &cobra.Command{
	Use:   "token",
	Short: "Token management",
}

var tokenRefreshJSON bool
var tokenRefreshCmd = &cobra.Command{
	Use:   "refresh",
	Short: "Refresh IM JWT token",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		result, err := client.IM().Account.RefreshToken(ctx)
		if err != nil {
			return fmt.Errorf("request failed: %w", err)
		}
		if !result.OK {
			return imError(result)
		}

		if tokenRefreshJSON {
			fmt.Println(string(result.Data))
			return nil
		}

		// Update stored token if new one is returned
		var data map[string]interface{}
		if err := result.Decode(&data); err == nil {
			if token, ok := data["token"].(string); ok && token != "" {
				cfg, err := loadConfig()
				if err == nil {
					cfg.Auth.IMToken = token
					if expires, ok := data["expiresIn"].(string); ok && expires != "" {
						cfg.Auth.IMTokenExpires = expires
					}
					if saveErr := saveConfig(cfg); saveErr == nil {
						fmt.Println("Token refreshed and saved.")
						return nil
					}
				}
			}
		}
		fmt.Println("Token refreshed (no new token in response).")
		return nil
	},
}

func init() {
	tokenRefreshCmd.Flags().BoolVar(&tokenRefreshJSON, "json", false, "Output raw JSON")
	tokenCmd.AddCommand(tokenRefreshCmd)
	rootCmd.AddCommand(tokenCmd)
}

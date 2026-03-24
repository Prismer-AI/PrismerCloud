package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	prismer "github.com/Prismer-AI/Prismer/sdk/golang"
	"github.com/spf13/cobra"
)

var (
	registerType        string
	registerDisplayName string
	registerAgentType   string
	registerCapabilities string
)

func init() {
	registerCmd.Flags().StringVar(&registerType, "type", "agent", "Account type (e.g. agent)")
	registerCmd.Flags().StringVar(&registerDisplayName, "display-name", "", "Display name for the agent")
	registerCmd.Flags().StringVar(&registerAgentType, "agent-type", "", "Agent type: assistant, specialist, orchestrator, tool, bot")
	registerCmd.Flags().StringVar(&registerCapabilities, "capabilities", "", "Comma-separated list of capabilities")
	rootCmd.AddCommand(registerCmd)
}

var registerCmd = &cobra.Command{
	Use:   "register <username>",
	Short: "Register an IM agent",
	Long:  "Register a new IM agent with the Prismer platform and store the returned token locally.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		username := args[0]

		cfg, err := loadConfig()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}
		if cfg.Default.APIKey == "" {
			return fmt.Errorf("no API key configured; run 'prismer init <api-key>' first")
		}

		// Build client options.
		var opts []prismer.ClientOption
		if cfg.Default.BaseURL != "" {
			opts = append(opts, prismer.WithBaseURL(cfg.Default.BaseURL))
		} else if cfg.Default.Environment != "" && cfg.Default.Environment != "production" {
			opts = append(opts, prismer.WithEnvironment(prismer.Environment(cfg.Default.Environment)))
		}

		client := prismer.NewClient(cfg.Default.APIKey, opts...)

		// Build register options.
		displayName := registerDisplayName
		if displayName == "" {
			displayName = username
		}

		regOpts := &prismer.IMRegisterOptions{
			Type:        registerType,
			Username:    username,
			DisplayName: displayName,
		}
		if registerAgentType != "" {
			regOpts.AgentType = registerAgentType
		}
		if registerCapabilities != "" {
			caps := strings.Split(registerCapabilities, ",")
			trimmed := make([]string, 0, len(caps))
			for _, c := range caps {
				c = strings.TrimSpace(c)
				if c != "" {
					trimmed = append(trimmed, c)
				}
			}
			regOpts.Capabilities = trimmed
		}

		// Call the API.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		result, err := client.IM().Account.Register(ctx, regOpts)
		if err != nil {
			return fmt.Errorf("registration request failed: %w", err)
		}
		if !result.OK {
			if result.Error != nil {
				return fmt.Errorf("registration failed: %s: %s", result.Error.Code, result.Error.Message)
			}
			return fmt.Errorf("registration failed: unknown error")
		}

		// Decode the response.
		var reg prismer.IMRegisterData
		if err := result.Decode(&reg); err != nil {
			return fmt.Errorf("failed to decode registration response: %w", err)
		}

		// Store token and identity in config.
		cfg.Auth.IMToken = reg.Token
		cfg.Auth.IMUserID = reg.IMUserID
		cfg.Auth.IMUsername = reg.Username
		cfg.Auth.IMTokenExpires = reg.ExpiresIn

		if err := saveConfig(cfg); err != nil {
			return fmt.Errorf("failed to save config: %w", err)
		}

		fmt.Println("Registration successful!")
		fmt.Printf("  User ID:  %s\n", reg.IMUserID)
		fmt.Printf("  Username: %s\n", reg.Username)
		fmt.Printf("  Role:     %s\n", reg.Role)
		if reg.IsNew {
			fmt.Println("  (new account created)")
		}
		fmt.Printf("  Token expires: %s\n", reg.ExpiresIn)
		return nil
	},
}

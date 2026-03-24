package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(initCmd)
}

var initCmd = &cobra.Command{
	Use:   "init <api-key>",
	Short: "Store API key in ~/.prismer/config.toml",
	Long:  "Initialize Prismer CLI by storing your API key in the local configuration file.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		apiKey := args[0]

		cfg, err := loadConfig()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		cfg.Default.APIKey = apiKey
		if cfg.Default.Environment == "" {
			cfg.Default.Environment = "production"
		}

		if err := saveConfig(cfg); err != nil {
			return fmt.Errorf("failed to save config: %w", err)
		}

		path, _ := configPath()
		fmt.Printf("API key saved to %s\n", path)
		return nil
	},
}

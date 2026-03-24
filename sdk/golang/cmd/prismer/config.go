package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.AddCommand(configCmd)
	configCmd.AddCommand(configShowCmd)
	configCmd.AddCommand(configSetCmd)
}

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage Prismer configuration",
	Long:  "View or modify the Prismer CLI configuration stored in ~/.prismer/config.toml.",
}

var configShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Print the current configuration file",
	RunE: func(cmd *cobra.Command, args []string) error {
		path, err := configPath()
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Println("No configuration file found. Run 'prismer init <api-key>' to create one.")
				return nil
			}
			return fmt.Errorf("cannot read config file: %w", err)
		}
		fmt.Print(string(data))
		return nil
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set a configuration value",
	Long:  "Set a configuration value using dot notation.\nExample: prismer config set default.api_key sk-prismer-...",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		key, value := args[0], args[1]

		cfg, err := loadConfig()
		if err != nil {
			return fmt.Errorf("failed to load config: %w", err)
		}

		if err := setConfigValue(cfg, key, value); err != nil {
			return err
		}

		if err := saveConfig(cfg); err != nil {
			return fmt.Errorf("failed to save config: %w", err)
		}

		fmt.Printf("Set %s = %s\n", key, value)
		return nil
	},
}

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

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

package main

import (
	"fmt"
	"os"

	prismer "github.com/Prismer-AI/Prismer/sdk/golang"
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

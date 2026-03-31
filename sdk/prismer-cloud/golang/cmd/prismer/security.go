package main

import (
	"fmt"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/golang"
	"github.com/spf13/cobra"
)

// ============================================================================
// security command group
// ============================================================================

var securityCmd = &cobra.Command{
	Use:   "security",
	Short: "Per-conversation encryption and key management",
}

// ── security get ────────────────────────────────────────

var securityGetJSON bool
var securityGetCmd = &cobra.Command{
	Use:   "get <conversation-id>",
	Short: "Get security settings for a conversation",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Security.GetConversationSecurity(ctx, args[0])
		if err != nil {
			return err
		}
		if securityGetJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Encryption Mode: %v\n", data["encryptionMode"])
		fmt.Printf("Signing Policy:  %v\n", data["signingPolicy"])
		return nil
	},
}

// ── security set ────────────────────────────────────────

var securitySetMode string
var securitySetJSON bool
var securitySetCmd = &cobra.Command{
	Use:   "set <conversation-id>",
	Short: "Set encryption mode for a conversation",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Security.SetConversationSecurity(ctx, args[0], map[string]interface{}{
			"encryptionMode": securitySetMode,
		})
		if err != nil {
			return err
		}
		if securitySetJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		fmt.Printf("Encryption mode set to: %s\n", securitySetMode)
		return nil
	},
}

// ── security upload-key ─────────────────────────────────

var (
	securityUploadKeyKey       string
	securityUploadKeyAlgorithm string
	securityUploadKeyJSON      bool
)

var securityUploadKeyCmd = &cobra.Command{
	Use:   "upload-key <conversation-id>",
	Short: "Upload an ECDH public key for a conversation",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Security.UploadKey(ctx, args[0], securityUploadKeyKey, securityUploadKeyAlgorithm)
		if err != nil {
			return err
		}
		if securityUploadKeyJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		fmt.Printf("Key uploaded (algorithm: %s)\n", securityUploadKeyAlgorithm)
		return nil
	},
}

// ── security keys ───────────────────────────────────────

var securityKeysJSON bool
var securityKeysCmd = &cobra.Command{
	Use:   "keys <conversation-id>",
	Short: "List all member public keys for a conversation",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Security.GetKeys(ctx, args[0])
		if err != nil {
			return err
		}
		if securityKeysJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		keys := asList(res.Data)
		if len(keys) == 0 {
			fmt.Println("No keys found.")
			return nil
		}
		fmt.Printf("%-36s  %-16s  %s\n", "User ID", "Algorithm", "Public Key")
		for _, k := range keys {
			km := asMap(k)
			fmt.Printf("%-36v  %-16v  %v\n", km["userId"], km["algorithm"], km["publicKey"])
		}
		return nil
	},
}

// ── security revoke-key ─────────────────────────────────

var securityRevokeKeyJSON bool
var securityRevokeKeyCmd = &cobra.Command{
	Use:   "revoke-key <conversation-id> <user-id>",
	Short: "Revoke a member key from a conversation",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Security.RevokeKey(ctx, args[0], args[1])
		if err != nil {
			return err
		}
		if securityRevokeKeyJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		fmt.Printf("Key revoked for user: %s\n", args[1])
		return nil
	},
}

// ============================================================================
// identity command group
// ============================================================================

var identityCmd = &cobra.Command{
	Use:   "identity",
	Short: "Identity key management and audit log verification",
}

// ── identity server-key ─────────────────────────────────

var identityServerKeyJSON bool
var identityServerKeyCmd = &cobra.Command{
	Use:   "server-key",
	Short: "Get the server's identity public key",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Identity.GetServerKey(ctx)
		if err != nil {
			return err
		}
		if identityServerKeyJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Server Public Key: %v\n", data["publicKey"])
		return nil
	},
}

// ── identity register-key ───────────────────────────────

var (
	identityRegisterKeyAlgorithm string
	identityRegisterKeyPublicKey string
	identityRegisterKeyJSON      bool
)

var identityRegisterKeyCmd = &cobra.Command{
	Use:   "register-key",
	Short: "Register an identity public key",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Identity.RegisterKey(ctx, &prismer.RegisterKeyOptions{
			PublicKey: identityRegisterKeyPublicKey,
		})
		if err != nil {
			return err
		}
		if identityRegisterKeyJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		fmt.Printf("Identity key registered (algorithm: %s)\n", identityRegisterKeyAlgorithm)
		return nil
	},
}

// ── identity get-key ────────────────────────────────────

var identityGetKeyJSON bool
var identityGetKeyCmd = &cobra.Command{
	Use:   "get-key <user-id>",
	Short: "Get a user's identity public key",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Identity.GetKey(ctx, args[0])
		if err != nil {
			return err
		}
		if identityGetKeyJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Algorithm:  %v\n", data["algorithm"])
		fmt.Printf("Public Key: %v\n", data["publicKey"])
		return nil
	},
}

// ── identity revoke-key ─────────────────────────────────

var identityRevokeKeyJSON bool
var identityRevokeKeyCmd = &cobra.Command{
	Use:   "revoke-key",
	Short: "Revoke your own identity key",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Identity.RevokeKey(ctx)
		if err != nil {
			return err
		}
		if identityRevokeKeyJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		fmt.Println("Identity key revoked.")
		return nil
	},
}

// ── identity audit-log ──────────────────────────────────

var identityAuditLogJSON bool
var identityAuditLogCmd = &cobra.Command{
	Use:   "audit-log <user-id>",
	Short: "Get key audit log entries for a user",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Identity.GetAuditLog(ctx, args[0])
		if err != nil {
			return err
		}
		if identityAuditLogJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		entries := asList(res.Data)
		if len(entries) == 0 {
			fmt.Println("No audit log entries.")
			return nil
		}
		fmt.Printf("%-24s  %-20s  %s\n", "Date", "Action", "Details")
		for _, e := range entries {
			em := asMap(e)
			fmt.Printf("%-24v  %-20v  %v\n", em["createdAt"], em["action"], em["details"])
		}
		return nil
	},
}

// ── identity verify-audit ───────────────────────────────

var identityVerifyAuditJSON bool
var identityVerifyAuditCmd = &cobra.Command{
	Use:   "verify-audit <user-id>",
	Short: "Verify the integrity of the key audit log for a user",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Identity.VerifyAuditLog(ctx, args[0])
		if err != nil {
			return err
		}
		if identityVerifyAuditJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		if valid, ok := data["valid"].(bool); ok && valid {
			fmt.Println("Audit log verified: VALID")
		} else {
			fmt.Println("Audit log verified: INVALID")
		}
		return nil
	},
}

func init() {
	// security
	securitySetCmd.Flags().StringVar(&securitySetMode, "mode", "", "Encryption mode: none, available, or required")
	securitySetCmd.Flags().BoolVar(&securitySetJSON, "json", false, "Output raw JSON")
	_ = securitySetCmd.MarkFlagRequired("mode")
	securityGetCmd.Flags().BoolVar(&securityGetJSON, "json", false, "Output raw JSON")
	securityUploadKeyCmd.Flags().StringVar(&securityUploadKeyKey, "key", "", "Base64-encoded public key")
	securityUploadKeyCmd.Flags().StringVar(&securityUploadKeyAlgorithm, "algorithm", "ecdh-p256", "Key algorithm")
	securityUploadKeyCmd.Flags().BoolVar(&securityUploadKeyJSON, "json", false, "Output raw JSON")
	_ = securityUploadKeyCmd.MarkFlagRequired("key")
	securityKeysCmd.Flags().BoolVar(&securityKeysJSON, "json", false, "Output raw JSON")
	securityRevokeKeyCmd.Flags().BoolVar(&securityRevokeKeyJSON, "json", false, "Output raw JSON")

	securityCmd.AddCommand(securityGetCmd)
	securityCmd.AddCommand(securitySetCmd)
	securityCmd.AddCommand(securityUploadKeyCmd)
	securityCmd.AddCommand(securityKeysCmd)
	securityCmd.AddCommand(securityRevokeKeyCmd)
	rootCmd.AddCommand(securityCmd)

	// identity
	identityServerKeyCmd.Flags().BoolVar(&identityServerKeyJSON, "json", false, "Output raw JSON")
	identityRegisterKeyCmd.Flags().StringVar(&identityRegisterKeyAlgorithm, "algorithm", "", "Key algorithm (e.g. ed25519, ecdh-p256)")
	identityRegisterKeyCmd.Flags().StringVar(&identityRegisterKeyPublicKey, "public-key", "", "Base64-encoded public key")
	identityRegisterKeyCmd.Flags().BoolVar(&identityRegisterKeyJSON, "json", false, "Output raw JSON")
	_ = identityRegisterKeyCmd.MarkFlagRequired("algorithm")
	_ = identityRegisterKeyCmd.MarkFlagRequired("public-key")
	identityGetKeyCmd.Flags().BoolVar(&identityGetKeyJSON, "json", false, "Output raw JSON")
	identityRevokeKeyCmd.Flags().BoolVar(&identityRevokeKeyJSON, "json", false, "Output raw JSON")
	identityAuditLogCmd.Flags().BoolVar(&identityAuditLogJSON, "json", false, "Output raw JSON")
	identityVerifyAuditCmd.Flags().BoolVar(&identityVerifyAuditJSON, "json", false, "Output raw JSON")

	identityCmd.AddCommand(identityServerKeyCmd)
	identityCmd.AddCommand(identityRegisterKeyCmd)
	identityCmd.AddCommand(identityGetKeyCmd)
	identityCmd.AddCommand(identityRevokeKeyCmd)
	identityCmd.AddCommand(identityAuditLogCmd)
	identityCmd.AddCommand(identityVerifyAuditCmd)
	rootCmd.AddCommand(identityCmd)
}

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

var skillCmd = &cobra.Command{
	Use:   "skill",
	Short: "Skill catalog commands",
}

// safeSlug sanitizes a slug to prevent directory traversal attacks.
func safeSlug(s string) string {
	s = strings.ReplaceAll(s, "..", "")
	s = strings.ReplaceAll(s, "/", "")
	s = strings.ReplaceAll(s, "\\", "")
	s = strings.ReplaceAll(s, "\x00", "")
	return filepath.Base(s)
}

// ── platform paths ─────────────────────────────────────

type platformDef struct {
	name       string
	globalDir  string // relative to home dir
	projectDir string // relative to cwd
}

func pluginGlobalDir() string {
	pluginDir := os.Getenv("PRISMER_PLUGIN_DIR")
	if pluginDir != "" {
		return filepath.Join(pluginDir, "skills")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".claude", "plugins", "prismer", "skills")
	}
	return filepath.Join(home, ".claude", "plugins", "prismer", "skills")
}

var platforms = []platformDef{
	{name: "claude-code", globalDir: ".claude/skills", projectDir: ".claude/skills"},
	{name: "openclaw", globalDir: ".openclaw/skills", projectDir: "skills"},
	{name: "opencode", globalDir: ".config/opencode/skills", projectDir: ".opencode/skills"},
	{name: "plugin", globalDir: "", projectDir: ".claude/plugins/prismer/skills"},
}

// detectPlatforms returns the platforms whose global directory exists on this machine.
func detectPlatforms() []platformDef {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var found []platformDef
	for _, p := range platforms {
		if p.name == "plugin" {
			// Plugin uses dynamic global dir, check if it exists
			pDir := pluginGlobalDir()
			parentDir := filepath.Dir(pDir)
			if fi, err := os.Stat(parentDir); err == nil && fi.IsDir() {
				found = append(found, p)
			}
			continue
		}
		dir := filepath.Join(home, filepath.Dir(p.globalDir))
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			found = append(found, p)
		}
	}
	return found
}

// resolvedPaths returns the file paths to write SKILL.md for each target platform.
func resolvedPaths(slug, platform string, project bool) ([]string, error) {
	var targets []platformDef
	if platform == "all" {
		targets = detectPlatforms()
		if len(targets) == 0 {
			// fallback: use all platforms
			targets = platforms
		}
	} else {
		for _, p := range platforms {
			if p.name == platform {
				targets = append(targets, p)
				break
			}
		}
		if len(targets) == 0 {
			return nil, fmt.Errorf("unknown platform %q (valid: claude-code, openclaw, opencode, plugin, all)", platform)
		}
	}

	var paths []string
	for _, t := range targets {
		var base string
		if project {
			cwd, err := os.Getwd()
			if err != nil {
				return nil, err
			}
			base = filepath.Join(cwd, t.projectDir)
		} else if t.name == "plugin" {
			base = pluginGlobalDir()
		} else {
			home, err := os.UserHomeDir()
			if err != nil {
				return nil, err
			}
			base = filepath.Join(home, t.globalDir)
		}
		paths = append(paths, filepath.Join(base, slug, "SKILL.md"))
	}
	return paths, nil
}

// writeSkillLocal writes SKILL.md content to the given paths.
func writeSkillLocal(paths []string, content string) []string {
	var written []string
	for _, p := range paths {
		dir := filepath.Dir(p)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ mkdir %s: %v\n", dir, err)
			continue
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ write %s: %v\n", p, err)
			continue
		}
		written = append(written, p)
	}
	return written
}

// removeSkillLocal removes skill directories for the given paths.
func removeSkillLocal(slug, platform string, project bool) []string {
	paths, err := resolvedPaths(slug, platform, project)
	if err != nil {
		return nil
	}
	var removed []string
	for _, p := range paths {
		dir := filepath.Dir(p) // …/{slug}/
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			fmt.Fprintf(os.Stderr, "  ⚠ remove %s: %v\n", dir, err)
			continue
		}
		removed = append(removed, dir)
	}
	return removed
}

// tildeify replaces the home directory prefix with ~ for display.
func tildeify(p string) string {
	if runtime.GOOS == "windows" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if strings.HasPrefix(p, home) {
		return "~" + p[len(home):]
	}
	return p
}

// ── skill search ────────────────────────────────────────

var skillSearchCategory string
var skillSearchLimit int
var skillSearchJSON bool
var skillSearchCmd = &cobra.Command{
	Use:   "search [query]",
	Short: "Search the skill catalog",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		query := ""
		if len(args) > 0 {
			query = args[0]
		}
		res, err := client.Evolution.SearchSkills(ctx, query, skillSearchCategory, skillSearchLimit)
		if err != nil {
			return err
		}
		if skillSearchJSON {
			return printJSON(res)
		}
		skills := asList(res.Data)
		if len(skills) == 0 {
			fmt.Println("No skills found.")
			return nil
		}
		for _, s := range skills {
			sm := s.(map[string]interface{})
			fmt.Printf("  %-20v  %-12v  %v\n", sm["slug"], sm["category"], sm["description"])
		}
		fmt.Printf("\n%d skill(s)\n", len(skills))
		return nil
	},
}

// ── skill install ───────────────────────────────────────

var (
	skillInstallJSON     bool
	skillInstallPlatform string
	skillInstallProject  bool
	skillInstallNoLocal  bool
)

var skillInstallCmd = &cobra.Command{
	Use:   "install <slug>",
	Short: "Install a skill from the catalog",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		slug := safeSlug(args[0])
		if slug == "" || slug == "." {
			return fmt.Errorf("invalid slug")
		}
		client := getIMClient().IM()
		ctx := cmd.Context()

		// 1. Cloud install
		res, err := client.Evolution.InstallSkill(ctx, slug)
		if err != nil {
			return err
		}
		if skillInstallJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("Installed: %v\n", slug)
		if geneID, ok := data["geneId"]; ok {
			fmt.Printf("Gene ID:   %v\n", geneID)
		}

		if skillInstallNoLocal {
			return nil
		}

		// 2. Get content
		content, _ := data["content"].(string)
		if content == "" {
			// Fetch content from cloud
			contentRes, err := client.Evolution.GetSkillContent(ctx, slug)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: could not fetch skill content: %v\n", err)
				return nil
			}
			cd := asMap(contentRes.Data)
			content, _ = cd["content"].(string)
		}
		if content == "" {
			fmt.Println("No SKILL.md content available for local sync.")
			return nil
		}

		// 3. Write local files
		paths, err := resolvedPaths(slug, skillInstallPlatform, skillInstallProject)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
			return nil
		}
		written := writeSkillLocal(paths, content)
		if len(written) > 0 {
			fmt.Println("\nLocal files written:")
			for _, w := range written {
				fmt.Printf("  %s\n", tildeify(w))
			}
		}

		return nil
	},
}

// ── skill uninstall ─────────────────────────────────────

var (
	skillUninstallJSON     bool
	skillUninstallPlatform string
	skillUninstallProject  bool
	skillUninstallNoLocal  bool
)

var skillUninstallCmd = &cobra.Command{
	Use:   "uninstall <slug>",
	Short: "Uninstall a skill",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		slug := safeSlug(args[0])
		if slug == "" || slug == "." {
			return fmt.Errorf("invalid slug")
		}
		client := getIMClient().IM()
		ctx := cmd.Context()

		// 1. Cloud uninstall
		res, err := client.Evolution.UninstallSkill(ctx, slug)
		if err != nil {
			return err
		}
		if skillUninstallJSON {
			return printJSON(res)
		}
		fmt.Printf("Uninstalled: %v\n", slug)
		_ = res

		if skillUninstallNoLocal {
			return nil
		}

		// 2. Remove local files
		removed := removeSkillLocal(slug, skillUninstallPlatform, skillUninstallProject)
		if len(removed) > 0 {
			fmt.Println("\nLocal directories removed:")
			for _, r := range removed {
				fmt.Printf("  %s\n", tildeify(r))
			}
		}

		return nil
	},
}

// ── skill sync ─────────────────────────────────────────

var (
	skillSyncPlatform string
	skillSyncProject  bool
	skillSyncJSON     bool
)

var skillSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Sync all installed skills to local files",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		// 1. Get installed skills list
		listRes, err := client.Evolution.InstalledSkills(ctx)
		if err != nil {
			return fmt.Errorf("failed to list installed skills: %w", err)
		}
		skills := asList(listRes.Data)
		if len(skills) == 0 {
			fmt.Println("No skills installed.")
			return nil
		}

		fmt.Printf("Syncing %d skill(s)...\n", len(skills))
		var synced, failed int

		for _, s := range skills {
			sm, ok := s.(map[string]interface{})
			if !ok {
				failed++
				continue
			}
			skillData, _ := sm["skill"].(map[string]interface{})
		rawSlug, _ := skillData["slug"].(string)
		slug := safeSlug(rawSlug)
			if slug == "" || slug == "." {
				failed++
				continue
			}

			// Get content
			contentRes, err := client.Evolution.GetSkillContent(ctx, slug)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  ⚠ %s: %v\n", slug, err)
				failed++
				continue
			}
			cd := asMap(contentRes.Data)
			content, _ := cd["content"].(string)
			if content == "" {
				fmt.Fprintf(os.Stderr, "  ⚠ %s: no content\n", slug)
				failed++
				continue
			}

			paths, err := resolvedPaths(slug, skillSyncPlatform, skillSyncProject)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  ⚠ %s: %v\n", slug, err)
				failed++
				continue
			}
			written := writeSkillLocal(paths, content)
			if len(written) > 0 {
				synced++
				for _, w := range written {
					fmt.Printf("  ✓ %s → %s\n", slug, tildeify(w))
				}
			} else {
				failed++
			}
		}

		fmt.Printf("\nSync complete: %d succeeded, %d failed\n", synced, failed)
		return nil
	},
}

// ── skill list ──────────────────────────────────────────

var skillListJSON bool
var skillListCmd = &cobra.Command{
	Use:   "list",
	Short: "List installed skills",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.InstalledSkills(ctx)
		if err != nil {
			return err
		}
		if skillListJSON {
			return printJSON(res)
		}
		skills := asList(res.Data)
		if len(skills) == 0 {
			fmt.Println("No skills installed.")
			return nil
		}
		for _, s := range skills {
			sm := s.(map[string]interface{})
			sd, _ := sm["skill"].(map[string]interface{})
			if sd == nil {
				sd = sm // fallback to flat structure
			}
			fmt.Printf("  %-20v  %-12v  %v\n", sd["slug"], sd["category"], sd["description"])
		}
		fmt.Printf("\n%d skill(s) installed\n", len(skills))
		return nil
	},
}

// ── skill show ──────────────────────────────────────────

var skillShowJSON bool
var skillShowCmd = &cobra.Command{
	Use:   "show <slug>",
	Short: "Show skill content (SKILL.md + package info)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Evolution.GetSkillContent(ctx, args[0])
		if err != nil {
			return err
		}
		if skillShowJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("Slug:        %v\n", data["slug"])
		fmt.Printf("Category:    %v\n", data["category"])
		fmt.Printf("Description: %v\n", data["description"])
		if content, ok := data["content"]; ok && content != nil {
			fmt.Printf("\n--- SKILL.md ---\n%v\n", content)
		}
		return nil
	},
}

// ── skill export ────────────────────────────────────────

var skillExportSlug, skillExportDesc string
var skillExportJSON bool
var skillExportCmd = &cobra.Command{
	Use:   "export <geneId>",
	Short: "Export a Gene as a Skill",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		opts := map[string]interface{}{}
		if skillExportSlug != "" {
			opts["slug"] = skillExportSlug
		}
		if skillExportDesc != "" {
			opts["description"] = skillExportDesc
		}
		res, err := client.Evolution.ExportGeneAsSkill(ctx, args[0], opts)
		if err != nil {
			return err
		}
		if skillExportJSON {
			return printJSON(res)
		}
		data := asMap(res.Data)
		fmt.Printf("Exported gene %v as skill\n", args[0])
		if slug, ok := data["slug"]; ok {
			fmt.Printf("Slug: %v\n", slug)
		}
		return nil
	},
}

func init() {
	skillSearchCmd.Flags().StringVarP(&skillSearchCategory, "category", "c", "", "Filter by category")
	skillSearchCmd.Flags().IntVarP(&skillSearchLimit, "limit", "l", 0, "Max results (default: server default)")
	skillSearchCmd.Flags().BoolVar(&skillSearchJSON, "json", false, "JSON output")

	skillInstallCmd.Flags().BoolVar(&skillInstallJSON, "json", false, "JSON output")
	skillInstallCmd.Flags().StringVar(&skillInstallPlatform, "platform", "all", "Target platform (claude-code, openclaw, opencode, plugin, all)")
	skillInstallCmd.Flags().BoolVar(&skillInstallProject, "project", false, "Write to project-level path instead of global")
	skillInstallCmd.Flags().BoolVar(&skillInstallNoLocal, "no-local", false, "Skip local file sync")

	skillUninstallCmd.Flags().BoolVar(&skillUninstallJSON, "json", false, "JSON output")
	skillUninstallCmd.Flags().StringVar(&skillUninstallPlatform, "platform", "all", "Target platform (claude-code, openclaw, opencode, plugin, all)")
	skillUninstallCmd.Flags().BoolVar(&skillUninstallProject, "project", false, "Remove from project-level path instead of global")
	skillUninstallCmd.Flags().BoolVar(&skillUninstallNoLocal, "no-local", false, "Skip local file removal")

	skillSyncCmd.Flags().StringVar(&skillSyncPlatform, "platform", "all", "Target platform (claude-code, openclaw, opencode, plugin, all)")
	skillSyncCmd.Flags().BoolVar(&skillSyncProject, "project", false, "Write to project-level path instead of global")
	skillSyncCmd.Flags().BoolVar(&skillSyncJSON, "json", false, "JSON output")

	skillListCmd.Flags().BoolVar(&skillListJSON, "json", false, "JSON output")
	skillShowCmd.Flags().BoolVar(&skillShowJSON, "json", false, "JSON output")

	skillExportCmd.Flags().StringVar(&skillExportSlug, "slug", "", "Custom slug for the exported skill")
	skillExportCmd.Flags().StringVar(&skillExportDesc, "description", "", "Description for the exported skill")
	skillExportCmd.Flags().BoolVar(&skillExportJSON, "json", false, "JSON output")

	skillCmd.AddCommand(skillSearchCmd)
	skillCmd.AddCommand(skillInstallCmd)
	skillCmd.AddCommand(skillUninstallCmd)
	skillCmd.AddCommand(skillSyncCmd)
	skillCmd.AddCommand(skillListCmd)
	skillCmd.AddCommand(skillShowCmd)
	skillCmd.AddCommand(skillExportCmd)
	rootCmd.AddCommand(skillCmd)
}

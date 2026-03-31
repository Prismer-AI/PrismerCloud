package main

import (
	"fmt"
	"strings"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/golang"
	"github.com/spf13/cobra"
)

var workspaceCmd = &cobra.Command{
	Use:   "workspace",
	Short: "Workspace management — init, groups, and agent assignment",
}

// ── workspace init ──────────────────────────────────────

var (
	workspaceInitUserID          string
	workspaceInitUserName        string
	workspaceInitWorkspaceID     string
	workspaceInitJSON            bool
)

var workspaceInitCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a workspace with a user",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Workspace.Init(ctx, &prismer.IMWorkspaceInitOptions{
			WorkspaceID:     workspaceInitWorkspaceID,
			UserID:          workspaceInitUserID,
			UserDisplayName: workspaceInitUserName,
		})
		if err != nil {
			return err
		}
		if workspaceInitJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Workspace initialized (workspaceId: %v)\n", data["workspaceId"])
		return nil
	},
}

// ── workspace init-group ────────────────────────────────

var (
	workspaceInitGroupTitle   string
	workspaceInitGroupMembers string
	workspaceInitGroupWsID    string
	workspaceInitGroupJSON    bool
)

var workspaceInitGroupCmd = &cobra.Command{
	Use:   "init-group",
	Short: "Initialize a group workspace with a set of members",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		// Parse members: "userId:displayName,userId2:displayName2"
		var users []prismer.IMWorkspaceInitGroupUser
		if workspaceInitGroupMembers != "" {
			for _, m := range strings.Split(workspaceInitGroupMembers, ",") {
				m = strings.TrimSpace(m)
				if m == "" {
					continue
				}
				parts := strings.SplitN(m, ":", 2)
				u := prismer.IMWorkspaceInitGroupUser{UserID: parts[0]}
				if len(parts) > 1 {
					u.DisplayName = parts[1]
				}
				users = append(users, u)
			}
		}

		res, err := client.Workspace.InitGroup(ctx, &prismer.IMWorkspaceInitGroupOptions{
			WorkspaceID: workspaceInitGroupWsID,
			Title:       workspaceInitGroupTitle,
			Users:       users,
		})
		if err != nil {
			return err
		}
		if workspaceInitGroupJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Group workspace initialized (workspaceId: %v)\n", data["workspaceId"])
		return nil
	},
}

// ── workspace add-agent ─────────────────────────────────

var workspaceAddAgentJSON bool
var workspaceAddAgentCmd = &cobra.Command{
	Use:   "add-agent <workspace-id> <agent-id>",
	Short: "Add an agent to a workspace",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Workspace.AddAgent(ctx, args[0], args[1])
		if err != nil {
			return err
		}
		if workspaceAddAgentJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		fmt.Printf("Agent %s added to workspace %s.\n", args[1], args[0])
		return nil
	},
}

// ── workspace agents ────────────────────────────────────

var workspaceAgentsJSON bool
var workspaceAgentsCmd = &cobra.Command{
	Use:   "agents <workspace-id>",
	Short: "List agents in a workspace",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Workspace.ListAgents(ctx, args[0])
		if err != nil {
			return err
		}
		if workspaceAgentsJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		agents := asList(res.Data)
		if len(agents) == 0 {
			fmt.Println("No agents in this workspace.")
			return nil
		}
		fmt.Printf("%-36s  %-14s  %s\n", "Agent ID", "Type", "Name")
		for _, a := range agents {
			am := asMap(a)
			id := fmt.Sprintf("%v", am["agentId"])
			if id == "<nil>" {
				id = fmt.Sprintf("%v", am["id"])
			}
			fmt.Printf("%-36s  %-14v  %v\n", id, am["agentType"], am["displayName"])
		}
		return nil
	},
}

func init() {
	workspaceInitCmd.Flags().StringVar(&workspaceInitWorkspaceID, "workspace-id", "", "Workspace ID")
	workspaceInitCmd.Flags().StringVar(&workspaceInitUserID, "user-id", "", "User ID")
	workspaceInitCmd.Flags().StringVar(&workspaceInitUserName, "user-name", "", "User display name")
	workspaceInitCmd.Flags().BoolVar(&workspaceInitJSON, "json", false, "Output raw JSON")
	_ = workspaceInitCmd.MarkFlagRequired("user-id")
	_ = workspaceInitCmd.MarkFlagRequired("user-name")

	workspaceInitGroupCmd.Flags().StringVar(&workspaceInitGroupWsID, "workspace-id", "", "Workspace ID")
	workspaceInitGroupCmd.Flags().StringVar(&workspaceInitGroupTitle, "title", "", "Group title")
	workspaceInitGroupCmd.Flags().StringVar(&workspaceInitGroupMembers, "members", "", "Comma-separated list of userId:displayName pairs")
	workspaceInitGroupCmd.Flags().BoolVar(&workspaceInitGroupJSON, "json", false, "Output raw JSON")
	_ = workspaceInitGroupCmd.MarkFlagRequired("title")

	workspaceAddAgentCmd.Flags().BoolVar(&workspaceAddAgentJSON, "json", false, "Output raw JSON")
	workspaceAgentsCmd.Flags().BoolVar(&workspaceAgentsJSON, "json", false, "Output raw JSON")

	workspaceCmd.AddCommand(workspaceInitCmd)
	workspaceCmd.AddCommand(workspaceInitGroupCmd)
	workspaceCmd.AddCommand(workspaceAddAgentCmd)
	workspaceCmd.AddCommand(workspaceAgentsCmd)
	rootCmd.AddCommand(workspaceCmd)
}

package main

import (
	"fmt"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/golang"
	"github.com/spf13/cobra"
)

var taskCmd = &cobra.Command{
	Use:   "task",
	Short: "Manage tasks in the task marketplace",
}

// ── task create ─────────────────────────────────────────

var (
	taskCreateTitle       string
	taskCreateDesc        string
	taskCreateCapability  string
	taskCreateBudget      float64
	taskCreateJSON        bool
)

var taskCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a new task",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		opts := &prismer.CreateTaskOptions{
			Title:       taskCreateTitle,
			Description: taskCreateDesc,
			Capability:  taskCreateCapability,
			Budget:      taskCreateBudget,
		}
		res, err := client.Tasks.Create(ctx, opts)
		if err != nil {
			return err
		}
		if taskCreateJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Task created successfully\n\n")
		fmt.Printf("ID:       %v\n", data["id"])
		fmt.Printf("Title:    %v\n", data["title"])
		fmt.Printf("Status:   %v\n", data["status"])
		if taskCreateDesc != "" {
			fmt.Printf("Desc:     %v\n", data["description"])
		}
		if taskCreateCapability != "" {
			fmt.Printf("Capability: %v\n", data["capability"])
		}
		return nil
	},
}

// ── task list ───────────────────────────────────────────

var (
	taskListStatus     string
	taskListCapability string
	taskListLimit      int
	taskListJSON       bool
)

var taskListCmd = &cobra.Command{
	Use:   "list",
	Short: "List tasks",
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()

		opts := &prismer.TaskListOptions{
			Capability: taskListCapability,
			Limit:      taskListLimit,
		}
		if taskListStatus != "" {
			opts.Status = prismer.TaskStatus(taskListStatus)
		}
		res, err := client.Tasks.List(ctx, opts)
		if err != nil {
			return err
		}
		if taskListJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		tasks := asList(res.Data)
		if len(tasks) == 0 {
			fmt.Println("No tasks found.")
			return nil
		}
		const idW, statusW, capW = 24, 10, 14
		header := "ID" + pad("", idW-2) + "  " + "STATUS" + pad("", statusW-6) + "  " + "CAPABILITY" + pad("", capW-10) + "  TITLE"
		fmt.Println(header)
		fmt.Println(repeatStr("-", idW+statusW+capW+30))
		for _, t := range tasks {
			tm := asMap(t)
			id := fmt.Sprintf("%v", tm["id"])
			status := fmt.Sprintf("%v", tm["status"])
			cap := fmt.Sprintf("%v", tm["capability"])
			title := fmt.Sprintf("%v", tm["title"])
			fmt.Printf("%-*s  %-*s  %-*s  %s\n", idW, id, statusW, status, capW, cap, title)
		}
		fmt.Printf("\n%d task(s) listed.\n", len(tasks))
		return nil
	},
}

// ── task get ────────────────────────────────────────────

var taskGetJSON bool
var taskGetCmd = &cobra.Command{
	Use:   "get <task-id>",
	Short: "Get task details and logs",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Tasks.Get(ctx, args[0])
		if err != nil {
			return err
		}
		if taskGetJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("ID:        %v\n", data["id"])
		fmt.Printf("Title:     %v\n", data["title"])
		fmt.Printf("Status:    %v\n", data["status"])
		if v := data["description"]; v != nil && v != "" {
			fmt.Printf("Desc:      %v\n", v)
		}
		if v := data["capability"]; v != nil && v != "" {
			fmt.Printf("Capability: %v\n", v)
		}
		if v := data["creatorId"]; v != nil && v != "" {
			fmt.Printf("Creator:   %v\n", v)
		}
		if v := data["assigneeId"]; v != nil && v != "" {
			fmt.Printf("Assignee:  %v\n", v)
		}
		if v := data["result"]; v != nil && v != "" {
			fmt.Printf("Result:    %v\n", v)
		}
		return nil
	},
}

// ── task claim ──────────────────────────────────────────

var taskClaimJSON bool
var taskClaimCmd = &cobra.Command{
	Use:   "claim <task-id>",
	Short: "Claim a pending task",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Tasks.Claim(ctx, args[0])
		if err != nil {
			return err
		}
		if taskClaimJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Task claimed successfully\n\n")
		fmt.Printf("ID:     %v\n", data["id"])
		fmt.Printf("Title:  %v\n", data["title"])
		fmt.Printf("Status: %v\n", data["status"])
		return nil
	},
}

// ── task update ─────────────────────────────────────────

var (
	taskUpdateTitle string
	taskUpdateDesc  string
	taskUpdateJSON  bool
)

var taskUpdateCmd = &cobra.Command{
	Use:   "update <task-id>",
	Short: "Update a task",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Tasks.Update(ctx, args[0], &prismer.UpdateTaskOptions{})
		if err != nil {
			return err
		}
		if taskUpdateJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Task updated\n\n")
		fmt.Printf("ID:     %v\n", data["id"])
		fmt.Printf("Title:  %v\n", data["title"])
		fmt.Printf("Status: %v\n", data["status"])
		return nil
	},
}

// ── task complete ───────────────────────────────────────

var taskCompleteResult string
var taskCompleteJSON bool
var taskCompleteCmd = &cobra.Command{
	Use:   "complete <task-id>",
	Short: "Mark a task as complete",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		opts := &prismer.CompleteTaskOptions{}
		if taskCompleteResult != "" {
			opts.Result = taskCompleteResult
		}
		res, err := client.Tasks.Complete(ctx, args[0], opts)
		if err != nil {
			return err
		}
		if taskCompleteJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Task completed\n\n")
		fmt.Printf("ID:     %v\n", data["id"])
		fmt.Printf("Title:  %v\n", data["title"])
		fmt.Printf("Status: %v\n", data["status"])
		if v := data["result"]; v != nil && v != "" {
			fmt.Printf("Result: %v\n", v)
		}
		return nil
	},
}

// ── task fail ───────────────────────────────────────────

var taskFailError string
var taskFailJSON bool
var taskFailCmd = &cobra.Command{
	Use:   "fail <task-id>",
	Short: "Mark a task as failed",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		client := getIMClient().IM()
		ctx := cmd.Context()
		res, err := client.Tasks.Fail(ctx, args[0], taskFailError, nil)
		if err != nil {
			return err
		}
		if taskFailJSON {
			return printJSON(res)
		}
		if !res.OK {
			return fmt.Errorf("API error: %v", res.Error)
		}
		data := asMap(res.Data)
		fmt.Printf("Task marked as failed\n\n")
		fmt.Printf("ID:     %v\n", data["id"])
		fmt.Printf("Title:  %v\n", data["title"])
		fmt.Printf("Status: %v\n", data["status"])
		return nil
	},
}

// ── helpers ─────────────────────────────────────────────

func pad(s string, n int) string {
	for len(s) < n {
		s += " "
	}
	return s
}

func repeatStr(s string, n int) string {
	result := ""
	for i := 0; i < n; i++ {
		result += s
	}
	return result
}

func init() {
	taskCreateCmd.Flags().StringVar(&taskCreateTitle, "title", "", "Task title")
	taskCreateCmd.Flags().StringVar(&taskCreateDesc, "description", "", "Task description")
	taskCreateCmd.Flags().StringVar(&taskCreateCapability, "capability", "", "Required agent capability")
	taskCreateCmd.Flags().Float64Var(&taskCreateBudget, "budget", 0, "Budget in credits")
	taskCreateCmd.Flags().BoolVar(&taskCreateJSON, "json", false, "Output raw JSON")
	_ = taskCreateCmd.MarkFlagRequired("title")

	taskListCmd.Flags().StringVar(&taskListStatus, "status", "", "Filter by status")
	taskListCmd.Flags().StringVar(&taskListCapability, "capability", "", "Filter by required capability")
	taskListCmd.Flags().IntVarP(&taskListLimit, "limit", "n", 20, "Maximum number of tasks to return")
	taskListCmd.Flags().BoolVar(&taskListJSON, "json", false, "Output raw JSON")

	taskGetCmd.Flags().BoolVar(&taskGetJSON, "json", false, "Output raw JSON")

	taskClaimCmd.Flags().BoolVar(&taskClaimJSON, "json", false, "Output raw JSON")

	taskUpdateCmd.Flags().StringVar(&taskUpdateTitle, "title", "", "New title")
	taskUpdateCmd.Flags().StringVar(&taskUpdateDesc, "description", "", "New description")
	taskUpdateCmd.Flags().BoolVar(&taskUpdateJSON, "json", false, "Output raw JSON")

	taskCompleteCmd.Flags().StringVar(&taskCompleteResult, "result", "", "Result or output of the task")
	taskCompleteCmd.Flags().BoolVar(&taskCompleteJSON, "json", false, "Output raw JSON")

	taskFailCmd.Flags().StringVar(&taskFailError, "error", "", "Error message describing why the task failed")
	taskFailCmd.Flags().BoolVar(&taskFailJSON, "json", false, "Output raw JSON")
	_ = taskFailCmd.MarkFlagRequired("error")

	taskCmd.AddCommand(taskCreateCmd)
	taskCmd.AddCommand(taskListCmd)
	taskCmd.AddCommand(taskGetCmd)
	taskCmd.AddCommand(taskClaimCmd)
	taskCmd.AddCommand(taskUpdateCmd)
	taskCmd.AddCommand(taskCompleteCmd)
	taskCmd.AddCommand(taskFailCmd)
	rootCmd.AddCommand(taskCmd)
}

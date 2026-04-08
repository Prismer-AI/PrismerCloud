package main

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

var communityCmd = &cobra.Command{
	Use:   "community",
	Short: "Evolution community forum",
}

func init() {
	var feedBoard string
	var feedLimit int
	var feedJSON bool
	feedCmd := &cobra.Command{
		Use:   "feed",
		Short: "List posts (hot sort)",
		RunE: func(cmd *cobra.Command, args []string) error {
			client := getIMClient()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			opts := map[string]string{"sort": "hot", "limit": fmt.Sprintf("%d", feedLimit)}
			if feedBoard != "" {
				opts["boardId"] = feedBoard
			}
			res, err := client.CommunityListPosts(ctx, opts)
			if err != nil {
				return err
			}
			if !res.OK {
				return imError(res)
			}
			if feedJSON {
				fmt.Println(string(res.Data))
				return nil
			}
			fmt.Println(string(res.Data))
			return nil
		},
	}
	feedCmd.Flags().StringVarP(&feedBoard, "board", "b", "", "Board id")
	feedCmd.Flags().IntVarP(&feedLimit, "limit", "n", 15, "Max posts")
	feedCmd.Flags().BoolVar(&feedJSON, "json", false, "JSON output")

	var searchBoard string
	var searchLimit int
	var searchJSON bool
	searchCmd := &cobra.Command{
		Use:   "search <query>",
		Short: "Full-text community search",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := getIMClient()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			opts := map[string]string{"limit": fmt.Sprintf("%d", searchLimit)}
			if searchBoard != "" {
				opts["boardId"] = searchBoard
			}
			res, err := client.CommunitySearch(ctx, args[0], opts)
			if err != nil {
				return err
			}
			if !res.OK {
				return imError(res)
			}
			if searchJSON {
				fmt.Println(string(res.Data))
				return nil
			}
			fmt.Println(string(res.Data))
			return nil
		},
	}
	searchCmd.Flags().StringVarP(&searchBoard, "board", "b", "", "Board id")
	searchCmd.Flags().IntVarP(&searchLimit, "limit", "n", 8, "Max hits")
	searchCmd.Flags().BoolVar(&searchJSON, "json", false, "JSON output")

	var askTags string
	var askJSON bool
	askCmd := &cobra.Command{
		Use:   "ask <title> <body>",
		Short: "Post a helpdesk question",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			client := getIMClient()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			body := map[string]interface{}{
				"boardId":  "helpdesk",
				"title":    args[0],
				"content":  args[1],
				"postType": "question",
			}
			if askTags != "" {
				body["tags"] = splitComma(askTags)
			}
			res, err := client.CommunityCreatePost(ctx, body)
			if err != nil {
				return err
			}
			if !res.OK {
				return imError(res)
			}
			if askJSON {
				fmt.Println(string(res.Data))
				return nil
			}
			fmt.Println(string(res.Data))
			return nil
		},
	}
	askCmd.Flags().StringVar(&askTags, "tags", "", "Comma-separated tags")
	askCmd.Flags().BoolVar(&askJSON, "json", false, "JSON output")

	var checkUnread bool
	var checkMarkRead bool
	var checkJSON bool
	checkCmd := &cobra.Command{
		Use:   "check",
		Short: "List notifications; optionally mark all read",
		RunE: func(cmd *cobra.Command, args []string) error {
			client := getIMClient()
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			res, err := client.CommunityGetNotifications(ctx, checkUnread, 50, 0)
			if err != nil {
				return err
			}
			if !res.OK {
				return imError(res)
			}
			if checkJSON {
				fmt.Println(string(res.Data))
			} else {
				fmt.Println(string(res.Data))
			}
			if checkMarkRead {
				mr, err := client.CommunityMarkNotificationsRead(ctx, "")
				if err != nil {
					return err
				}
				if checkJSON {
					fmt.Println(string(mr.Data))
				} else if !mr.OK {
					return imError(mr)
				}
			}
			return nil
		},
	}
	checkCmd.Flags().BoolVar(&checkUnread, "unread-only", false, "Unread only")
	checkCmd.Flags().BoolVar(&checkMarkRead, "mark-read", false, "Mark all read after list")
	checkCmd.Flags().BoolVar(&checkJSON, "json", false, "JSON output")

	communityCmd.AddCommand(feedCmd)
	communityCmd.AddCommand(searchCmd)
	communityCmd.AddCommand(askCmd)
	communityCmd.AddCommand(checkCmd)
	rootCmd.AddCommand(communityCmd)
}

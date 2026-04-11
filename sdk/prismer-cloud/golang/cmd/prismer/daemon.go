package main

import (
	"os"

	prismer "github.com/Prismer-AI/PrismerCloud/sdk/prismer-cloud/golang"
	"github.com/spf13/cobra"
)

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Daemon management: background evolution sync",
	Long:  "Manage the Prismer background daemon that syncs evolution data and flushes the outbox.",
}

var daemonStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the daemon as a background process",
	Run: func(cmd *cobra.Command, args []string) {
		if os.Getenv("PRISMER_DAEMON") == "1" {
			prismer.RunDaemonProcess()
			return
		}
		prismer.StartDaemon()
	},
}

var daemonStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the running daemon",
	Run: func(cmd *cobra.Command, args []string) {
		prismer.StopDaemon()
	},
}

var daemonStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check daemon status",
	Run: func(cmd *cobra.Command, args []string) {
		prismer.DaemonStatus()
	},
}

var daemonInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install daemon as a system service (launchd/systemd)",
	Long:  "Install the daemon as a persistent system service that starts on login.\nmacOS: launchd plist in ~/Library/LaunchAgents\nLinux: systemd user unit in ~/.config/systemd/user",
	Run: func(cmd *cobra.Command, args []string) {
		prismer.InstallDaemonService()
	},
}

var daemonUninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Uninstall the daemon system service",
	Run: func(cmd *cobra.Command, args []string) {
		prismer.UninstallDaemonService()
	},
}

func init() {
	daemonCmd.AddCommand(daemonStartCmd, daemonStopCmd, daemonStatusCmd, daemonInstallCmd, daemonUninstallCmd)
	rootCmd.AddCommand(daemonCmd)
}

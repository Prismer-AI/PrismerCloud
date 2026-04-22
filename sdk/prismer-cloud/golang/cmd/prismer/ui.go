// UI Package - CLI output utilities matching docs/version190/15-cli-design.md
//
// This package provides consistent, beautiful CLI output across all Prismer SDKs.
// Design reference: docs/version190/15-cli-design.md
//
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// ============================================================================
// Color codes
// ============================================================================

const (
	ColorReset = "\u001b[0m"
	ColorRed     = "\u001b[31m"
	ColorGreen   = "\u001b[32m"
	ColorYellow = "\u001b[33m"
	ColorBlue    = "\u001b[34m"
	ColorCyan    = "\u001b[36m"
	ColorDim     = "\u001b[2m"
	ColorBold   = "\u001b[1m"
)

// Status indicators per §15
const (
	StatusOK       = "✓"
	StatusFail     = "✗"
	StatusOnline   = "●"
	StatusOffline   = "○"
	StatusPending   = "⟳"
	StatusNotInstalled = "·"
)

// ============================================================================
// Brand icon - embedded from sdk/prismer-cloud/icon
// ============================================================================

var brandIcon = strings.TrimLeft(`

	          ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
	        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
	      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
	      ▒▒▒▒▒▒                 ▒▒▒▒▒▒▒
	     ▒▒▒▒▒    ▒▒▒▒▒▒▒▒▒▒▒▒      ▒▒▒▒▒         ▓▓▓▓▓▓▓▓▓▓       ▓▓▓▓▓▓▓▓▓       ▓▓▓▓▓      ▓▓▓▓▓▓      ▓▓▓▓            ▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓▓▓▓
	    ▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒    ▒▒▒▒       ▓▓▓▓▓▓▓▓▓▓▓▓▓    ▓▓▓▓▓▓▓▓▓▓▓    ▓▓▓▓    ▓▓▓▓▓▓▓▓▓▓▓▓    ▓▓▓▓           ▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓
	    ▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒    ▒▒▒▒      ▓▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓   ▓▓▓▓▓ ▓▓▓▓▓▓▓  ▓▓▓▓▓         ▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓
	   ▒▒▒▒   ▒▒▒▒        ▒▒▒▒    ▒▒▒▒      ▓▓▓▓▓    ▓▓▓▓  ▓▓▓      ▓▓▓▓   ▓▓▓▓▓   ▓▓▓▓     ▓▓    ▓▓▓▓▓▓        ▓▓▓▓▓   ▓▓▓▓           ▓▓▓▓     ▓▓▓▓
	   ▒▒▒▒  ▒▒▒▒          ▒▒▒▒   ▒▒▒▒      ▓▓▓▓▓    ▓▓▓▓   ▓▓▓     ▓▓▓▓   ▓▓▓▓   ▓▓▓▓            ▓▓▓▓▓▓      ▓▓▓▓▓▓   ▓▓▓▓           ▓▓▓▓     ▓▓▓▓
	  ▒▒▒▒   ▒▒▒▒     ▒▒▒▒▒▒▒▒    ▒▒▒▒      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓    ▓▓▓▓▓▓▓▓▓▓▓    ▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓
	  ▒▒▒▒  ▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒    ▒▒▒▒       ▓▓▓▓▓▓▓▓▓▓    ▓▓▓▓▓▓▓▓▓▓▓     ▓▓▓▓     ▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓   ▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓
	 ▒▒▒▒   ▒▒▒▒  ▒▒▒▒▒▒▒▒▒     ▒▒▒▒        ▓▓▓▓▓▓▓▓▓▓       ▓▓▓▓▓▓▓▓      ▓▓▓▓             ▓▓▓  ▓▓▓ ▓▓▓▓ ▓▓▓ ▓▓▓   ▓▓▓▓           ▓▓▓▓▓▓▓▓▓▓▓▓▓
	 ▒▒▒▒  ▒▒▒▒   ▒▒▒▒        ▒▒▒▒▒▒        ▓▓▓▓            ▓▓▓   ▓▓▓▓     ▓▓▓▓  ▓▓▓▓       ▓▓▓  ▓▓▓  ▓▓▓▓▓▓▓  ▓▓▓   ▓▓▓▓           ▓▓▓▓   ▓▓▓▓
	 ▒▒▒▒  ▒▒▒▒   ▒▒▒▒        ▒▒▒▒▒▒        ▓▓▓▓            ▓▓▓   ▓▓▓     ▓▓▓▓  ▓▓▓▓       ▓▓▓  ▓▓▓  ▓▓▓▓▓▓▓  ▓▓▓   ▓▓▓▓           ▓▓▓▓   ▓▓▓▓
	▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒          ▓▓▓▓            ▓▓▓    ▓▓▓▓    ▓▓▓▓  ▓▓▓▓     ▓▓▓▓  ▓▓▓   ▓▓▓▓▓▓  ▓▓▓   ▓▓▓           ▓▓▓▓   ▓▓▓▓█
	▒▒▒▒   ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒            ▓▓▓▓            ▓▓▓     ▓▓▓▓   ▓▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓   ▓▓▓▓▓   ▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓    ▓▓▓▓
	▒▒▒▒     ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒               ▓▓▓▓            ▓▓▓      ▓▓▓▓  ▓▓▓▓     ▓▓▓▓▓▓▓▓▓    ▓▓▓    ▓▓▓    ▓▓▓   ▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓     ▓▓▓▓
	  ▒▒▒▒▒      ▒▒▒▒▒
	  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒
	    ▒▒▒▒▒▒▒▒▒▒▒▒▒
	      ▒▒▒▒▒▒▒
`, "\n")

// ============================================================================
// Braille spinner frames per §15
// ============================================================================

var brailleFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// ============================================================================
// Forbidden brand voice patterns per §15
// ============================================================================

var forbiddenSubstrings = []string{"Sorry", "Unfortunately", "Oops"}
var forbiddenWords = []string{"Please"}

// ============================================================================
// UI modes
// ============================================================================

type OutputMode string

const (
	ModePretty OutputMode = "pretty"
	ModeJSON   OutputMode = "json"
	ModeQuiet  OutputMode = "quiet"
)

// ============================================================================
// UI struct
// ============================================================================

type UI struct {
	writer      io.Writer
	errWriter   io.Writer
	colorEnabled bool
	mode        OutputMode
	width       int
}

// NewUI creates a new UI instance with auto-detected settings
func NewUI() *UI {
	return &UI{
		writer:      os.Stdout,
		errWriter:   os.Stderr,
		colorEnabled: supportsColor() && isTerminal(os.Stdout),
		mode:        ModePretty,
		width:       getTerminalWidth(),
	}
}

// NewUIWithWriter creates a UI instance with custom writer
func NewUIWithWriter(writer io.Writer) *UI {
	return &UI{
		writer:      writer,
		errWriter:   os.Stderr,
		colorEnabled: supportsColor() && isTerminal(writer),
		mode:        ModePretty,
		width:       getTerminalWidth(),
	}
}

// SetMode changes output mode
func (ui *UI) SetMode(mode OutputMode) {
	ui.mode = mode
}

// SetColor forces color on/off
func (ui *UI) SetColor(enabled bool) {
	ui.colorEnabled = enabled
}

// ============================================================================
// Terminal detection helpers
// ============================================================================

func supportsColor() bool {
	return os.Getenv("NO_COLOR") == ""
}

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	stat, _ := f.Stat()
	return (stat.Mode() & os.ModeCharDevice) != 0
}

func getTerminalWidth() int {
	if fd := int(os.Stdout.Fd()); fd > 0 {
		if winsize, err := unix.IoctlGetWinsize(fd, unix.TIOCGWINSZ); err == nil && winsize != nil {
			return int(winsize.Col)
		}
	}
	// Fallback to 80 columns
	if cols := os.Getenv("COLUMNS"); cols != "" {
		var width int
		if _, err := fmt.Sscanf(cols, "%d", &width); err == nil && width > 0 {
			return width
		}
	}
	return 80
}

// ============================================================================
// Level 1: Header
// ============================================================================

func (ui *UI) Header(text string) {
	ui.write(fmt.Sprintf("%s%s%s\n", ui.bold(text)))
}

func (ui *UI) Banner(subtitle string, full bool) {
	if ui.mode != ModePretty {
		return
	}

	if full && ui.width >= 120 {
		// Full icon
		for _, line := range strings.Split(brandIcon, "\n") {
			stripped := strings.TrimSpace(line)
			if stripped == "" {
				ui.write("\n")
				continue
			}
			// Color the icon: cyan for blocks, dim for dots
			colored := ui.colorIconLine(stripped)
			ui.write(colored + "\n")
		}
	} else {
		// Compact banner
		ui.write(ui.cyan("◇ PRISMER\n"))
		ui.write(ui.dim("  Runtime CLI\n"))
	}

	if subtitle != "" {
		ui.write(ui.dim("  " + subtitle + "\n"))
	}
	ui.Blank()
}

func (ui *UI) colorIconLine(line string) string {
	var sb strings.Builder
	for _, r := range line {
		if r == '▒' {
			sb.WriteString(ui.cyan(string(r)))
		} else if r == '▓' {
			sb.WriteString(ui.dim(string(r)))
		} else {
			sb.WriteString(string(r))
		}
	}
	return sb.String()
}

// ============================================================================
// Level 2: Primary data
// ============================================================================

func (ui *UI) Line(text string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write(text + "\n")
}

func (ui *UI) Info(text string) {
	ui.Line(text)
}

func (ui *UI) Blank() {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write("\n")
}

// ============================================================================
// Level 3: Secondary
// ============================================================================

func (ui *UI) Secondary(text string, indent int) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	padding := strings.Repeat(" ", indent)
	ui.write(padding + ui.dim(text) + "\n")
}

// ============================================================================
// Level 4: Action tips
// ============================================================================

func (ui *UI) Tip(text string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write(ui.cyan("Tip:") + " " + text + "\n")
}

func (ui *UI) Next(text string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write(ui.cyan("Next:") + " " + text + "\n")
}

// ============================================================================
// Level 5: Status indicators
// ============================================================================

func (ui *UI) OK(text string, detail string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	suffix := ""
	if detail != "" {
		suffix = "  " + ui.dim(detail)
	}
	ui.write(fmt.Sprintf("  %s %s%s\n", ui.green(StatusOK), text, suffix))
}

func (ui *UI) Success(text string, detail string) {
	ui.OK(text, detail)
}

func (ui *UI) Fail(text string, detail string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	suffix := ""
	if detail != "" {
		suffix = "  " + ui.dim(detail)
	}
	ui.write(fmt.Sprintf("  %s %s%s\n", ui.red(StatusFail), text, suffix))
}

func (ui *UI) Online(text string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write(fmt.Sprintf("  %s %s\n", ui.green(StatusOnline), text))
}

func (ui *UI) Offline(text string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write(fmt.Sprintf("  %s %s\n", ui.dim(StatusOffline), text))
}

func (ui *UI) NotInstalled(text string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write(fmt.Sprintf("  %s %s\n", ui.dim(StatusNotInstalled), ui.dim(text)))
}

func (ui *UI) Pending(text string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	ui.write(fmt.Sprintf("  %s %s\n", ui.yellow(StatusPending), text))
}

func (ui *UI) Warn(text string, detail string) {
	if ui.mode == ModeQuiet || ui.mode == ModeJSON {
		return
	}
	suffix := ""
	if detail != "" {
		suffix = "  " + ui.dim(detail)
	}
	ui.write(fmt.Sprintf("  %s %s%s\n", ui.yellow("!"), text, suffix))
}

// ============================================================================
// Level 6: Error block
// ============================================================================

func (ui *UI) Error(what string, cause string, fix string) {
	if ui.mode == ModeJSON {
		ui.writeJSONError(what, cause, fix)
		return
	}
	ui.writeErr(fmt.Sprintf("%s %s\n", ui.red(StatusFail), what))
	if cause != "" {
		ui.writeErr(fmt.Sprintf("  %s %s\n", ui.dim("Cause:"), ui.dim(cause)))
	}
	if fix != "" {
		ui.writeErr(fmt.Sprintf("  %s %s%s\n", ui.cyan("Fix:"), fix, ColorReset))
	}
}

func (ui *UI) writeJSONError(what string, cause string, fix string) {
	err := map[string]interface{}{
		"error": what,
	}
	if cause != "" {
		err["cause"] = cause
	}
	if fix != "" {
		err["fix"] = fix
	}
	b, _ := json.MarshalIndent(err, "", "  ")
	ui.writeErr(string(b) + "\n")
}

// ============================================================================
// Tables
// ============================================================================

type TableColumn struct {
	Header string
	Width  int
}

type TableRow struct {
	Cells []string
}

func (ui *UI) Table(headers []TableColumn, rows []TableRow) {
	ui.Blank()

	// Check terminal width
	totalWidth := 0
	for _, h := range headers {
		totalWidth += h.Width + 2 // +2 for padding
	}

	if totalWidth > ui.width {
		// Fallback to list mode
		for _, h := range headers {
			ui.Secondary(h.Header+":", 2)
		}
		for _, row := range rows {
			for i, cell := range row.Cells {
				if i < len(headers) {
					ui.Secondary(fmt.Sprintf("%s:", headers[i].Header), 4)
					ui.Secondary(cell, 6)
				}
			}
			ui.Blank()
		}
		return
	}

	// Calculate column widths
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = h.Width
	}
	for _, row := range rows {
		for i, cell := range row.Cells {
			if i < len(widths) && len(cell) > widths[i] {
				widths[i] = len(cell)
			}
		}
	}

	// Print header row
	for _, h := range headers {
		ui.write(fmt.Sprintf("  %s  ", ui.bold(strings.ToUpper(h.Header))))
	}
	ui.write("\n")

	// Print data rows
	for _, row := range rows {
		for i, cell := range row.Cells {
			if i < len(widths) {
				padded := strings.Repeat(" ", widths[i]-len(cell))
				ui.write(fmt.Sprintf("  %s%s  ", cell, padded))
			}
		}
		ui.write("\n")
	}
}

// TableFromMap is a convenience method for string->string maps
func (ui *UI) TableFromMap(data []map[string]string, columns []string) {
	if len(data) == 0 {
		return
	}

	// Build headers
	headers := make([]TableColumn, len(columns))
	for i, col := range columns {
		headers[i] = TableColumn{Header: col, Width: len(col)}
	}

	// Build rows
	rows := make([]TableRow, len(data))
	for i, row := range data {
		cells := make([]string, len(columns))
		for j, col := range columns {
			val := row[col]
			if val == "" {
				val = "-"
			}
			cells[j] = val
			if len(val) > headers[j].Width {
				headers[j].Width = len(val)
			}
		}
		rows[i] = TableRow{Cells: cells}
	}

	ui.Table(headers, rows)
}

// ============================================================================
// Spinner
// ============================================================================

type Spinner struct {
	ui      *UI
	message string
	running bool
	ticker  *time.Ticker
	done    chan bool
}

func (ui *UI) Spinner(message string) *Spinner {
	return &Spinner{
		ui:      ui,
		message: message,
		running: false,
		done:    make(chan bool),
	}
}

func (s *Spinner) Start() {
	if s.running {
		return
	}

	// Non-TTY or non-color: just show pending status
	if !s.ui.colorEnabled || !isTerminal(s.ui.writer) {
		s.ui.Pending(s.message)
		s.running = true
		return
	}

	s.running = true
	frame := 0

	// Write first frame
	s.writeFrame(frame)

	// Start ticker
	s.ticker = time.NewTicker(80 * time.Millisecond)

	go func() {
		for {
			select {
			case <-s.done:
				s.ticker.Stop()
				return
			case <-s.ticker.C:
				frame++
				s.writeFrame(frame)
			}
		}
	}()
}

func (s *Spinner) writeFrame(frameIdx int) {
	if !s.running {
		return
	}
	frame := brailleFrames[frameIdx%len(brailleFrames)]
	// Use carriage return to rewrite line
	fmt.Fprintf(s.ui.writer, "\r%s %s", s.ui.yellow(frame), s.message)
}

func (s *Spinner) Update(message string) {
	if !s.running {
		return
	}
	s.message = message
}

func (s *Spinner) Stop(successMessage string) {
	if !s.running {
		return
	}

	s.running = false
	close(s.done)

	if s.ticker != nil {
		s.ticker.Stop()
	}

	// Clear the spinner line
	if isTerminal(s.ui.writer) && s.ui.colorEnabled {
		fmt.Fprintf(s.ui.writer, "\r\u001b[2K")
	}

	if successMessage != "" {
		s.ui.OK(successMessage, "")
	}
}

// ============================================================================
// JSON output
// ============================================================================

func (ui *UI) JSON(payload interface{}) {
	b, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		ui.writeErr(fmt.Sprintf("Error marshaling JSON: %v\n", err))
		return
	}
	ui.write(string(b) + "\n")
}

// ============================================================================
// Result convenience
// ============================================================================

func (ui *UI) Result(prettyFunc func(), jsonPayload interface{}) {
	if ui.mode == ModePretty {
		prettyFunc()
	} else {
		ui.JSON(jsonPayload)
	}
}

// ============================================================================
// Brand voice checker
// ============================================================================

func CheckBrandVoice(text string, field string) error {
	// Check for forbidden substrings
	for _, fs := range forbiddenSubstrings {
		if strings.Contains(text, fs) {
			return fmt.Errorf("Brand voice error in %s: found forbidden substring %q", field, fs)
		}
	}

	// Check for forbidden words (whole word match)
	for _, fw := range forbiddenWords {
		// Match whole words with word boundaries
		re := fmt.Sprintf("\\b%s\\b", fw)
		if strings.Contains(text, re) {
			return fmt.Errorf("Brand voice error in %s: found forbidden word %q", field, fw)
		}
	}

	// Check for trailing exclamation marks (not inside quotes)
	lines := strings.Split(text, "\n")
	for _, line := range lines {
		// Remove quoted sections
		stripped := strings.TrimSpace(line)

		// Check if inside quotes
		inDoubleQuote := false
		inSingleQuote := false
		for _, r := range stripped {
			if r == '"' {
				inDoubleQuote = !inDoubleQuote
			} else if r == '\'' {
				inSingleQuote = !inSingleQuote
			}
		}

		if inDoubleQuote || inSingleQuote {
			// Skip quoted text
			continue
		}

		// Check for trailing exclamation
		if strings.HasSuffix(stripped, "!") {
			// Allow "!!" (emphasis) but block single "!"
			if !strings.HasSuffix(stripped, "!!") {
				return fmt.Errorf("Brand voice error in %s: trailing exclamation mark in %q", field, line)
			}
		}
	}

	return nil
}

// ============================================================================
// Internal helpers
// ============================================================================

func (ui *UI) write(text string) {
	ui.writer.Write([]byte(text))
}

func (ui *UI) writeErr(text string) {
	ui.errWriter.Write([]byte(text))
}

func (ui *UI) color(code string, text string) string {
	if !ui.colorEnabled {
		return text
	}
	return code + text + ColorReset
}

func (ui *UI) red(text string) string {
	return ui.color(ColorRed, text)
}

func (ui *UI) green(text string) string {
	return ui.color(ColorGreen, text)
}

func (ui *UI) yellow(text string) string {
	return ui.color(ColorYellow, text)
}

func (ui *UI) cyan(text string) string {
	return ui.color(ColorCyan, text)
}

func (ui *UI) dim(text string) string {
	return ui.color(ColorDim, text)
}

func (ui *UI) bold(text string) string {
	return ui.color(ColorBold, text)
}

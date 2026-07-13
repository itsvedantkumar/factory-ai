package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type activity struct {
	Type       string `json:"type"`
	Tool       string `json:"tool"`
	Phase      string `json:"phase"`
	OccurredAt string `json:"occurredAt"`
	RetryCount int    `json:"retryCount"`
	LastError  string `json:"lastError"`
}

type task struct {
	ID        string    `json:"id"`
	Role      string    `json:"role"`
	Title     string    `json:"title"`
	Model     string    `json:"model"`
	State     string    `json:"state"`
	Stale     bool      `json:"stale"`
	Activity  *activity `json:"activity"`
	Retries   int       `json:"retries"`
	LastError string    `json:"lastError"`
}

type objective struct {
	ID          string `json:"id"`
	Objective   string `json:"objective"`
	Repository  string `json:"repository"`
	Status      string `json:"status"`
	Tasks       []task `json:"tasks"`
	PullRequest string `json:"pullRequest"`
	Blocker     string `json:"blocker"`
	Approval    *struct {
		ApprovalID string `json:"approvalId"`
		Status     string `json:"status"`
		Policy     string `json:"policy"`
		Reason     string `json:"reason"`
	} `json:"approval"`
}

type workspace struct {
	Name       string `json:"name"`
	Repository string `json:"repository"`
	LocalPath  string `json:"localPath"`
	BaseBranch string `json:"baseBranch"`
}

type usage struct {
	Tasks             int `json:"tasks"`
	InputTokens       int `json:"inputTokens"`
	CachedInputTokens int `json:"cachedInputTokens"`
	OutputTokens      int `json:"outputTokens"`
}

type dashboard struct {
	GeneratedAt string                           `json:"generatedAt"`
	Queue       struct{ Active, DeadLetter int } `json:"queue"`
	Health      struct {
		Status      string `json:"status"`
		StaleAgents int    `json:"staleAgents"`
	} `json:"health"`
	Cost *struct {
		MonthToDate float64            `json:"monthToDate"`
		Currency    string             `json:"currency"`
		ByService   map[string]float64 `json:"byService"`
	} `json:"cost"`
	Summary struct {
		Objectives map[string]int `json:"objectives"`
	} `json:"summary"`
	Objectives []objective      `json:"objectives"`
	ModelUsage map[string]usage `json:"modelUsage"`
	Secrets    []struct {
		Name    string `json:"name"`
		Updated string `json:"updated"`
	} `json:"secrets"`
	Warnings []string `json:"warnings"`
}

type snapshotMsg struct {
	dashboard    dashboard
	logs         string
	workspaces   []workspace
	workspaceErr string
	err          error
}
type tickMsg time.Time
type commandResultMsg struct {
	command, output string
	err             error
}

type model struct {
	client            *azblob.Client
	factoryName       string
	purpose           string
	width             int
	height            int
	tab               int
	scroll            int
	dashboard         dashboard
	logs              string
	workspaces        []workspace
	workspaceErr      string
	selectedWorkspace string
	loading           bool
	err               error
	commandMode       bool
	commandInput      string
	commandOutput     string
	commandHistory    []string
	historyIndex      int
	consoleScroll     int
}

var (
	accent = lipgloss.Color("#78DBA9")
	blue   = lipgloss.Color("#77A8FF")
	warn   = lipgloss.Color("#EFC46B")
	danger = lipgloss.Color("#EF7D7D")
	muted  = lipgloss.Color("#7F8B99")
	panel  = lipgloss.Color("#15191F")
	border = lipgloss.Color("#303743")
	tabs   = []string{"Dashboard", "Objectives", "Agents", "Settings"}
	ansi   = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)`)
)

type synchronizedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (value *synchronizedBuffer) Write(data []byte) (int, error) {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.buffer.Write(data)
}
func (value *synchronizedBuffer) String() string {
	value.mu.Lock()
	defer value.mu.Unlock()
	return value.buffer.String()
}

func clean(value string) string {
	value = ansi.ReplaceAllString(value, "")
	return strings.Map(func(character rune) rune {
		if character == '\n' || character == '\t' || character >= 0x20 && character != 0x7f {
			return character
		}
		return -1
	}, value)
}

func parseCommandLine(value string) ([]string, error) {
	var args []string
	var current strings.Builder
	var quote rune
	escaped := false
	flush := func() {
		if current.Len() > 0 {
			args = append(args, current.String())
			current.Reset()
		}
	}
	for _, character := range strings.TrimSpace(value) {
		if escaped {
			current.WriteRune(character)
			escaped = false
			continue
		}
		if character == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if character == quote {
				quote = 0
			} else {
				current.WriteRune(character)
			}
			continue
		}
		if character == '\'' || character == '"' {
			quote = character
			continue
		}
		if character == ' ' || character == '\t' {
			flush()
			continue
		}
		current.WriteRune(character)
	}
	if escaped || quote != 0 {
		return nil, fmt.Errorf("unterminated quote or escape")
	}
	flush()
	if len(args) > 0 && args[0] == "factory" {
		args = args[1:]
	}
	return args, nil
}

func validateFactoryCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("enter a factory command")
	}
	allowed := map[string]bool{"setup": true, "configure": true, "models": true, "acp": true, "extension": true, "github": true, "telegram": true, "workspace": true, "submit": true, "issue": true, "init": true, "secret": true, "dashboard": true, "status": true, "queue": true, "report": true, "logs": true, "doctor": true, "pause": true, "resume": true, "update": true, "approval": true, "help": true, "--help": true, "-h": true}
	if args[0] == "ui" {
		return fmt.Errorf("the UI command cannot be launched inside itself")
	}
	if !allowed[args[0]] {
		return fmt.Errorf("unknown factory command: %s", args[0])
	}
	return nil
}

func interactiveFactoryCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	return args[0] == "setup" || args[0] == "configure" || args[0] == "secret" && len(args) > 1 && args[1] == "set" || args[0] == "telegram" && len(args) > 1 && args[1] == "configure"
}

func executeFactoryCommand(args []string) tea.Cmd {
	return func() tea.Msg {
		command := "factory " + strings.Join(args, " ")
		output, err := exec.Command("factory", args...).CombinedOutput()
		return commandResultMsg{command: command, output: string(output), err: err}
	}
}

func interactiveFactoryProcess(args []string) tea.Cmd {
	var transcript synchronizedBuffer
	command := exec.Command("factory", args...)
	command.Stdin = os.Stdin
	command.Stdout = io.MultiWriter(os.Stdout, &transcript)
	command.Stderr = io.MultiWriter(os.Stderr, &transcript)
	label := "factory " + strings.Join(args, " ")
	return tea.ExecProcess(command, func(err error) tea.Msg {
		return commandResultMsg{command: label, output: transcript.String(), err: err}
	})
}

func readConfig() map[string]string {
	result := map[string]string{}
	for _, key := range []string{"FACTORY_STORAGE_ACCOUNT", "FACTORY_NAME", "FACTORY_PURPOSE"} {
		if value := os.Getenv(key); value != "" {
			result[key] = value
		}
	}
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".config", "factory-ai", "config"))
	if err != nil {
		return result
	}
	for _, line := range strings.Split(string(data), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || result[key] != "" {
			continue
		}
		value = strings.ReplaceAll(value, `\ `, " ")
		if unquoted, err := strconv.Unquote(value); err == nil {
			value = unquoted
		}
		result[key] = value
	}
	return result
}

func download(client *azblob.Client, name string) ([]byte, error) {
	response, err := client.DownloadStream(context.Background(), "operator", name, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	return io.ReadAll(response.Body)
}

func fetchCmd(client *azblob.Client) tea.Cmd {
	return func() tea.Msg {
		data, err := download(client, "dashboard.json")
		if err != nil {
			return snapshotMsg{err: err}
		}
		var board dashboard
		if err := json.Unmarshal(data, &board); err != nil {
			return snapshotMsg{err: err}
		}
		logData, _ := download(client, "logs.txt")
		var workspaces []workspace
		workspaceErr := ""
		if output, commandError := exec.Command("factory", "workspace", "list").Output(); commandError == nil {
			if decodeError := json.Unmarshal(output, &workspaces); decodeError != nil {
				workspaceErr = decodeError.Error()
			}
		} else {
			workspaceErr = commandError.Error()
		}
		return snapshotMsg{dashboard: board, logs: string(logData), workspaces: workspaces, workspaceErr: workspaceErr}
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(15*time.Second, func(value time.Time) tea.Msg { return tickMsg(value) })
}
func (m model) Init() tea.Cmd { return tea.Batch(fetchCmd(m.client), tickCmd()) }

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.KeyMsg:
		if m.commandMode {
			switch msg.String() {
			case "esc":
				m.commandMode = false
				m.commandInput = ""
			case "enter":
				line := strings.TrimSpace(m.commandInput)
				args, err := parseCommandLine(line)
				if err == nil {
					err = validateFactoryCommand(args)
				}
				if err != nil {
					m.commandOutput = err.Error()
					return m, nil
				}
				m.commandMode = false
				m.commandInput = ""
				m.commandHistory = append(m.commandHistory, line)
				m.historyIndex = len(m.commandHistory)
				if interactiveFactoryCommand(args) {
					return m, interactiveFactoryProcess(args)
				}
				m.loading = true
				return m, executeFactoryCommand(args)
			case "backspace", "ctrl+h":
				runes := []rune(m.commandInput)
				if len(runes) > 0 {
					m.commandInput = string(runes[:len(runes)-1])
				}
			case "ctrl+u":
				m.commandInput = ""
			case "up":
				if m.historyIndex > 0 {
					m.historyIndex--
					m.commandInput = m.commandHistory[m.historyIndex]
				}
			case "down":
				if m.historyIndex < len(m.commandHistory)-1 {
					m.historyIndex++
					m.commandInput = m.commandHistory[m.historyIndex]
				} else {
					m.historyIndex = len(m.commandHistory)
					m.commandInput = ""
				}
			default:
				if len(msg.Runes) > 0 {
					m.commandInput += string(msg.Runes)
				}
			}
			return m, nil
		}
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "left", "h":
			if m.tab > 0 {
				m.tab--
				m.scroll = 0
			}
		case "right", "l", "tab":
			if m.tab < len(tabs)-1 {
				m.tab++
			} else {
				m.tab = 0
			}
			m.scroll = 0
		case "up", "k":
			if m.scroll > 0 {
				m.scroll--
			}
		case "down", "j":
			m.scroll++
		case "pgup":
			m.scroll -= 10
			if m.scroll < 0 {
				m.scroll = 0
			}
		case "pgdown":
			m.scroll += 10
		case "home":
			m.scroll = 0
		case "[", "shift+up":
			if index := m.selectedIndex(); index > 0 {
				m.selectedWorkspace = m.workspaces[index-1].Name
				m.scroll = 0
			}
		case "]", "shift+down":
			if index := m.selectedIndex(); index >= 0 && index < len(m.workspaces)-1 {
				m.selectedWorkspace = m.workspaces[index+1].Name
				m.scroll = 0
			}
		case "ctrl+up":
			if m.consoleScroll > 0 {
				m.consoleScroll--
			}
		case "ctrl+down":
			m.consoleScroll++
		case ":", "/", "enter", "o":
			m.commandMode = true
			m.commandInput = ""
			m.historyIndex = len(m.commandHistory)
		case "n":
			m.commandMode = true
			m.commandInput = "submit "
			if selected := m.selected(); selected != nil {
				m.commandInput += selected.Name + " "
			}
			m.historyIndex = len(m.commandHistory)
		case "i":
			m.commandMode = true
			m.commandInput = "workspace import "
			m.historyIndex = len(m.commandHistory)
		case "a":
			m.commandMode = true
			m.commandInput = "secret set "
			m.historyIndex = len(m.commandHistory)
		case "y":
			m.commandMode = true
			m.commandInput = "approval approve "
			m.historyIndex = len(m.commandHistory)
		case "x":
			m.commandMode = true
			m.commandInput = "approval deny "
			m.historyIndex = len(m.commandHistory)
		case "p":
			m.loading = true
			return m, executeFactoryCommand([]string{"pause"})
		case "u":
			m.loading = true
			return m, executeFactoryCommand([]string{"resume"})
		case "?":
			m.loading = true
			return m, executeFactoryCommand([]string{"--help"})
		case "ctrl+l", "esc":
			m.commandOutput = ""
			m.consoleScroll = 0
			m.err = nil
		case "r":
			m.loading = true
			return m, fetchCmd(m.client)
		default:
			if len(msg.String()) == 1 && msg.String()[0] >= '1' && msg.String()[0] <= '4' {
				m.tab = int(msg.String()[0] - '1')
				m.scroll = 0
			}
		}
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case snapshotMsg:
		m.loading = false
		m.err = msg.err
		if msg.err == nil {
			m.dashboard, m.logs, m.workspaces, m.workspaceErr = msg.dashboard, msg.logs, msg.workspaces, msg.workspaceErr
			if len(m.workspaces) == 0 {
				m.selectedWorkspace = ""
			} else if m.selected() == nil {
				m.selectedWorkspace = m.workspaces[0].Name
			}
		}
	case commandResultMsg:
		m.loading = false
		m.err = nil
		result := strings.TrimSpace(clean(msg.output))
		if msg.err != nil && result == "" {
			result = msg.err.Error()
		}
		m.commandOutput = fmt.Sprintf("$ %s\n%s", clean(msg.command), result)
		m.consoleScroll = len(strings.Split(m.commandOutput, "\n")) - 4
		if m.consoleScroll < 0 {
			m.consoleScroll = 0
		}
		return m, fetchCmd(m.client)
	case tickMsg:
		if !m.loading {
			m.loading = true
			return m, tea.Batch(fetchCmd(m.client), tickCmd())
		}
		return m, tickCmd()
	}
	return m, nil
}

func statusColor(value string) lipgloss.Color {
	switch value {
	case "complete", "succeeded":
		return accent
	case "failed", "blocked", "stale":
		return danger
	case "running":
		return blue
	default:
		return warn
	}
}
func badge(value string) string {
	return lipgloss.NewStyle().Foreground(statusColor(value)).Bold(true).Render(value)
}
func trim(value string, max int) string {
	value = strings.ReplaceAll(clean(value), "\n", " ")
	if len(value) > max {
		return value[:max-1] + "…"
	}
	return value
}

func normalizeRepository(value string) string {
	return strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(value), "https://github.com/"), ".git")
}

func (m model) selected() *workspace {
	for index := range m.workspaces {
		if m.workspaces[index].Name == m.selectedWorkspace {
			return &m.workspaces[index]
		}
	}
	return nil
}

func (m model) selectedIndex() int {
	for index, item := range m.workspaces {
		if item.Name == m.selectedWorkspace {
			return index
		}
	}
	return -1
}

func (m model) visibleObjectives() []objective {
	selected := m.selected()
	if selected == nil {
		return nil
	}
	repository := normalizeRepository(selected.Repository)
	result := []objective{}
	for _, item := range m.dashboard.Objectives {
		if normalizeRepository(item.Repository) == repository {
			result = append(result, item)
		}
	}
	return result
}

func (m model) overview() string {
	cost := "unavailable"
	if m.dashboard.Cost != nil {
		cost = fmt.Sprintf("%s %.2f", m.dashboard.Cost.Currency, m.dashboard.Cost.MonthToDate)
	}
	objectives := m.visibleObjectives()
	countMap := map[string]int{}
	for _, item := range objectives {
		countMap[item.Status]++
	}
	counts := []string{}
	for key, value := range countMap {
		counts = append(counts, fmt.Sprintf("%s %d", key, value))
	}
	sort.Strings(counts)
	in, cached, out := 0, 0, 0
	for _, value := range m.dashboard.ModelUsage {
		in += value.InputTokens
		cached += value.CachedInputTokens
		out += value.OutputTokens
	}
	value := fmt.Sprintf("%s\n\nHealth       %s\nQueue        %s\nDead letters %d\nAzure MTD    %s\nObjectives   %s\nTokens       %d in · %d cached · %d out\n\n%s\n\n", lipgloss.NewStyle().Bold(true).Render("SYSTEM"), badge(m.dashboard.Health.Status), lipgloss.NewStyle().Foreground(accent).Render(fmt.Sprint(m.dashboard.Queue.Active)), m.dashboard.Queue.DeadLetter, lipgloss.NewStyle().Foreground(warn).Render(cost), strings.Join(counts, "  "), in, cached, out, lipgloss.NewStyle().Bold(true).Render("RECENT OBJECTIVES"))
	for index := len(objectives) - 1; index >= 0 && index >= len(objectives)-8; index-- {
		item := objectives[index]
		value += fmt.Sprintf("%s  %s\n    %s\n\n", badge(item.Status), trim(item.Objective, 90), lipgloss.NewStyle().Foreground(muted).Render(clean(item.Repository)))
	}
	return value
}

func (m model) objectives() string {
	var value strings.Builder
	objectives := m.visibleObjectives()
	for index := len(objectives) - 1; index >= 0; index-- {
		item := objectives[index]
		fmt.Fprintf(&value, "%s  %s\n%s\n", badge(item.Status), trim(item.Objective, 100), lipgloss.NewStyle().Foreground(muted).Render(clean(item.ID)))
		for _, task := range item.Tasks {
			state := task.State
			if task.Stale {
				state = "stale"
			}
			detail := ""
			if task.Activity != nil {
				detail = " · " + task.Activity.Type
				if task.Activity.Tool != "" {
					detail += " " + task.Activity.Tool
				}
			}
			fmt.Fprintf(&value, "  %s %-9s %s%s\n", badge(state), clean(task.Role), trim(task.Title, 70), clean(detail))
		}
		if item.PullRequest != "" {
			fmt.Fprintf(&value, "  PR %s\n", clean(item.PullRequest))
		}
		if item.Approval != nil {
			fmt.Fprintf(&value, "  %s approval %s · %s\n  ID %s\n", badge(item.Approval.Status), clean(item.Approval.Policy), trim(item.Approval.Reason, 90), clean(item.Approval.ApprovalID))
		}
		value.WriteString("\n")
	}
	return value.String()
}

func (m model) agents() string {
	var value strings.Builder
	for _, item := range m.visibleObjectives() {
		for _, task := range item.Tasks {
			if task.State == "succeeded" {
				continue
			}
			state := task.State
			if task.Stale {
				state = "stale"
			}
			phase := "waiting for activity"
			if task.Activity != nil {
				phase = task.Activity.Phase
				if phase == "" {
					phase = task.Activity.Type
				}
				phase += " · " + task.Activity.OccurredAt
				if task.Retries > 0 {
					phase += fmt.Sprintf(" · %d retries", task.Retries)
				}
			}
			fmt.Fprintf(&value, "%s  %s  %s\n  %s\n  %s\n\n", badge(state), clean(task.Role), clean(task.Model), trim(task.Title, 90), lipgloss.NewStyle().Foreground(muted).Render(clean(phase)))
			if task.LastError != "" {
				fmt.Fprintf(&value, "  %s\n\n", lipgloss.NewStyle().Foreground(danger).Render(clean(task.LastError)))
			}
		}
	}
	if value.Len() == 0 {
		return "No active agents."
	}
	return value.String()
}

func (m model) sidebar(maxLines int) string {
	var value strings.Builder
	value.WriteString(lipgloss.NewStyle().Bold(true).Render("WORKSPACES") + "\n\n")
	if m.workspaceErr != "" {
		value.WriteString(lipgloss.NewStyle().Foreground(danger).Render("Catalog unavailable") + "\n")
	}
	if len(m.workspaces) == 0 {
		value.WriteString("No workspaces\n\nPress i to import")
	}
	available := maxLines - 7
	if available < 1 {
		available = 1
	}
	start := 0
	if index := m.selectedIndex(); index >= available {
		start = index - available + 1
	}
	end := start + available
	if end > len(m.workspaces) {
		end = len(m.workspaces)
	}
	if start > 0 {
		value.WriteString(lipgloss.NewStyle().Foreground(muted).Render("  ↑ more") + "\n")
	}
	for _, item := range m.workspaces[start:end] {
		marker := "  "
		style := lipgloss.NewStyle().Foreground(muted)
		if item.Name == m.selectedWorkspace {
			marker = "› "
			style = style.Foreground(accent).Bold(true)
		}
		value.WriteString(style.Render(marker+trim(item.Name, 20)) + "\n")
	}
	if end < len(m.workspaces) {
		value.WriteString(lipgloss.NewStyle().Foreground(muted).Render("  ↓ more") + "\n")
	}
	value.WriteString("\n" + lipgloss.NewStyle().Foreground(muted).Render("[ / ] select\ni import\nn new objective"))
	return value.String()
}

func (m model) settings() string {
	var value strings.Builder
	value.WriteString("RUNTIME\n")
	fmt.Fprintf(&value, "  Name       %s\n  Purpose    %s\n  Storage    Azure Blob\n  Refresh    15 seconds\n\n", clean(m.factoryName), clean(m.purpose))
	value.WriteString("MODELS\n  :models show\n  :models set ROLE PROVIDER/MODEL\n\nSECRETS (values hidden)\n")
	for _, item := range m.dashboard.Secrets {
		fmt.Fprintf(&value, "  ● %-36s %s\n", clean(item.Name), clean(item.Updated))
	}
	if len(m.dashboard.Secrets) == 0 {
		value.WriteString("  No secret metadata available\n")
	}
	value.WriteString("\nCAPABILITIES\n  Skills, MCP servers, scanners, ACP, and signed extensions\n  :extension verify MANIFEST ARTIFACT PUBLIC_KEY\n")
	value.WriteString("\nRECENT SERVICE LOGS\n")
	lines := strings.Split(clean(m.logs), "\n")
	if len(lines) > 30 {
		lines = lines[len(lines)-30:]
	}
	value.WriteString(strings.Join(lines, "\n"))
	return value.String()
}

func (m model) body() string {
	if m.tab < 3 && m.selected() == nil {
		return "SELECT A WORKSPACE\n\nImport one with i, then select it from the left sidebar.\nObjectives and agents are scoped to the selected workspace."
	}
	switch m.tab {
	case 0:
		return m.overview()
	case 1:
		return m.objectives()
	case 2:
		return m.agents()
	default:
		return m.settings()
	}
}

func (m model) View() string {
	width := m.width
	if width < 80 {
		width = 80
	}
	header := lipgloss.NewStyle().Bold(true).Foreground(accent).Render(strings.ToUpper(clean(m.factoryName))) + "  " + lipgloss.NewStyle().Foreground(muted).Render(clean(m.purpose))
	if selected := m.selected(); selected != nil {
		header += "  " + lipgloss.NewStyle().Foreground(blue).Render("/ "+clean(selected.Name))
	}
	tabValues := []string{}
	for index, value := range tabs {
		style := lipgloss.NewStyle().Padding(0, 1).Foreground(muted)
		if index == m.tab {
			style = style.Foreground(lipgloss.Color("#07130D")).Background(accent).Bold(true)
		}
		tabValues = append(tabValues, style.Render(fmt.Sprintf("%d %s", index+1, value)))
	}
	tabLine := lipgloss.JoinHorizontal(lipgloss.Top, tabValues...)
	consoleHeight := 0
	if m.commandOutput != "" {
		consoleHeight = 7
	}
	mainHeight := m.height - 8 - consoleHeight
	if mainHeight < 10 {
		mainHeight = 10
	}
	sidebarWidth := 26
	contentWidth := width - sidebarWidth - 5
	if contentWidth < 50 {
		contentWidth = 50
	}
	lines := strings.Split(m.body(), "\n")
	visible := mainHeight - 2
	maxScroll := len(lines) - visible
	if maxScroll < 0 {
		maxScroll = 0
	}
	scroll := m.scroll
	if scroll > maxScroll {
		scroll = maxScroll
	}
	end := scroll + visible
	if end > len(lines) {
		end = len(lines)
	}
	sidebar := lipgloss.NewStyle().Width(sidebarWidth).Height(mainHeight).Border(lipgloss.RoundedBorder()).BorderForeground(border).Padding(1).Render(m.sidebar(mainHeight - 2))
	content := lipgloss.NewStyle().Width(contentWidth).Height(mainHeight).Border(lipgloss.RoundedBorder()).BorderForeground(border).Padding(1, 2).Render(strings.Join(lines[scroll:end], "\n"))
	main := lipgloss.JoinHorizontal(lipgloss.Top, sidebar, content)
	console := ""
	if m.commandOutput != "" {
		consoleLines := strings.Split(clean(m.commandOutput), "\n")
		maxConsoleScroll := len(consoleLines) - 4
		if maxConsoleScroll < 0 {
			maxConsoleScroll = 0
		}
		consoleScroll := m.consoleScroll
		if consoleScroll > maxConsoleScroll {
			consoleScroll = maxConsoleScroll
		}
		consoleEnd := consoleScroll + 4
		if consoleEnd > len(consoleLines) {
			consoleEnd = len(consoleLines)
		}
		console = lipgloss.NewStyle().Width(width-2).Height(5).Border(lipgloss.RoundedBorder()).BorderForeground(muted).Padding(0, 1).Render(fmt.Sprintf("CONSOLE · ctrl+↑/↓ scroll · ctrl+l clear  [%d-%d/%d]\n%s", consoleScroll+1, consoleEnd, len(consoleLines), strings.Join(consoleLines[consoleScroll:consoleEnd], "\n")))
	}
	prompt := "Press : to enter a Factory command  ·  n submit  ·  i import  ·  ? help  ·  q quit"
	if m.commandMode {
		prompt = lipgloss.NewStyle().Foreground(accent).Bold(true).Render("› ") + clean(m.commandInput) + "█"
	} else if m.loading {
		prompt = "Refreshing Factory state…"
	}
	if m.err != nil && !m.commandMode {
		prompt = lipgloss.NewStyle().Foreground(danger).Render(m.err.Error())
	}
	commandLine := lipgloss.NewStyle().Width(width-2).Height(1).Border(lipgloss.RoundedBorder()).BorderForeground(accent).Padding(0, 1).Render(prompt)
	parts := []string{header, tabLine, main}
	if console != "" {
		parts = append(parts, console)
	}
	parts = append(parts, commandLine)
	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

func main() {
	config := readConfig()
	account := config["FACTORY_STORAGE_ACCOUNT"]
	if account == "" {
		fmt.Fprintln(os.Stderr, "FACTORY_STORAGE_ACCOUNT is missing; run factory setup")
		os.Exit(1)
	}
	credential, err := azidentity.NewAzureCLICredential(nil)
	if err != nil {
		panic(err)
	}
	client, err := azblob.NewClient(fmt.Sprintf("https://%s.blob.core.windows.net/", account), credential, nil)
	if err != nil {
		panic(err)
	}
	application := model{client: client, factoryName: config["FACTORY_NAME"], purpose: config["FACTORY_PURPOSE"], loading: true}
	if application.factoryName == "" {
		application.factoryName = "Factory AI"
	}
	if application.purpose == "" {
		application.purpose = "Ship secure reviewed software continuously"
	}
	if _, err := tea.NewProgram(application, tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

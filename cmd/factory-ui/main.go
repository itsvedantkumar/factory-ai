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
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
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
	commandOutput     string
	commandHistory    []string
	historyIndex      int
	editor            textarea.Model
	content           viewport.Model
	showPalette       bool
	paletteIndex      int
	completionIndex   int
	workspaceFocus    bool
	agentFocus        bool
	selectedAgent     int
}

type agentRecord struct {
	objective objective
	task      task
}

type paletteAction struct {
	title       string
	description string
	prefix      string
}

var paletteActions = []paletteAction{
	{title: "New objective", description: "Submit work to the selected workspace", prefix: "submit {workspace} "},
	{title: "Import workspace", description: "Add a local path or owner/repository", prefix: "workspace import "},
	{title: "Set secret", description: "Store a secret in Azure Key Vault", prefix: "secret set "},
	{title: "Approve release", description: "Approve a pending release gate", prefix: "approval approve "},
	{title: "Deny release", description: "Reject a pending release gate", prefix: "approval deny "},
	{title: "Show models", description: "Inspect active role and model routes", prefix: "models show"},
	{title: "Pause factory", description: "Stop dispatching new work", prefix: "pause"},
	{title: "Resume factory", description: "Resume work dispatch", prefix: "resume"},
}

type completion struct {
	value       string
	description string
}

var commandCompletions = []completion{
	{value: "help", description: "Show the command reference"},
	{value: "setup", description: "Deploy or repair Factory AI"},
	{value: "configure models", description: "Configure model providers"},
	{value: "workspace list", description: "List imported workspaces"},
	{value: "workspace import ", description: "Import a path or owner/repository"},
	{value: "workspace show ", description: "Show workspace details"},
	{value: "workspace remove ", description: "Remove a workspace"},
	{value: "models show", description: "Show model routes"},
	{value: "models set ", description: "Set a role model"},
	{value: "models reset ", description: "Reset a role model"},
	{value: "secret list", description: "List secret metadata"},
	{value: "secret set ", description: "Set a secret"},
	{value: "secret copy ", description: "Copy a secret"},
	{value: "secret delete ", description: "Delete a secret"},
	{value: "approval approve ", description: "Approve a release gate"},
	{value: "approval deny ", description: "Deny a release gate"},
	{value: "github status", description: "Show GitHub connection"},
	{value: "github connect ", description: "Connect a GitHub organization"},
	{value: "telegram status", description: "Show Telegram integration"},
	{value: "telegram configure", description: "Configure Telegram control"},
	{value: "update check", description: "Check for updates"},
	{value: "update now", description: "Install and deploy the latest release"},
	{value: "update status", description: "Show updater status"},
	{value: "dashboard", description: "Refresh dashboard data"},
	{value: "status", description: "Show runtime status"},
	{value: "queue", description: "Show queue state"},
	{value: "report", description: "Create an operator report"},
	{value: "logs", description: "Show service logs"},
	{value: "doctor", description: "Run diagnostics"},
	{value: "pause", description: "Pause dispatch"},
	{value: "resume", description: "Resume dispatch"},
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

func newModel(client *azblob.Client, factoryName, purpose string) model {
	editor := textarea.New()
	editor.Placeholder = "Factory command (for example: submit workspace fix the failing test)"
	editor.Prompt = ""
	editor.ShowLineNumbers = false
	editor.CharLimit = 12_000
	editor.SetHeight(1)
	editor.Focus()
	return model{
		client:      client,
		factoryName: factoryName,
		purpose:     purpose,
		loading:     true,
		editor:      editor,
		content:     viewport.New(0, 0),
	}
}

func (m model) completions() []completion {
	input := strings.ToLower(m.editor.Value())
	if strings.TrimSpace(input) == "" {
		return nil
	}
	candidates := append([]completion(nil), commandCompletions...)
	for _, item := range m.workspaces {
		candidates = append(candidates,
			completion{value: "submit " + item.Name + " ", description: "Submit an objective"},
			completion{value: "workspace show " + item.Name, description: "Show workspace details"},
			completion{value: "workspace remove " + item.Name, description: "Remove workspace"},
		)
	}
	result := make([]completion, 0, 5)
	for _, candidate := range candidates {
		candidateValue := strings.ToLower(candidate.value)
		if candidateValue != input && strings.HasPrefix(candidateValue, input) {
			result = append(result, candidate)
			if len(result) == 5 {
				break
			}
		}
	}
	return result
}

func (m model) editorHeight() int {
	if count := len(m.completions()); count > 0 {
		return 4 + min(count, 5)
	}
	return 4
}

func (m model) layoutDimensions() (editorHeight, topHeight, leftWidth, rightWidth int) {
	width, height := max(m.width, 1), max(m.height, 1)
	editorHeight = m.editorHeight()
	if height < 18 && editorHeight == 4 {
		editorHeight = 3
	}
	topHeight = max(height-editorHeight-2, 1)
	leftWidth = width
	if width >= 90 {
		leftWidth = width * 7 / 10
		rightWidth = width - leftWidth
	}
	return
}

func (m model) workspaceWindow(maxLines int) (int, int) {
	available := max(maxLines-7, 1)
	start := 0
	if index := m.selectedIndex(); index >= available {
		start = index - available + 1
	}
	end := min(start+available, len(m.workspaces))
	return start, end
}

func (m *model) selectWorkspace(index int) {
	if index < 0 || index >= len(m.workspaces) {
		return
	}
	m.selectedWorkspace = m.workspaces[index].Name
	m.selectedAgent = 0
	m.scroll = 0
	m.syncViewport()
	m.content.GotoTop()
}

func (m *model) ensureAgentVisible() {
	line := 2 + m.selectedAgent*2
	if line < m.content.YOffset {
		m.content.SetYOffset(line)
	} else if line+1 >= m.content.YOffset+m.content.Height {
		m.content.SetYOffset(line - m.content.Height + 2)
	}
}

func (m *model) handleMouse(msg tea.MouseMsg) tea.Cmd {
	editorHeight, topHeight, leftWidth, rightWidth := m.layoutDimensions()
	if msg.Button == tea.MouseButtonWheelUp || msg.Button == tea.MouseButtonWheelDown {
		var command tea.Cmd
		m.content, command = m.content.Update(msg)
		return command
	}
	if msg.Button != tea.MouseButtonLeft || msg.Action != tea.MouseActionPress {
		return nil
	}
	if msg.Y == 2 && msg.X < leftWidth {
		position := 2
		for index, label := range tabs {
			end := position + lipgloss.Width(label)
			if msg.X >= position && msg.X < end {
				m.tab = index
				m.agentFocus = false
				m.syncViewport()
				m.content.GotoTop()
				return nil
			}
			position = end + 2
		}
	}
	if rightWidth > 0 && msg.X >= leftWidth && msg.Y >= 4 && msg.Y < 1+topHeight {
		start, end := m.workspaceWindow(topHeight - 2)
		row := msg.Y - 4
		if m.workspaceErr != "" {
			row--
		}
		if start > 0 {
			row--
		}
		index := start + row
		if row >= 0 && index < end {
			m.selectWorkspace(index)
			m.workspaceFocus = true
			m.agentFocus = false
			m.editor.Blur()
		}
		return nil
	}
	if m.tab == 2 && msg.X < leftWidth && msg.Y >= 3 && msg.Y < 1+topHeight {
		bodyLine := m.content.YOffset + msg.Y - 3
		if bodyLine >= 2 {
			index := (bodyLine - 2) / 2
			if index < len(m.agentRecords()) {
				m.selectedAgent = index
				m.agentFocus = true
				m.workspaceFocus = false
				m.editor.Blur()
				m.syncViewport()
			}
		}
		return nil
	}
	if msg.Y >= 1+topHeight && msg.Y < 1+topHeight+editorHeight {
		m.workspaceFocus = false
		m.agentFocus = false
		return m.editor.Focus()
	}
	return nil
}

func (m *model) acceptCompletion() bool {
	items := m.completions()
	if len(items) == 0 {
		return false
	}
	if m.completionIndex >= len(items) {
		m.completionIndex = 0
	}
	value := items[m.completionIndex].value
	if value == m.editor.Value() {
		return false
	}
	m.setEditorValue(value)
	m.completionIndex = 0
	m.resize()
	m.syncViewport()
	return true
}

func (m *model) resize() {
	width := max(m.width, 1)
	_, topHeight, contentWidth, _ := m.layoutDimensions()
	m.content.Width = max(contentWidth-4, 1)
	m.content.Height = max(topHeight-3, 1)
	m.editor.SetWidth(max(width-13, 1))
	m.editor.SetHeight(1)
}

func (m *model) syncViewport() {
	value := m.body()
	if m.commandOutput != "" {
		value += "\n\n" + lipgloss.NewStyle().Bold(true).Render("COMMAND LOG") + "\n" + clean(m.commandOutput)
	}
	m.content.SetContent(value)
}

func (m *model) setEditorValue(value string) {
	if selected := m.selected(); selected != nil {
		value = strings.ReplaceAll(value, "{workspace}", selected.Name)
	} else {
		value = strings.ReplaceAll(value, "{workspace} ", "")
	}
	m.editor.SetValue(value)
	m.editor.CursorEnd()
	m.editor.Focus()
	m.completionIndex = 0
}

func (m model) Init() tea.Cmd { return tea.Batch(fetchCmd(m.client), tickCmd(), textarea.Blink) }

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.MouseMsg:
		if m.showPalette {
			return m, nil
		}
		return m, m.handleMouse(msg)
	case tea.KeyMsg:
		if m.showPalette {
			switch msg.String() {
			case "ctrl+c":
				return m, tea.Quit
			case "esc", "ctrl+k":
				m.showPalette = false
			case "up", "k":
				if m.paletteIndex > 0 {
					m.paletteIndex--
				}
			case "down", "j":
				if m.paletteIndex < len(paletteActions)-1 {
					m.paletteIndex++
				}
			case "enter":
				m.setEditorValue(paletteActions[m.paletteIndex].prefix)
				m.showPalette = false
				m.resize()
				m.syncViewport()
			}
			return m, nil
		}
		if m.agentFocus {
			switch msg.String() {
			case "ctrl+c":
				return m, tea.Quit
			case "esc", "enter", "ctrl+g":
				m.agentFocus = false
				return m, m.editor.Focus()
			case "up", "k":
				if m.selectedAgent > 0 {
					m.selectedAgent--
					m.syncViewport()
					m.ensureAgentVisible()
				}
			case "down", "j":
				if m.selectedAgent < len(m.agentRecords())-1 {
					m.selectedAgent++
					m.syncViewport()
					m.ensureAgentVisible()
				}
			case "pgup", "pgdown", "home", "end":
				var command tea.Cmd
				m.content, command = m.content.Update(msg)
				return m, command
			}
			return m, nil
		}
		if m.workspaceFocus {
			switch msg.String() {
			case "ctrl+c":
				return m, tea.Quit
			case "esc", "enter", "ctrl+w":
				m.workspaceFocus = false
				return m, m.editor.Focus()
			case "up", "k":
				m.selectWorkspace(m.selectedIndex() - 1)
			case "down", "j":
				m.selectWorkspace(m.selectedIndex() + 1)
			}
			return m, nil
		}
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "ctrl+k":
			m.showPalette = true
			m.paletteIndex = 0
			return m, nil
		case "ctrl+w":
			_, _, _, rightWidth := m.layoutDimensions()
			if len(m.workspaces) > 0 && rightWidth > 0 {
				m.workspaceFocus = true
				m.editor.Blur()
			}
			return m, nil
		case "ctrl+g":
			if m.tab == 2 && len(m.agentRecords()) > 0 {
				m.agentFocus = true
				m.editor.Blur()
			}
			return m, nil
		case "tab":
			if m.acceptCompletion() {
				return m, nil
			}
			if m.tab < len(tabs)-1 {
				m.tab++
			} else {
				m.tab = 0
			}
			m.syncViewport()
			m.content.GotoTop()
			return m, nil
		case "ctrl+left":
			if m.tab > 0 {
				m.tab--
			}
			m.syncViewport()
			m.content.GotoTop()
			return m, nil
		case "ctrl+right":
			if m.tab < len(tabs)-1 {
				m.tab++
			} else {
				m.tab = 0
			}
			m.syncViewport()
			m.content.GotoTop()
			return m, nil
		case "ctrl+p":
			if index := m.selectedIndex(); index > 0 {
				m.selectedWorkspace = m.workspaces[index-1].Name
			}
			m.syncViewport()
			m.content.GotoTop()
			return m, nil
		case "ctrl+n":
			if index := m.selectedIndex(); index >= 0 && index < len(m.workspaces)-1 {
				m.selectedWorkspace = m.workspaces[index+1].Name
			}
			m.syncViewport()
			m.content.GotoTop()
			return m, nil
		case "ctrl+l":
			m.commandOutput = ""
			m.err = nil
			m.syncViewport()
			return m, nil
		case "ctrl+r":
			m.loading = true
			return m, fetchCmd(m.client)
		case "pgup", "pgdown", "ctrl+home", "ctrl+end":
			var command tea.Cmd
			m.content, command = m.content.Update(msg)
			return m, command
		case "up":
			if items := m.completions(); len(items) > 0 {
				if m.completionIndex > 0 {
					m.completionIndex--
				}
				return m, nil
			}
			if m.historyIndex > 0 {
				m.historyIndex--
				m.setEditorValue(m.commandHistory[m.historyIndex])
			}
			return m, nil
		case "down":
			if items := m.completions(); len(items) > 0 {
				if m.completionIndex < len(items)-1 {
					m.completionIndex++
				}
				return m, nil
			}
			if m.historyIndex < len(m.commandHistory)-1 {
				m.historyIndex++
				m.setEditorValue(m.commandHistory[m.historyIndex])
			} else {
				m.historyIndex = len(m.commandHistory)
				m.editor.Reset()
			}
			return m, nil
		case "enter":
			if m.acceptCompletion() {
				return m, nil
			}
			line := strings.TrimSpace(m.editor.Value())
			args, err := parseCommandLine(line)
			if err == nil {
				err = validateFactoryCommand(args)
			}
			if err != nil {
				m.commandOutput = err.Error()
				m.syncViewport()
				m.content.GotoBottom()
				return m, nil
			}
			m.editor.Reset()
			m.commandHistory = append(m.commandHistory, line)
			m.historyIndex = len(m.commandHistory)
			m.loading = true
			if interactiveFactoryCommand(args) {
				return m, interactiveFactoryProcess(args)
			}
			return m, executeFactoryCommand(args)
		}
		var command tea.Cmd
		m.editor, command = m.editor.Update(msg)
		m.completionIndex = 0
		m.resize()
		m.syncViewport()
		return m, command
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.resize()
		m.syncViewport()
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
		m.resize()
		m.syncViewport()
	case commandResultMsg:
		m.loading = false
		m.err = nil
		result := strings.TrimSpace(clean(msg.output))
		if msg.err != nil && result == "" {
			result = msg.err.Error()
		}
		entry := fmt.Sprintf("$ %s\n%s", clean(msg.command), result)
		if m.commandOutput == "" {
			m.commandOutput = entry
		} else {
			m.commandOutput += "\n\n" + entry
		}
		lines := strings.Split(m.commandOutput, "\n")
		if len(lines) > 500 {
			m.commandOutput = strings.Join(lines[len(lines)-500:], "\n")
		}
		m.syncViewport()
		m.content.GotoBottom()
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

func (m model) agentRecords() []agentRecord {
	records := []agentRecord{}
	for _, item := range m.visibleObjectives() {
		for _, agent := range item.Tasks {
			records = append(records, agentRecord{objective: item, task: agent})
		}
	}
	return records
}

func (m model) agents() string {
	records := m.agentRecords()
	if len(records) == 0 {
		return "AGENTS\n\nNo agents for this workspace."
	}
	selected := min(max(m.selectedAgent, 0), len(records)-1)
	var value strings.Builder
	value.WriteString(lipgloss.NewStyle().Bold(true).Render("AGENTS") + "\n\n")
	for index, record := range records {
		state := record.task.State
		if record.task.Stale {
			state = "stale"
		}
		marker := "  "
		style := lipgloss.NewStyle()
		if index == selected {
			marker = "› "
			style = style.Foreground(accent).Bold(true)
		}
		phase := "waiting"
		if record.task.Activity != nil {
			phase = record.task.Activity.Phase
			if phase == "" {
				phase = record.task.Activity.Type
			}
		}
		fmt.Fprintf(&value, "%s%s  %s  %s\n", marker, badge(state), style.Render(clean(record.task.Role)), clean(record.task.Model))
		fmt.Fprintf(&value, "  %s · %s\n", trim(record.task.Title, 70), clean(phase))
	}

	record := records[selected]
	agent := record.task
	state := agent.State
	if agent.Stale {
		state = "stale"
	}
	phase, activityType, tool, occurredAt, activityError := "waiting for activity", "-", "-", "-", ""
	if agent.Activity != nil {
		phase = agent.Activity.Phase
		if phase == "" {
			phase = agent.Activity.Type
		}
		activityType = agent.Activity.Type
		tool = agent.Activity.Tool
		occurredAt = agent.Activity.OccurredAt
		activityError = agent.Activity.LastError
	}
	fmt.Fprintf(&value, "\n%s\n\n", lipgloss.NewStyle().Bold(true).Foreground(accent).Render("SELECTED AGENT"))
	fmt.Fprintf(&value, "%s\n\nObjective  %s\nTask ID    %s\nRole       %s\nModel      %s\nState      %s\nPhase      %s\nActivity   %s\nTool       %s\nUpdated    %s\nRetries    %d\n",
		clean(agent.Title), trim(record.objective.Objective, 90), clean(agent.ID), clean(agent.Role), clean(agent.Model), badge(state), clean(phase), clean(activityType), clean(tool), clean(occurredAt), agent.Retries)
	if agent.LastError != "" {
		fmt.Fprintf(&value, "Last error %s\n", lipgloss.NewStyle().Foreground(danger).Render(clean(agent.LastError)))
	}
	if activityError != "" && activityError != agent.LastError {
		fmt.Fprintf(&value, "Activity error %s\n", lipgloss.NewStyle().Foreground(danger).Render(clean(activityError)))
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
		value.WriteString("No workspaces\n\nctrl+k to import")
	}
	start, end := m.workspaceWindow(maxLines)
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
	value.WriteString("\n" + lipgloss.NewStyle().Foreground(muted).Render("click or ctrl+w focus\n↑/↓ select"))
	return value.String()
}

func (m model) settings() string {
	var value strings.Builder
	value.WriteString("RUNTIME\n")
	fmt.Fprintf(&value, "  Name       %s\n  Purpose    %s\n  Storage    Azure Blob\n  Refresh    15 seconds\n\n", clean(m.factoryName), clean(m.purpose))
	value.WriteString("MODELS\n  models show\n  models set ROLE PROVIDER/MODEL\n\nSECRETS (values hidden)\n")
	for _, item := range m.dashboard.Secrets {
		fmt.Fprintf(&value, "  ● %-36s %s\n", clean(item.Name), clean(item.Updated))
	}
	if len(m.dashboard.Secrets) == 0 {
		value.WriteString("  No secret metadata available\n")
	}
	value.WriteString("\nCAPABILITIES\n  Skills, MCP servers, scanners, ACP, and signed extensions\n  extension verify MANIFEST ARTIFACT PUBLIC_KEY\n")
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
		return "SELECT A WORKSPACE\n\nOpen the command palette with ctrl+k and import one.\nObjectives and agents are scoped to the selected workspace."
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
	width, height := max(m.width, 1), max(m.height, 1)
	headerText := strings.ToUpper(clean(m.factoryName))
	if selected := m.selected(); selected != nil {
		headerText += "  / " + clean(selected.Name)
	}
	header := lipgloss.NewStyle().Width(width).Bold(true).Foreground(accent).Render(trim(headerText, width))
	editorHeight, topHeight, leftWidth, rightWidth := m.layoutDimensions()

	tabValues := make([]string, 0, len(tabs))
	for index, value := range tabs {
		style := lipgloss.NewStyle().Foreground(muted)
		if index == m.tab {
			style = style.Foreground(accent).Bold(true)
		}
		tabValues = append(tabValues, style.Render(value))
	}
	title := trim(strings.Join(tabValues, "  "), max(leftWidth-4, 1))
	contentBorder := border
	if m.agentFocus {
		contentBorder = accent
	}
	content := lipgloss.NewStyle().
		Width(max(leftWidth-2, 1)).
		Height(max(topHeight-2, 1)).
		Border(lipgloss.NormalBorder()).
		BorderForeground(contentBorder).
		Padding(0, 1).
		Render(title + "\n" + m.content.View())
	mainArea := content
	if rightWidth > 0 {
		sidebarBorder := border
		if m.workspaceFocus {
			sidebarBorder = accent
		}
		sidebar := lipgloss.NewStyle().
			Width(max(rightWidth-2, 1)).
			Height(max(topHeight-2, 1)).
			Border(lipgloss.NormalBorder()).
			BorderForeground(sidebarBorder).
			Padding(0, 1).
			Render(m.sidebar(topHeight - 2))
		mainArea = lipgloss.JoinHorizontal(lipgloss.Top, content, sidebar)
	}

	editorTitle := lipgloss.NewStyle().Foreground(accent).Bold(true).Render("COMMAND")
	editorRows := make([]string, 0, 6)
	items := m.completions()
	for index, item := range items {
		marker := "  "
		style := lipgloss.NewStyle().Foreground(muted)
		if index == m.completionIndex {
			marker = "› "
			style = style.Foreground(accent).Bold(true)
		}
		line := marker + item.value + "  " + item.description
		editorRows = append(editorRows, style.Render(trim(line, max(width-6, 1))))
	}
	editorRows = append(editorRows, editorTitle+"  "+m.editor.View())
	editor := lipgloss.NewStyle().
		Width(max(width-2, 1)).
		Height(max(editorHeight-2, 1)).
		Border(lipgloss.NormalBorder()).
		BorderForeground(accent).
		Padding(0, 1).
		Render(strings.Join(editorRows, "\n"))
	status := "tab/enter complete  ctrl+k commands  ctrl+w workspaces  ctrl+g agents  click rows  pgup/pgdn"
	if m.loading {
		status = "Refreshing Factory state...  " + status
	}
	if m.err != nil {
		status = lipgloss.NewStyle().Foreground(danger).Render(trim(m.err.Error(), max(width-1, 1)))
	}
	base := lipgloss.JoinVertical(lipgloss.Left, header, mainArea, editor, lipgloss.NewStyle().Width(width).Foreground(muted).Render(trim(status, width)))
	if !m.showPalette {
		return base
	}
	var rows []string
	rows = append(rows, lipgloss.NewStyle().Foreground(accent).Bold(true).Render("Commands"), "")
	paletteWidth := min(54, max(width-8, 12))
	for index, action := range paletteActions {
		style := lipgloss.NewStyle().Width(paletteWidth).Padding(0, 1)
		if index == m.paletteIndex {
			style = style.Background(accent).Foreground(lipgloss.Color("#07130D")).Bold(true)
		}
		rows = append(rows, style.Render(trim(action.title+"  "+action.description, max(paletteWidth-2, 1))))
	}
	popup := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(accent).Padding(1, 2).Render(strings.Join(rows, "\n"))
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, popup)
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
	application := newModel(client, config["FACTORY_NAME"], config["FACTORY_PURPOSE"])
	if application.factoryName == "" {
		application.factoryName = "Factory AI"
	}
	if application.purpose == "" {
		application.purpose = "Ship secure reviewed software continuously"
	}
	if _, err := tea.NewProgram(application, tea.WithAltScreen(), tea.WithMouseCellMotion()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

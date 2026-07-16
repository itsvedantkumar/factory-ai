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
	"runtime"
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
	Type        string `json:"type"`
	Tool        string `json:"tool"`
	Phase       string `json:"phase"`
	OccurredAt  string `json:"occurredAt"`
	Model       string `json:"model"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	Error       string `json:"error"`
	Container   string `json:"container"`
	Step        int    `json:"step"`
	Attempt     int    `json:"attempt"`
	InputTokens int    `json:"inputTokens"`
	RetryCount  int    `json:"retryCount"`
	LastError   string `json:"lastError"`
}

type task struct {
	ID        string     `json:"id"`
	Role      string     `json:"role"`
	Title     string     `json:"title"`
	Model     string     `json:"model"`
	State     string     `json:"state"`
	Stale     bool       `json:"stale"`
	Activity  *activity  `json:"activity"`
	Retries   int        `json:"retries"`
	LastError string     `json:"lastError"`
	Events    []activity `json:"events"`
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

type quickAction struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Prompt      string   `json:"prompt"`
	Workspace   string   `json:"workspace"`
	Repository  string   `json:"repository"`
	Status      string   `json:"status"`
	Summary     string   `json:"summary"`
	Checks      []string `json:"checks"`
	Risks       []string `json:"risks"`
	Failure     string   `json:"failure"`
	CreatedAt   string   `json:"createdAt"`
	CompletedAt string   `json:"completedAt"`
}

type workspace struct {
	Name       string `json:"name"`
	Repository string `json:"repository"`
	LocalPath  string `json:"localPath"`
	BaseBranch string `json:"baseBranch"`
	Sync       struct {
		Enabled      bool   `json:"enabled"`
		LastStatus   string `json:"lastStatus"`
		LastSyncedAt string `json:"lastSyncedAt"`
		LastError    string `json:"lastError"`
	} `json:"sync"`
}

type usage struct {
	Tasks             int `json:"tasks"`
	InputTokens       int `json:"inputTokens"`
	CachedInputTokens int `json:"cachedInputTokens"`
	OutputTokens      int `json:"outputTokens"`
}

type dashboard struct {
	FactoryName string                           `json:"factoryName"`
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
	Actions    []quickAction    `json:"actions"`
	ModelUsage map[string]usage `json:"modelUsage"`
	Secrets    []struct {
		Name    string `json:"name"`
		Updated string `json:"updated"`
	} `json:"secrets"`
	Warnings []string `json:"warnings"`
}

type schedulerStatus struct {
	Enabled   bool   `json:"enabled"`
	Scheduler string `json:"scheduler"`
	Known     bool   `json:"-"`
	Error     string `json:"-"`
}

type snapshotMsg struct {
	dashboard     dashboard
	logs          string
	workspaces    []workspace
	workspaceErr  string
	syncScheduler schedulerStatus
	err           error
	requestID     int
}
type actionFeed struct {
	GeneratedAt string        `json:"generatedAt"`
	Actions     []quickAction `json:"actions"`
}
type actionFeedMsg struct {
	feed      actionFeed
	err       error
	requestID int
}
type actionPollMsg struct {
	actionID string
}
type cachedSnapshot struct {
	StorageAccount string          `json:"storageAccount"`
	Dashboard      dashboard       `json:"dashboard"`
	Logs           string          `json:"logs"`
	Workspaces     []workspace     `json:"workspaces"`
	WorkspaceErr   string          `json:"workspaceError,omitempty"`
	SyncScheduler  schedulerStatus `json:"syncScheduler"`
}
type tickMsg time.Time
type commandResultMsg struct {
	command, output string
	err             error
}
type agentDiffMsg struct {
	objectiveID string
	taskID      string
	patch       string
	status      string
	source      string
	err         error
	requestID   int
}
type clipboardMsg struct{ err error }

type model struct {
	client              *azblob.Client
	factoryName         string
	purpose             string
	width               int
	height              int
	tab                 int
	scroll              int
	dashboard           dashboard
	logs                string
	workspaces          []workspace
	workspaceErr        string
	syncScheduler       schedulerStatus
	selectedWorkspace   string
	loading             bool
	commandRunning      bool
	err                 error
	commandOutput       string
	commandHistory      []string
	confirmationLine    string
	historyIndex        int
	editor              textarea.Model
	content             viewport.Model
	showPalette         bool
	paletteIndex        int
	completionIndex     int
	workspaceFocus      bool
	agentFocus          bool
	selectedAgent       int
	selectedObjectiveID string
	selectedAgentID     string
	modal               string
	modalIndex          int
	modalSelectedID     string
	followTail          bool
	agentView           string
	agentPatch          string
	agentPatchStatus    string
	agentPatchSource    string
	agentPatchKey       string
	agentPatchLoading   bool
	agentDiffRequest    int
	notice              string
	refreshRequest      int
	actionFeedRequest   int
	pendingActionID     string
	actionPollStarted   time.Time
	storageAccount      string
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
	{title: "New objective", description: "Describe delivery work; workspace is automatic", prefix: "objective: "},
	{title: "Run command", description: "Run a safe command in the selected workspace", prefix: "/run "},
	{title: "Preview app", description: "Run the selected workspace dev server", prefix: "/preview"},
	{title: "Import workspace", description: "Add a local path or owner/repository", prefix: "workspace import "},
	{title: "Enable Git sync", description: "Opt in selected workspace to two-way sync", prefix: "workspace sync enable {workspace}"},
	{title: "Sync workspace now", description: "Push or fast-forward committed changes", prefix: "workspace sync now {workspace}"},
	{title: "Disable Git sync", description: "Stop automatic sync for selected workspace", prefix: "workspace sync disable {workspace}"},
	{title: "Set secret", description: "Store a secret in Azure Key Vault", prefix: "secret set "},
	{title: "Approve checkpoint", description: "Approve the selected policy checkpoint", prefix: "approval approve {objective} {approval} "},
	{title: "Deny checkpoint", description: "Reject the selected policy checkpoint", prefix: "approval deny {objective} {approval} "},
	{title: "Show models", description: "Inspect active role and model routes", prefix: "models show"},
	{title: "Pause factory", description: "Stop dispatching new work", prefix: "pause"},
	{title: "Resume factory", description: "Resume work dispatch", prefix: "resume"},
}

type completion struct {
	value       string
	description string
}

type pickerItem struct {
	id          string
	title       string
	description string
}

const addWorkspaceID = "__add_workspace__"
const newObjectiveID = "__new_objective__"

var commandCompletions = []completion{
	{value: "/help", description: "Show the beginner command guide"},
	{value: "/commands", description: "Open all Factory commands"},
	{value: "/workspace", description: "Choose a workspace"},
	{value: "/workspace add ", description: "Import a local path or OWNER/REPO"},
	{value: "/objective", description: "Choose an objective"},
	{value: "/run ", description: "Run a command in this workspace"},
	{value: "/preview", description: "Start the workspace development server"},
	{value: "/agent", description: "Choose a sub-agent"},
	{value: "/diff", description: "Show selected agent code"},
	{value: "/activity", description: "Show selected agent activity"},
	{value: "/copy", description: "Copy the visible code diff"},
	{value: "/refresh", description: "Refresh Factory state"},
	{value: "/quit", description: "Exit Factory"},
	{value: "help", description: "Show the command reference"},
	{value: "setup", description: "Deploy or repair Factory AI"},
	{value: "configure models", description: "Configure model providers"},
	{value: "workspace list", description: "List imported workspaces"},
	{value: "workspace import ", description: "Import a path or owner/repository"},
	{value: "workspace show ", description: "Show workspace details"},
	{value: "workspace remove ", description: "Remove a workspace"},
	{value: "workspace sync status", description: "Show two-way sync status"},
	{value: "workspace sync now ", description: "Sync committed changes now"},
	{value: "workspace sync enable ", description: "Enable automatic two-way sync"},
	{value: "workspace sync disable ", description: "Disable automatic two-way sync"},
	{value: "models show", description: "Show model routes"},
	{value: "models set ", description: "Set a role model"},
	{value: "models reset ", description: "Reset a role model"},
	{value: "secret list", description: "List secret metadata"},
	{value: "secret set ", description: "Set a secret"},
	{value: "secret copy ", description: "Copy a secret"},
	{value: "secret delete ", description: "Delete a secret"},
	{value: "approval approve ", description: "Approve a policy checkpoint"},
	{value: "approval deny ", description: "Deny a policy checkpoint"},
	{value: "agent diff ", description: "Show an agent worktree patch"},
	{value: "github status", description: "Show GitHub connection"},
	{value: "github connect ", description: "Connect a GitHub organization"},
	{value: "telegram status", description: "Show Telegram integration"},
	{value: "telegram configure", description: "Configure Telegram control"},
	{value: "update check", description: "Check for updates"},
	{value: "update now", description: "Install and deploy the latest release"},
	{value: "update status", description: "Show updater status"},
	{value: "update enable", description: "Enable automatic updates"},
	{value: "update disable", description: "Disable automatic updates"},
	{value: "dashboard", description: "Refresh dashboard data"},
	{value: "status", description: "Show runtime status"},
	{value: "queue", description: "Show queue state"},
	{value: "report", description: "Create an operator report"},
	{value: "logs", description: "Show service logs"},
	{value: "doctor", description: "Run diagnostics"},
	{value: "pause", description: "Pause dispatch"},
	{value: "resume", description: "Resume dispatch"},
	{value: "shutdown", description: "Stop the complete runtime"},
	{value: "start", description: "Start the complete runtime"},
}

var (
	accent = lipgloss.Color("#78DBA9")
	blue   = lipgloss.Color("#77A8FF")
	warn   = lipgloss.Color("#EFC46B")
	danger = lipgloss.Color("#EF7D7D")
	muted  = lipgloss.Color("#7F8B99")
	panel  = lipgloss.Color("#15191F")
	border = lipgloss.Color("#303743")
	tabs   = []string{"Session", "Objectives", "Dashboard", "Settings"}
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

func appendLocalEvent(event string, fields map[string]string) error {
	directory := os.Getenv("FACTORY_LOCAL_LOG_DIR")
	if directory == "" {
		home, _ := os.UserHomeDir()
		directory = filepath.Join(home, ".local", "share", "factory-ai", "logs")
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	record := map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"client":    "Factory AI",
		"source":    "factory-ai",
		"service":   "factory-ui",
		"event":     trim(event, 100),
	}
	allowed := map[string]bool{"command": true, "workspace": true, "objectiveId": true, "taskId": true, "status": true}
	for key, value := range fields {
		if allowed[key] {
			record[key] = trim(value, 128)
		}
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file := filepath.Join(directory, time.Now().UTC().Format("2006-01-02")+".jsonl")
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer handle.Close()
	_ = handle.Chmod(0o600)
	_, err = handle.Write(append(data, '\n'))
	return err
}

func safeLocalCommand(command string) string {
	allowed := map[string]bool{
		"acp": true, "agent": true, "approval": true, "configure": true, "dashboard": true, "doctor": true,
		"extension": true, "github": true, "init": true, "issue": true, "logs": true,
		"models": true, "pause": true, "queue": true, "report": true, "resume": true,
		"secret": true, "setup": true, "shutdown": true, "start": true, "status": true,
		"prompt": true, "submit": true, "telegram": true, "ui": true, "update": true, "usage": true,
		"workspace": true,
	}
	if allowed[command] {
		return command
	}
	return "unknown"
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

func inputKind(value string) string {
	line := strings.TrimSpace(value)
	if strings.HasPrefix(line, "/") {
		return "slash"
	}
	if line == "factory" || strings.HasPrefix(line, "factory ") {
		return "factory"
	}
	return "prompt"
}

func validateWorkspaceCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("enter a command to run")
	}
	allowed := map[string]bool{"git": true, "node": true, "npm": true, "npx": true, "pnpm": true, "yarn": true}
	if !allowed[args[0]] {
		return fmt.Errorf("command not allowed: %s", args[0])
	}
	denied := map[string]bool{"publish": true, "unpublish": true, "login": true, "logout": true, "token": true, "config": true, "dlx": true, "global": true, "-g": true, "--global": true, "push": true, "remote": true, "credential": true}
	for _, arg := range args[1:] {
		if denied[arg] {
			return fmt.Errorf("unsafe command operation: %s", arg)
		}
	}
	if args[0] == "npx" && (len(args) < 2 || args[1] != "--no-install") {
		return fmt.Errorf("npx requires --no-install")
	}
	if args[0] == "git" {
		readOnly := map[string]bool{"status": true, "diff": true, "log": true, "show": true, "grep": true, "ls-files": true, "rev-parse": true}
		if len(args) < 2 || !readOnly[args[1]] {
			return fmt.Errorf("only read-only Git commands are allowed")
		}
	}
	return nil
}

func defaultPreviewCommand(item workspace) []string {
	manager := "npm"
	if _, err := os.Stat(filepath.Join(item.LocalPath, "pnpm-lock.yaml")); err == nil {
		manager = "pnpm"
	} else if _, err := os.Stat(filepath.Join(item.LocalPath, "yarn.lock")); err == nil {
		manager = "yarn"
	}
	args := []string{manager, "run", "dev"}
	if data, err := os.ReadFile(filepath.Join(item.LocalPath, "package.json")); err == nil {
		if bytes.Contains(data, []byte(`"vite"`)) {
			args = append(args, "--", "--host", "0.0.0.0")
		} else if bytes.Contains(data, []byte(`"next"`)) {
			args = append(args, "--", "-H", "0.0.0.0")
		}
	}
	return args
}

func validateFactoryCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("enter a factory command")
	}
	allowed := map[string]bool{"setup": true, "configure": true, "models": true, "acp": true, "extension": true, "github": true, "telegram": true, "workspace": true, "prompt": true, "submit": true, "issue": true, "init": true, "secret": true, "agent": true, "dashboard": true, "status": true, "queue": true, "report": true, "usage": true, "logs": true, "doctor": true, "pause": true, "resume": true, "shutdown": true, "start": true, "update": true, "approval": true, "help": true, "--help": true, "-h": true}
	if args[0] == "ui" {
		return fmt.Errorf("the UI command cannot be launched inside itself")
	}
	if !allowed[args[0]] {
		return fmt.Errorf("unknown factory command: %s", args[0])
	}
	return nil
}

func requiresConfirmation(args []string) bool {
	if len(args) == 0 {
		return false
	}
	if args[0] == "shutdown" || len(args) > 1 && args[0] == "update" && args[1] == "now" {
		return true
	}
	return len(args) > 1 && ((args[0] == "workspace" && args[1] == "remove") || (args[0] == "secret" && args[1] == "delete") || (args[0] == "github" && args[1] == "transfer"))
}

func interactiveFactoryCommand(args []string) bool {
	if len(args) == 0 {
		return false
	}
	return args[0] == "setup" || args[0] == "configure" || args[0] == "secret" && len(args) > 1 && args[1] == "set" || args[0] == "telegram" && len(args) > 1 && args[1] == "configure" || args[0] == "workspace" && len(args) > 1 && args[1] == "import" || args[0] == "update" && len(args) > 1 && args[1] == "now"
}

func executeFactoryCommand(args []string) tea.Cmd {
	return func() tea.Msg {
		command := "factory " + strings.Join(args, " ")
		output, err := exec.Command("factory", args...).CombinedOutput()
		return commandResultMsg{command: command, output: string(output), err: err}
	}
}

func promptActionID(result commandResultMsg) (string, bool) {
	if result.err != nil || !strings.HasPrefix(result.command, "factory prompt ") {
		return "", false
	}
	var value struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(result.output)), &value) != nil || value.Kind != "action" || !strings.HasPrefix(value.ID, "action-") {
		return "", false
	}
	return value.ID, true
}

func shouldPollAction(status string) bool {
	return status != "succeeded" && status != "failed" && status != "cancelled"
}

func mergeQuickActions(current, incoming []quickAction) []quickAction {
	byID := make(map[string]quickAction, len(current)+len(incoming))
	for _, action := range current {
		byID[action.ID] = action
	}
	terminal := func(status string) bool { return !shouldPollAction(status) }
	for _, action := range incoming {
		previous, exists := byID[action.ID]
		if !exists || terminal(action.Status) && !terminal(previous.Status) || terminal(action.Status) == terminal(previous.Status) && (!terminal(action.Status) || action.CompletedAt > previous.CompletedAt) {
			byID[action.ID] = action
		}
	}
	merged := make([]quickAction, 0, len(byID))
	for _, action := range byID {
		merged = append(merged, action)
	}
	sort.SliceStable(merged, func(left, right int) bool { return merged[left].CreatedAt < merged[right].CreatedAt })
	if len(merged) > 100 {
		merged = merged[len(merged)-100:]
	}
	return merged
}

func fetchActionFeedCmd(client *azblob.Client, requestID int) tea.Cmd {
	return func() tea.Msg {
		data, err := download(client, "quick-actions.json")
		var feed actionFeed
		if err == nil {
			err = json.Unmarshal(data, &feed)
		}
		return actionFeedMsg{feed: feed, err: err, requestID: requestID}
	}
}

func pollActionCmd(actionID string) tea.Cmd {
	return tea.Tick(2*time.Second, func(time.Time) tea.Msg { return actionPollMsg{actionID: actionID} })
}

func interactiveSandboxProcess(item workspace, args []string, preview bool) tea.Cmd {
	var transcript synchronizedBuffer
	factoryArgs := []string{"sandbox", "run", item.Name}
	if preview {
		factoryArgs = append(factoryArgs, "--preview")
	}
	factoryArgs = append(factoryArgs, "--")
	factoryArgs = append(factoryArgs, args...)
	command := exec.Command("factory", factoryArgs...)
	command.Stdin = os.Stdin
	command.Stdout = io.MultiWriter(os.Stdout, &transcript)
	command.Stderr = io.MultiWriter(os.Stderr, &transcript)
	label := item.Name + " $ " + strings.Join(args, " ")
	return tea.ExecProcess(command, func(err error) tea.Msg {
		return commandResultMsg{command: label, output: transcript.String(), err: err}
	})
}

func fetchAgentDiffCmd(objectiveID, taskID string, requestID int) tea.Cmd {
	return func() tea.Msg {
		output, err := exec.Command("factory", "agent", "diff", objectiveID, taskID, "--json").CombinedOutput()
		value := clean(string(output))
		start := strings.Index(value, `{"objectiveId"`)
		end := strings.LastIndex(value, "}")
		if err == nil && (start < 0 || end < start) {
			err = fmt.Errorf("agent diff returned invalid output")
		}
		var result struct {
			Patch  string `json:"patch"`
			Status string `json:"status"`
			Source string `json:"source"`
		}
		if err == nil {
			err = json.Unmarshal([]byte(value[start:end+1]), &result)
		}
		if err != nil {
			return agentDiffMsg{objectiveID: objectiveID, taskID: taskID, requestID: requestID, err: fmt.Errorf("%s: %w", trim(value, 500), err)}
		}
		return agentDiffMsg{objectiveID: objectiveID, taskID: taskID, requestID: requestID, patch: result.Patch, status: result.Status, source: result.Source}
	}
}

func copyToClipboardCmd(value string) tea.Cmd {
	return func() tea.Msg {
		var command *exec.Cmd
		switch runtime.GOOS {
		case "darwin":
			command = exec.Command("pbcopy")
		case "windows":
			command = exec.Command("clip")
		default:
			if executable, err := exec.LookPath("wl-copy"); err == nil {
				command = exec.Command(executable)
			} else if executable, err := exec.LookPath("xclip"); err == nil {
				command = exec.Command(executable, "-selection", "clipboard")
			} else {
				return clipboardMsg{err: fmt.Errorf("install wl-copy or xclip for clipboard support")}
			}
		}
		command.Stdin = strings.NewReader(value)
		return clipboardMsg{err: command.Run()}
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
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	response, err := client.DownloadStream(ctx, "operator", name, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	return io.ReadAll(response.Body)
}

func operatorCacheFile(account string) string {
	if value := os.Getenv("FACTORY_UI_CACHE_FILE"); value != "" {
		return value
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cache", "factory-ai", fmt.Sprintf("operator-snapshot-%s.json", account))
}

func writeOperatorCache(account string, message snapshotMsg) {
	value := cachedSnapshot{StorageAccount: account, Dashboard: message.dashboard, Logs: message.logs, Workspaces: message.workspaces, WorkspaceErr: message.workspaceErr, SyncScheduler: message.syncScheduler}
	data, err := json.Marshal(value)
	if err != nil || len(data) > 2_000_000 {
		return
	}
	file := operatorCacheFile(account)
	if os.MkdirAll(filepath.Dir(file), 0o700) != nil {
		return
	}
	temporary := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if os.WriteFile(temporary, data, 0o600) == nil {
		_ = os.Rename(temporary, file)
	} else {
		_ = os.Remove(temporary)
	}
}

func readOperatorCache(account string) (snapshotMsg, bool) {
	file := operatorCacheFile(account)
	metadata, err := os.Lstat(file)
	if err != nil {
		return snapshotMsg{}, false
	}
	age := time.Since(metadata.ModTime())
	if !metadata.Mode().IsRegular() || metadata.Mode().Perm()&0o077 != 0 || metadata.Size() > 2_000_000 || age < -5*time.Minute || age > 24*time.Hour {
		if age > 24*time.Hour {
			_ = os.Remove(file)
		}
		return snapshotMsg{}, false
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return snapshotMsg{}, false
	}
	var value cachedSnapshot
	if json.Unmarshal(data, &value) != nil {
		return snapshotMsg{}, false
	}
	if value.StorageAccount != account {
		return snapshotMsg{}, false
	}
	return snapshotMsg{dashboard: value.Dashboard, logs: value.Logs, workspaces: value.Workspaces, workspaceErr: value.WorkspaceErr, syncScheduler: value.SyncScheduler}, true
}

func fetchCmd(client *azblob.Client, requestID int) tea.Cmd {
	return func() tea.Msg {
		var board dashboard
		var dashboardErr error
		var logData []byte
		var workspaces []workspace
		var syncScheduler schedulerStatus
		workspaceErr := ""
		var group sync.WaitGroup
		group.Add(4)
		go func() {
			defer group.Done()
			data, err := download(client, "dashboard.json")
			if err == nil {
				err = json.Unmarshal(data, &board)
			}
			dashboardErr = err
		}()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = exec.CommandContext(ctx, "factory", "usage", "sync").Run()
		}()
		go func() { defer group.Done(); logData, _ = download(client, "logs.txt") }()
		go func() {
			defer group.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if output, commandError := exec.CommandContext(ctx, "factory", "workspace", "list").Output(); commandError == nil {
				if decodeError := json.Unmarshal(output, &workspaces); decodeError != nil {
					workspaceErr = decodeError.Error()
				}
			} else {
				workspaceErr = commandError.Error()
			}
		}()
		go func() {
			defer group.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if output, commandError := exec.CommandContext(ctx, "factory", "workspace", "sync", "status").Output(); commandError == nil {
				var status struct {
					Scheduler schedulerStatus `json:"scheduler"`
				}
				if json.Unmarshal(output, &status) == nil {
					syncScheduler = status.Scheduler
					syncScheduler.Known = true
				}
			} else {
				syncScheduler.Error = commandError.Error()
			}
		}()
		group.Wait()
		if dashboardErr != nil {
			return snapshotMsg{err: dashboardErr, requestID: requestID}
		}
		message := snapshotMsg{dashboard: board, logs: string(logData), workspaces: workspaces, workspaceErr: workspaceErr, syncScheduler: syncScheduler, requestID: requestID}
		return message
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(60*time.Second, func(value time.Time) tea.Msg { return tickMsg(value) })
}

func newModel(client *azblob.Client, factoryName, purpose string) model {
	editor := textarea.New()
	editor.Placeholder = "Ask Factory AI anything · objective: ... · /run · /preview"
	editor.Prompt = ""
	editor.ShowLineNumbers = false
	editor.CharLimit = 12_000
	editor.SetHeight(3)
	editor.Focus()
	return model{
		client:         client,
		factoryName:    factoryName,
		purpose:        purpose,
		loading:        true,
		followTail:     true,
		editor:         editor,
		content:        viewport.New(0, 0),
		refreshRequest: 1,
	}
}

func (m model) completions() []completion {
	input := strings.ToLower(m.editor.Value())
	if strings.TrimSpace(input) == "" {
		return nil
	}
	slashMode := strings.HasPrefix(input, "/")
	factoryMode := input == "factory" || strings.HasPrefix(input, "factory ")
	if !slashMode && !factoryMode {
		return nil
	}
	candidates := append([]completion(nil), commandCompletions...)
	for _, item := range m.workspaces {
		candidates = append(candidates,
			completion{value: "/workspace " + item.Name, description: "Switch workspace"},
			completion{value: "submit " + item.Name + " ", description: "Submit an objective"},
			completion{value: "workspace show " + item.Name, description: "Show workspace details"},
			completion{value: "workspace remove " + item.Name, description: "Remove workspace"},
			completion{value: "workspace sync now " + item.Name, description: "Sync committed changes"},
			completion{value: "workspace sync enable " + item.Name, description: "Enable automatic sync"},
			completion{value: "workspace sync disable " + item.Name, description: "Disable automatic sync"},
		)
	}
	for _, item := range m.visibleObjectives() {
		candidates = append(candidates, completion{value: "/objective " + item.ID, description: trim(item.Objective, 60)})
	}
	for _, item := range m.agentRecords() {
		candidates = append(candidates, completion{value: "/agent " + item.task.ID, description: item.task.Role + " · " + trim(item.task.Title, 50)})
	}
	result := make([]completion, 0, 5)
	for _, candidate := range candidates {
		if slashMode && !strings.HasPrefix(candidate.value, "/") || factoryMode && strings.HasPrefix(candidate.value, "/") {
			continue
		}
		if factoryMode {
			candidate.value = "factory " + candidate.value
		}
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
		return 6 + min(count, 5)
	}
	return 6
}

func (m model) layoutDimensions() (editorHeight, topHeight, leftWidth, rightWidth int) {
	width, height := max(m.width, 1), max(m.height, 1)
	editorHeight = m.editorHeight()
	if height < 18 {
		editorHeight = min(editorHeight, 3)
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

func (m model) modalItems() []pickerItem {
	items := []pickerItem{}
	switch m.modal {
	case "workspaces":
		items = append(items, pickerItem{id: addWorkspaceID, title: "+ Add workspace...", description: "Import a local path or OWNER/REPO"})
		for _, workspace := range m.workspaces {
			sync := "sync off"
			if workspace.Sync.Enabled {
				sync = "sync " + workspace.Sync.LastStatus
			}
			items = append(items, pickerItem{id: workspace.Name, title: workspace.Name, description: workspace.Repository + " · " + sync})
		}
	case "objectives":
		items = append(items, pickerItem{id: newObjectiveID, title: "+ New objective...", description: "Describe work for the selected workspace"})
		objectives := m.visibleObjectives()
		for index := len(objectives) - 1; index >= 0; index-- {
			items = append(items, pickerItem{id: objectives[index].ID, title: objectives[index].Objective, description: objectives[index].Status + " · " + objectives[index].ID})
		}
	case "agents":
		if objective := m.selectedObjective(); objective != nil {
			for _, agent := range objective.Tasks {
				phase := agent.State
				if agent.Activity != nil && agent.Activity.Phase != "" {
					phase = agent.Activity.Phase
				}
				items = append(items, pickerItem{id: agent.ID, title: agent.Role + " · " + agent.Title, description: phase + " · " + agent.Model})
			}
		}
	}
	return items
}

func (m *model) openModal(kind string) {
	m.modal = kind
	m.modalIndex = 0
	items := m.modalItems()
	selectedID := ""
	if kind == "workspaces" {
		selectedID = m.selectedWorkspace
	} else if kind == "objectives" {
		selectedID = m.selectedObjectiveID
	} else if kind == "agents" {
		selectedID = m.selectedAgentID
	}
	for index, item := range items {
		if item.id == selectedID {
			m.modalIndex = index
			break
		}
	}
	if len(items) > 0 {
		m.modalSelectedID = items[m.modalIndex].id
	} else {
		m.modalSelectedID = ""
	}
	m.editor.Blur()
}

func (m *model) resetAgentView() {
	m.agentView = "activity"
	m.agentPatchLoading = false
}

func (m *model) reconcileModal() {
	if m.modal == "" {
		return
	}
	items := m.modalItems()
	for index, item := range items {
		if item.id == m.modalSelectedID {
			m.modalIndex = index
			return
		}
	}
	if len(items) == 0 {
		m.modalIndex = 0
		m.modalSelectedID = ""
		return
	}
	m.modalIndex = min(m.modalIndex, len(items)-1)
	m.modalSelectedID = items[m.modalIndex].id
}

func (m *model) chooseModalItem() tea.Cmd {
	items := m.modalItems()
	if len(items) == 0 {
		m.modal = ""
		return m.editor.Focus()
	}
	m.reconcileModal()
	item := items[m.modalIndex]
	switch m.modal {
	case "workspaces":
		if item.id == addWorkspaceID {
			m.modal = ""
			m.modalSelectedID = ""
			m.setEditorValue("factory workspace import ")
			m.resize()
			m.syncViewport()
			return m.editor.Focus()
		}
		for index := range m.workspaces {
			if m.workspaces[index].Name == item.id {
				m.selectWorkspace(index)
				break
			}
		}
	case "objectives":
		if item.id == newObjectiveID {
			m.modal = ""
			m.modalSelectedID = ""
			m.setEditorValue("objective: ")
			m.resize()
			return m.editor.Focus()
		}
		m.selectedObjectiveID = item.id
		m.selectedAgentID = ""
		m.resetAgentView()
		m.ensureSelection()
		m.syncViewport()
		m.content.GotoBottom()
	case "agents":
		m.selectedAgentID = item.id
		m.resetAgentView()
		m.ensureSelection()
		m.syncViewport()
		m.content.GotoBottom()
	}
	m.modal = ""
	m.modalSelectedID = ""
	return m.editor.Focus()
}

func (m *model) selectWorkspace(index int) {
	if index < 0 || index >= len(m.workspaces) {
		return
	}
	m.selectedWorkspace = m.workspaces[index].Name
	m.selectedAgent = 0
	m.selectedObjectiveID = ""
	m.selectedAgentID = ""
	m.resetAgentView()
	m.ensureSelection()
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

func (m model) sidebarAgentStartY() int {
	localLine := 2
	if workspace := m.selected(); workspace != nil {
		localLine = 3
		if workspace.Sync.LastSyncedAt != "" {
			localLine++
		}
		if workspace.Sync.LastError != "" {
			localLine++
		}
	}
	if m.selectedObjective() != nil {
		localLine++
	}
	return 2 + localLine + 3
}

func (m *model) handleMouse(msg tea.MouseMsg) tea.Cmd {
	editorHeight, topHeight, leftWidth, rightWidth := m.layoutDimensions()
	if msg.Button == tea.MouseButtonWheelUp || msg.Button == tea.MouseButtonWheelDown {
		var command tea.Cmd
		m.content, command = m.content.Update(msg)
		m.followTail = false
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
	agentStartY := m.sidebarAgentStartY()
	if rightWidth > 0 && msg.X >= leftWidth && msg.Y >= agentStartY && msg.Y < 1+topHeight {
		records := m.agentRecords()
		available := max(((topHeight-2)-8)/2, 1)
		start := 0
		if m.selectedAgent >= available {
			start = m.selectedAgent - available + 1
		}
		index := start + (msg.Y-agentStartY)/2
		if index >= 0 && index < len(records) {
			m.selectedAgent = index
			m.selectedAgentID = records[index].task.ID
			m.resetAgentView()
			m.agentFocus = true
			m.workspaceFocus = false
			m.editor.Blur()
			m.syncViewport()
			m.content.GotoBottom()
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
	if m.height < 18 {
		m.editor.SetHeight(1)
	} else {
		m.editor.SetHeight(3)
	}
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
		value = strings.ReplaceAll(value, "{workspace}", "")
	}
	if objective := m.selectedObjective(); objective != nil {
		value = strings.ReplaceAll(value, "{objective}", objective.ID)
		approvalID := ""
		if objective.Approval != nil {
			approvalID = objective.Approval.ApprovalID
		}
		value = strings.ReplaceAll(value, "{approval}", approvalID)
	} else {
		value = strings.ReplaceAll(value, "{objective}", "")
		value = strings.ReplaceAll(value, "{approval}", "")
	}
	m.editor.SetValue(value)
	m.editor.CursorEnd()
	m.editor.Focus()
	m.completionIndex = 0
}

func (m *model) runSlashCommand(line string) (bool, tea.Cmd) {
	args, err := parseCommandLine(strings.TrimPrefix(strings.TrimSpace(line), "/"))
	if err != nil || len(args) == 0 {
		m.notice = "Invalid slash command. Type /help"
		return true, nil
	}
	known := map[string]bool{"workspace": true, "ws": true, "objective": true, "session": true, "agent": true, "new": true, "run": true, "preview": true, "diff": true, "code": true, "activity": true, "copy": true, "help": true, "commands": true, "refresh": true, "quit": true, "exit": true}
	if known[args[0]] {
		_ = appendLocalEvent("command.executed", map[string]string{"command": "/" + args[0]})
	}
	finish := func() { m.editor.Reset(); m.historyIndex = len(m.commandHistory) }
	switch args[0] {
	case "workspace", "ws":
		if len(args) == 1 {
			finish()
			m.openModal("workspaces")
			return true, nil
		}
		if args[1] == "add" {
			if len(args) == 2 {
				m.setEditorValue("factory workspace import ")
				return true, nil
			}
			finish()
			m.loading = true
			m.commandRunning = true
			return true, interactiveFactoryProcess(append([]string{"workspace", "import"}, args[2:]...))
		}
		for index, item := range m.workspaces {
			if strings.EqualFold(item.Name, args[1]) {
				finish()
				m.selectWorkspace(index)
				m.notice = "Workspace: " + item.Name
				return true, nil
			}
		}
		m.notice = "Unknown workspace. Type /workspace or /workspace add"
		return true, nil
	case "objective", "session":
		if len(args) == 1 {
			finish()
			m.openModal("objectives")
			return true, nil
		}
		if args[1] == "add" || args[1] == "new" {
			selected := m.selected()
			if selected == nil {
				m.notice = "Choose a workspace with /workspace first"
				return true, nil
			}
			if len(args) == 2 {
				m.setEditorValue("objective: ")
				return true, nil
			}
			finish()
			m.loading = true
			return true, executeFactoryCommand(append([]string{"submit", selected.Name}, args[2:]...))
		}
		for _, item := range m.visibleObjectives() {
			if strings.EqualFold(item.ID, args[1]) {
				finish()
				m.selectedObjectiveID = item.ID
				m.selectedAgentID = ""
				m.resetAgentView()
				m.ensureSelection()
				m.syncViewport()
				m.content.GotoBottom()
				return true, nil
			}
		}
		m.notice = "Unknown objective. Type /objective to choose"
		return true, nil
	case "agent":
		if len(args) == 1 {
			finish()
			m.openModal("agents")
			return true, nil
		}
		for index, item := range m.agentRecords() {
			if strings.EqualFold(item.task.ID, args[1]) || strings.EqualFold(item.task.Role, args[1]) {
				finish()
				m.selectedAgent, m.selectedAgentID = index, item.task.ID
				m.resetAgentView()
				m.syncViewport()
				m.content.GotoBottom()
				return true, nil
			}
		}
		m.notice = "Unknown agent. Type /agent to choose"
		return true, nil
	case "new":
		selected := m.selected()
		if selected == nil {
			m.notice = "Choose a workspace with /workspace first"
			return true, nil
		}
		if len(args) == 1 {
			m.setEditorValue("objective: ")
			return true, nil
		}
		finish()
		m.loading = true
		m.commandRunning = true
		return true, executeFactoryCommand(append([]string{"submit", selected.Name}, args[1:]...))
	case "run", "preview":
		selected := m.selected()
		if selected == nil || selected.LocalPath == "" {
			m.notice = "Choose a local workspace with /workspace first"
			return true, nil
		}
		commandArgs := args[1:]
		if len(commandArgs) == 0 && args[0] == "preview" {
			commandArgs = defaultPreviewCommand(*selected)
		}
		if err := validateWorkspaceCommand(commandArgs); err != nil {
			m.notice = err.Error()
			return true, nil
		}
		confirmation := selected.Name + "\x00" + strings.TrimSpace(line)
		if m.confirmationLine != confirmation {
			m.confirmationLine = confirmation
			m.notice = "This runs repository code inside a local Docker sandbox. Press Enter again to continue."
			return true, nil
		}
		m.confirmationLine = ""
		finish()
		m.loading = true
		m.commandRunning = true
		if args[0] == "preview" {
			return true, interactiveSandboxProcess(*selected, commandArgs, true)
		}
		return true, interactiveSandboxProcess(*selected, commandArgs, false)
	case "diff", "code":
		objective := m.selectedObjective()
		if objective == nil || m.selectedAgentID == "" {
			m.notice = "Choose an objective and agent first"
			return true, nil
		}
		finish()
		m.agentView = "diff"
		m.agentDiffRequest++
		m.agentPatchLoading = true
		m.syncViewport()
		return true, fetchAgentDiffCmd(objective.ID, m.selectedAgentID, m.agentDiffRequest)
	case "activity":
		finish()
		m.agentDiffRequest++
		m.agentPatchLoading = false
		m.agentView = "activity"
		m.syncViewport()
		m.content.GotoBottom()
		return true, nil
	case "copy":
		finish()
		objective := m.selectedObjective()
		if objective == nil || m.agentPatchLoading || m.agentView != "diff" || m.agentPatchKey != objective.ID+":"+m.selectedAgentID || m.agentPatch == "" || m.agentPatchSource == "error" {
			m.notice = "Wait for /diff to finish before copying"
			return true, nil
		}
		return true, copyToClipboardCmd(clean(m.agentPatch))
	case "help":
		finish()
		m.modal = "help"
		m.editor.Blur()
		return true, nil
	case "commands":
		finish()
		m.paletteIndex = 0
		m.showPalette = true
		m.editor.Blur()
		return true, nil
	case "refresh":
		finish()
		m.loading = true
		m.refreshRequest++
		return true, fetchCmd(m.client, m.refreshRequest)
	case "quit", "exit":
		return true, tea.Quit
	default:
		m.notice = "Unknown slash command: /" + args[0] + ". Type /help"
		return true, nil
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(fetchCmd(m.client, m.refreshRequest), tickCmd(), textarea.Blink)
}

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.MouseMsg:
		if m.showPalette || m.modal != "" {
			return m, nil
		}
		return m, m.handleMouse(msg)
	case tea.KeyMsg:
		m.notice = ""
		if msg.String() != "enter" {
			m.confirmationLine = ""
		}
		if msg.String() == "f1" {
			if m.modal == "help" {
				m.modal = ""
				return m, m.editor.Focus()
			}
			m.modal = "help"
			m.showPalette = false
			m.agentFocus = false
			m.workspaceFocus = false
			m.editor.Blur()
			return m, nil
		}
		if m.modal != "" {
			items := m.modalItems()
			switch msg.String() {
			case "ctrl+c":
				return m, tea.Quit
			case "esc", "f1":
				m.modal = ""
				return m, m.editor.Focus()
			case "a":
				if m.modal == "workspaces" {
					m.modalIndex = 0
					m.modalSelectedID = addWorkspaceID
					return m, m.chooseModalItem()
				}
			case "up", "k":
				if m.modalIndex > 0 {
					m.modalIndex--
				}
			case "down", "j":
				if m.modalIndex < len(items)-1 {
					m.modalIndex++
				}
			case "enter":
				return m, m.chooseModalItem()
			}
			if m.modalIndex >= 0 && m.modalIndex < len(items) {
				m.modalSelectedID = items[m.modalIndex].id
			}
			return m, nil
		}
		if m.showPalette {
			switch msg.String() {
			case "ctrl+c":
				return m, tea.Quit
			case "esc", "ctrl+k":
				m.showPalette = false
				return m, m.editor.Focus()
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
					m.selectedAgentID = m.agentRecords()[m.selectedAgent].task.ID
					m.resetAgentView()
					m.syncViewport()
					m.content.GotoBottom()
				}
			case "down", "j":
				if m.selectedAgent < len(m.agentRecords())-1 {
					m.selectedAgent++
					m.selectedAgentID = m.agentRecords()[m.selectedAgent].task.ID
					m.resetAgentView()
					m.syncViewport()
					m.content.GotoBottom()
				}
			case "pgup", "pgdown", "home", "end":
				var command tea.Cmd
				m.content, command = m.content.Update(msg)
				m.followTail = msg.String() == "end"
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
		case "f1":
			m.modal = "help"
			m.modalIndex = 0
			m.modalSelectedID = ""
			m.editor.Blur()
			return m, nil
		case "ctrl+k":
			m.showPalette = true
			m.paletteIndex = 0
			return m, nil
		case "ctrl+w":
			m.openModal("workspaces")
			return m, nil
		case "ctrl+s":
			m.openModal("objectives")
			return m, nil
		case "ctrl+g":
			m.openModal("agents")
			return m, nil
		case "ctrl+d":
			objective := m.selectedObjective()
			if objective == nil || m.selectedAgentID == "" {
				return m, nil
			}
			m.agentView = "diff"
			m.agentDiffRequest++
			m.agentPatchLoading = true
			m.syncViewport()
			return m, fetchAgentDiffCmd(objective.ID, m.selectedAgentID, m.agentDiffRequest)
		case "ctrl+y":
			objective := m.selectedObjective()
			if objective == nil || m.agentView != "diff" || m.agentPatchKey != objective.ID+":"+m.selectedAgentID || m.agentPatch == "" || m.agentPatchSource == "error" {
				m.notice = "Open an agent code diff with Ctrl+D before copying"
				return m, nil
			}
			return m, copyToClipboardCmd(clean(m.agentPatch))
		case "ctrl+a":
			m.agentView = "activity"
			m.syncViewport()
			m.content.GotoBottom()
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
				m.selectWorkspace(index - 1)
			}
			m.syncViewport()
			m.content.GotoTop()
			return m, nil
		case "ctrl+n":
			if index := m.selectedIndex(); index >= 0 && index < len(m.workspaces)-1 {
				m.selectWorkspace(index + 1)
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
			m.refreshRequest++
			return m, fetchCmd(m.client, m.refreshRequest)
		case "pgup", "pgdown", "ctrl+home", "ctrl+end":
			var command tea.Cmd
			m.content, command = m.content.Update(msg)
			m.followTail = msg.String() == "ctrl+end"
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
		case "alt+enter":
			m.editor.InsertString("\n")
			m.resize()
			m.syncViewport()
			return m, nil
		case "enter":
			line := strings.TrimSpace(m.editor.Value())
			if line == "" {
				return m, nil
			}
			if m.commandRunning {
				m.notice = "A command is already running. Wait for it to finish."
				return m, nil
			}
			slashRoots := map[string]bool{"/workspace": true, "/ws": true, "/objective": true, "/session": true, "/agent": true, "/run": true, "/preview": true, "/diff": true, "/code": true, "/activity": true, "/copy": true, "/help": true, "/commands": true, "/refresh": true, "/quit": true, "/exit": true}
			if slashRoots[line] {
				_, command := m.runSlashCommand(line)
				return m, command
			}
			if (strings.HasPrefix(line, "/") || inputKind(line) == "factory") && m.acceptCompletion() {
				return m, nil
			}
			if strings.HasPrefix(line, "/") {
				_, command := m.runSlashCommand(line)
				return m, command
			}
			if inputKind(line) == "prompt" {
				selected := m.selected()
				if selected == nil {
					m.notice = "Choose a workspace first. Type /workspace"
					return m, nil
				}
				m.editor.Reset()
				m.commandHistory = append(m.commandHistory, line)
				m.historyIndex = len(m.commandHistory)
				m.loading = true
				m.commandRunning = true
				_ = appendLocalEvent("command.executed", map[string]string{"command": "prompt"})
				return m, executeFactoryCommand([]string{"prompt", selected.Name, line})
			}
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
			if requiresConfirmation(args) && m.confirmationLine != line {
				m.confirmationLine = line
				m.notice = "Consequential command. Press Enter again to confirm, or edit to cancel."
				return m, nil
			}
			m.confirmationLine = ""
			_ = appendLocalEvent("command.executed", map[string]string{"command": safeLocalCommand(args[0])})
			m.editor.Reset()
			m.commandHistory = append(m.commandHistory, line)
			m.historyIndex = len(m.commandHistory)
			m.loading = true
			m.commandRunning = true
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
		if msg.requestID != 0 && msg.requestID != m.refreshRequest {
			return m, nil
		}
		m.loading = false
		m.err = msg.err
		if msg.err == nil {
			msg.dashboard.Actions = mergeQuickActions(m.dashboard.Actions, msg.dashboard.Actions)
			m.dashboard, m.logs, m.workspaces, m.workspaceErr, m.syncScheduler = msg.dashboard, msg.logs, msg.workspaces, msg.workspaceErr, msg.syncScheduler
			if msg.dashboard.FactoryName != "" {
				m.factoryName = msg.dashboard.FactoryName
			}
			if len(m.workspaces) == 0 {
				m.selectedWorkspace = ""
			} else if m.selected() == nil {
				m.selectedWorkspace = m.workspaces[0].Name
			}
			m.ensureSelection()
			m.reconcileModal()
			writeOperatorCache(m.storageAccount, msg)
		}
		m.resize()
		m.syncViewport()
		if m.followTail && m.tab == 0 {
			m.content.GotoBottom()
		}
	case commandResultMsg:
		m.loading = false
		m.commandRunning = false
		m.err = nil
		result := strings.TrimSpace(clean(msg.output))
		if msg.err != nil && result == "" {
			result = msg.err.Error()
		}
		mark := "✓"
		if msg.err != nil {
			mark = "✗"
			if result != "" {
				result += "\n" + msg.err.Error()
			}
		}
		entry := fmt.Sprintf("%s $ %s\n%s", mark, clean(msg.command), result)
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
		m.refreshRequest++
		commands := []tea.Cmd{fetchCmd(m.client, m.refreshRequest)}
		if actionID, ok := promptActionID(msg); ok {
			m.pendingActionID = actionID
			m.actionPollStarted = time.Now()
			m.actionFeedRequest++
			commands = append(commands, fetchActionFeedCmd(m.client, m.actionFeedRequest))
		}
		return m, tea.Batch(commands...)
	case actionFeedMsg:
		if msg.requestID != m.actionFeedRequest {
			return m, nil
		}
		status := ""
		if msg.err == nil {
			m.dashboard.Actions = mergeQuickActions(m.dashboard.Actions, msg.feed.Actions)
			for _, action := range m.dashboard.Actions {
				if action.ID == m.pendingActionID {
					status = action.Status
					break
				}
			}
			m.syncViewport()
			m.content.GotoBottom()
		}
		if m.pendingActionID == "" {
			return m, nil
		}
		if !shouldPollAction(status) || time.Since(m.actionPollStarted) >= 2*time.Minute {
			m.pendingActionID = ""
			return m, nil
		}
		return m, pollActionCmd(m.pendingActionID)
	case actionPollMsg:
		if msg.actionID == "" || msg.actionID != m.pendingActionID {
			return m, nil
		}
		if time.Since(m.actionPollStarted) >= 2*time.Minute {
			m.pendingActionID = ""
			return m, nil
		}
		m.actionFeedRequest++
		return m, fetchActionFeedCmd(m.client, m.actionFeedRequest)
	case agentDiffMsg:
		objective := m.selectedObjective()
		if objective == nil || msg.objectiveID != objective.ID || msg.taskID != m.selectedAgentID || msg.requestID != m.agentDiffRequest {
			return m, nil
		}
		m.agentPatchLoading = false
		m.agentView = "diff"
		m.agentPatchKey = msg.objectiveID + ":" + msg.taskID
		if msg.err != nil {
			m.agentPatch = msg.err.Error()
			m.agentPatchStatus = "unavailable"
			m.agentPatchSource = "error"
		} else {
			m.agentPatch = msg.patch
			m.agentPatchStatus = msg.status
			m.agentPatchSource = msg.source
		}
		m.syncViewport()
		m.content.GotoTop()
	case clipboardMsg:
		if msg.err != nil {
			m.notice = "Copy failed: " + msg.err.Error()
		} else {
			m.notice = "Agent code copied to clipboard"
		}
	case tickMsg:
		if !m.loading {
			m.loading = true
			m.refreshRequest++
			return m, tea.Batch(fetchCmd(m.client, m.refreshRequest), tickCmd())
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

func (m model) selectedObjective() *objective {
	workspace := m.selected()
	if workspace == nil {
		return nil
	}
	for index := range m.dashboard.Objectives {
		if m.dashboard.Objectives[index].ID == m.selectedObjectiveID && normalizeRepository(m.dashboard.Objectives[index].Repository) == normalizeRepository(workspace.Repository) {
			return &m.dashboard.Objectives[index]
		}
	}
	return nil
}

func (m *model) ensureSelection() {
	objectives := m.visibleObjectives()
	if len(objectives) == 0 {
		m.selectedObjectiveID = ""
		m.selectedAgentID = ""
		m.selectedAgent = 0
		return
	}
	if m.selectedObjective() == nil {
		m.selectedObjectiveID = objectives[len(objectives)-1].ID
	}
	selected := m.selectedObjective()
	if selected == nil || len(selected.Tasks) == 0 {
		m.selectedAgentID = ""
		m.selectedAgent = 0
		return
	}
	for index, agent := range selected.Tasks {
		if agent.ID == m.selectedAgentID {
			m.selectedAgent = index
			return
		}
	}
	m.selectedAgent = 0
	m.selectedAgentID = selected.Tasks[0].ID
}

func (m model) sessionStream() string {
	selected := m.selectedObjective()
	var value strings.Builder
	if m.workspaceErr != "" {
		fmt.Fprintf(&value, "%s %s\n\n", lipgloss.NewStyle().Foreground(danger).Bold(true).Render("WORKSPACE ERROR"), clean(m.workspaceErr))
	}
	for _, warning := range m.dashboard.Warnings {
		fmt.Fprintf(&value, "%s %s\n", lipgloss.NewStyle().Foreground(warn).Bold(true).Render("WARNING"), clean(warning))
	}
	if len(m.dashboard.Warnings) > 0 {
		value.WriteString("\n")
	}
	value.WriteString(lipgloss.NewStyle().Foreground(accent).Bold(true).Render("QUICK ACTIONS") + "\n")
	actionCount := 0
	for index := len(m.dashboard.Actions) - 1; index >= 0 && actionCount < 5; index-- {
		action := m.dashboard.Actions[index]
		if m.selectedWorkspace != "" && action.Workspace != "" && !strings.EqualFold(action.Workspace, m.selectedWorkspace) {
			continue
		}
		fmt.Fprintf(&value, "%s  %s\n", badge(action.Status), trim(action.Prompt, 100))
		if action.Summary != "" {
			fmt.Fprintf(&value, "    %s\n", clean(action.Summary))
		}
		if action.Failure != "" {
			fmt.Fprintf(&value, "    %s\n", lipgloss.NewStyle().Foreground(danger).Render(clean(action.Failure)))
		}
		actionCount++
	}
	if actionCount == 0 {
		value.WriteString(lipgloss.NewStyle().Foreground(muted).Render("Type a prompt below. Delivery work is routed to Objectives automatically.") + "\n")
	}
	if selected == nil {
		value.WriteString("\n" + lipgloss.NewStyle().Foreground(muted).Render("Commands: /run npm test · /preview · objective: build ...") + "\n")
		return value.String()
	}
	var agent *task
	for index := range selected.Tasks {
		if selected.Tasks[index].ID == m.selectedAgentID {
			agent = &selected.Tasks[index]
			break
		}
	}
	value.WriteString("\n" + lipgloss.NewStyle().Foreground(accent).Bold(true).Render("ACTIVE OBJECTIVE") + "\n")
	fmt.Fprintf(&value, "%s  %s\n%s\n", badge(selected.Status), clean(selected.Objective), lipgloss.NewStyle().Foreground(muted).Render(clean(selected.ID)))
	if agent == nil {
		value.WriteString("\nNo sub-agents have been created for this objective yet.\n")
		return value.String()
	}
	fmt.Fprintf(&value, "\n%s\n%s · %s · %s\n\n", lipgloss.NewStyle().Foreground(accent).Bold(true).Render(clean(agent.Title)), clean(agent.Role), clean(agent.Model), badge(agent.State))
	if m.agentView == "diff" {
		key := selected.ID + ":" + agent.ID
		value.WriteString(lipgloss.NewStyle().Foreground(blue).Bold(true).Render("CODE DIFF") + "\n")
		if m.agentPatchLoading {
			value.WriteString("Loading isolated worktree patch...\n")
		} else if m.agentPatchKey != key {
			value.WriteString("Press Ctrl+D to load this agent's patch.\n")
		} else {
			fmt.Fprintf(&value, "%s\n", lipgloss.NewStyle().Foreground(muted).Render(clean(m.agentPatchSource+" · "+m.agentPatchStatus)))
			value.WriteString(clean(m.agentPatch) + "\n")
		}
		return value.String()
	}
	events := append([]activity(nil), agent.Events...)
	if len(events) == 0 && agent.Activity != nil {
		events = append(events, *agent.Activity)
	}
	sort.SliceStable(events, func(left, right int) bool { return events[left].OccurredAt < events[right].OccurredAt })
	if len(events) == 0 {
		value.WriteString(lipgloss.NewStyle().Foreground(muted).Render("Waiting for agent activity...") + "\n")
	}
	for _, event := range events {
		timestamp := event.OccurredAt
		if parsed, err := time.Parse(time.RFC3339, event.OccurredAt); err == nil {
			timestamp = parsed.Local().Format("15:04:05")
		}
		label := event.Type
		if event.Tool != "" {
			label += "  " + event.Tool
		}
		fmt.Fprintf(&value, "%s  %s\n", lipgloss.NewStyle().Foreground(muted).Render(timestamp), lipgloss.NewStyle().Bold(true).Render(clean(label)))
		detail := event.Phase
		if event.Model != "" {
			detail += " · " + event.Model
		}
		if event.Attempt > 0 {
			detail += fmt.Sprintf(" · attempt %d", event.Attempt)
		}
		if detail != "" {
			fmt.Fprintf(&value, "          %s\n", lipgloss.NewStyle().Foreground(muted).Render(clean(strings.TrimPrefix(detail, " · "))))
		}
		if event.Error != "" {
			fmt.Fprintf(&value, "          %s\n", lipgloss.NewStyle().Foreground(danger).Render(clean(event.Error)))
		}
		value.WriteString("\n")
	}
	if agent.LastError != "" && (agent.State == "failed" || agent.State == "retrying" || agent.Stale) {
		fmt.Fprintf(&value, "%s %s\n", lipgloss.NewStyle().Foreground(danger).Bold(true).Render("LAST ERROR"), clean(agent.LastError))
	}
	return value.String()
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
	items := []objective{}
	if selected := m.selectedObjective(); selected != nil {
		items = append(items, *selected)
	}
	for _, item := range items {
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
	if agent.LastError != "" && (agent.State == "failed" || agent.State == "retrying" || agent.Stale) {
		fmt.Fprintf(&value, "Last error %s\n", lipgloss.NewStyle().Foreground(danger).Render(clean(agent.LastError)))
	}
	if activityError != "" && activityError != agent.LastError && (agent.State == "failed" || agent.State == "retrying" || agent.Stale) {
		fmt.Fprintf(&value, "Activity error %s\n", lipgloss.NewStyle().Foreground(danger).Render(clean(activityError)))
	}
	return value.String()
}

func (m model) sidebar(maxLines int) string {
	var value strings.Builder
	value.WriteString(lipgloss.NewStyle().Bold(true).Render("SESSION") + "\n")
	if workspace := m.selected(); workspace != nil {
		sync := "sync off"
		if workspace.Sync.Enabled {
			sync = "sync " + workspace.Sync.LastStatus
		}
		fmt.Fprintf(&value, "%s\n%s\n", lipgloss.NewStyle().Foreground(accent).Bold(true).Render(clean(workspace.Name)), lipgloss.NewStyle().Foreground(muted).Render(clean(sync)))
		if workspace.Sync.LastSyncedAt != "" {
			fmt.Fprintf(&value, "%s\n", lipgloss.NewStyle().Foreground(muted).Render(trim("at "+workspace.Sync.LastSyncedAt, 22)))
		}
		if workspace.Sync.LastError != "" {
			fmt.Fprintf(&value, "%s\n", lipgloss.NewStyle().Foreground(danger).Render(trim(workspace.Sync.LastError, 22)))
		}
	} else {
		value.WriteString("No workspace\n")
	}
	if objective := m.selectedObjective(); objective != nil {
		fmt.Fprintf(&value, "%s · %s\n", badge(objective.Status), trim(objective.ID, 18))
	}
	value.WriteString("\n" + lipgloss.NewStyle().Bold(true).Render("AGENTS") + "\n\n")
	records := m.agentRecords()
	available := max((maxLines-8)/2, 1)
	start := 0
	if m.selectedAgent >= available {
		start = m.selectedAgent - available + 1
	}
	end := min(start+available, len(records))
	for index := start; index < end; index++ {
		record := records[index]
		marker := "  "
		style := lipgloss.NewStyle().Foreground(muted)
		if record.task.ID == m.selectedAgentID {
			marker = "› "
			style = style.Foreground(accent).Bold(true)
		}
		state := record.task.State
		if record.task.Stale {
			state = "stale"
		}
		fmt.Fprintf(&value, "%s%s %s\n", marker, style.Render(trim(record.task.Role, 10)), badge(state))
		phase := record.task.Title
		if record.task.Activity != nil && record.task.Activity.Phase != "" {
			phase = record.task.Activity.Phase
		}
		fmt.Fprintf(&value, "  %s\n", lipgloss.NewStyle().Foreground(muted).Render(trim(phase, 22)))
	}
	if len(records) == 0 {
		value.WriteString(lipgloss.NewStyle().Foreground(muted).Render("Waiting for plan...") + "\n")
	}
	value.WriteString("\n" + lipgloss.NewStyle().Foreground(muted).Render("/workspace switch/add\n/objective choose\n/agent choose\n/diff code · /copy\n/help"))
	return value.String()
}

func (m model) settings() string {
	var value strings.Builder
	value.WriteString("RUNTIME\n")
	fmt.Fprintf(&value, "  Name       %s\n  Purpose    %s\n  Storage    Azure Blob\n  Refresh    60 seconds (Ctrl+R anytime)\n\n", clean(m.factoryName), clean(m.purpose))
	scheduler := m.syncScheduler.Scheduler
	if !m.syncScheduler.Known {
		scheduler = "unknown"
	}
	fmt.Fprintf(&value, "WORKSPACE SYNC\n  Scheduler  %s\n  Enabled    %t\n  Status     workspace sync status\n", clean(scheduler), m.syncScheduler.Enabled)
	if m.syncScheduler.Error != "" {
		fmt.Fprintf(&value, "  Error      %s\n", trim(m.syncScheduler.Error, 70))
	}
	value.WriteString("\n")
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
		return "SELECT A WORKSPACE\n\nType /workspace to choose one or /workspace add OWNER/REPO to import one."
	}
	switch m.tab {
	case 0:
		return m.sessionStream()
	case 1:
		return m.objectives()
	case 2:
		return m.overview()
	default:
		return m.settings()
	}
}

func (m model) View() string {
	width, height := max(m.width, 1), max(m.height, 1)
	if width < 20 || height < 8 {
		rows := []string{trim(strings.ToUpper(clean(m.factoryName)), width), trim("COMMAND "+m.editor.Value(), width), trim("/help · /workspace · /quit", width)}
		if m.modal != "" {
			rows[1] = trim("SELECT "+m.modal, width)
			items := m.modalItems()
			if len(items) > 0 {
				rows[2] = trim(items[min(m.modalIndex, len(items)-1)].title, width)
			}
		} else if m.showPalette {
			rows[1] = "COMMANDS"
			rows[2] = trim(paletteActions[min(m.paletteIndex, len(paletteActions)-1)].title, width)
		}
		return strings.Join(rows[:min(len(rows), height)], "\n")
	}
	headerText := strings.ToUpper(clean(m.factoryName))
	if selected := m.selected(); selected != nil {
		headerText += "  / " + clean(selected.Name)
	}
	if objective := m.selectedObjective(); objective != nil {
		headerText += "  / " + clean(objective.ID)
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
		if m.agentFocus {
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

	editorTitle := lipgloss.NewStyle().Foreground(accent).Bold(true).Render("PROMPT")
	editorRows := make([]string, 0, 6)
	items := m.completions()
	if limit := max(editorHeight-4, 0); len(items) > limit {
		items = items[:limit]
	}
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
	status := "/help  /workspace  /run  /preview  /objective"
	if m.loading {
		status = "Refreshing Factory state...  " + status
	}
	if m.notice != "" {
		status = m.notice + "  " + status
	}
	if generated, err := time.Parse(time.RFC3339, m.dashboard.GeneratedAt); err == nil {
		status = fmt.Sprintf("snapshot %ds ago  %s", max(int(time.Since(generated).Seconds()), 0), status)
	}
	if m.err != nil {
		status = lipgloss.NewStyle().Foreground(danger).Render(trim(m.err.Error(), max(width-1, 1)))
	}
	base := lipgloss.JoinVertical(lipgloss.Left, header, mainArea, editor, lipgloss.NewStyle().Width(width).Foreground(muted).Render(trim(status, width)))
	if m.modal != "" {
		if m.modal == "help" {
			help := []string{
				lipgloss.NewStyle().Foreground(accent).Bold(true).Render("Getting started"),
				"",
				"1. /workspace · /workspace add    Choose or import a workspace",
				"2. Type normally                   Ask about that workspace",
				"3. objective: ...                  Force a delivery Objective",
				"4. prompt: ...                     Force a quick answer",
				"5. /run npm test · /preview        Run or preview locally",
				"6. /objective                      Inspect delivery Objectives",
				"7. /agent · /diff · /copy          Inspect and copy agent code",
				"8. Alt+Enter                       Add a newline to the prompt",
				"",
				"Keyboard shortcuts still work; slash commands are primary",
				"Esc or F1 closes help",
			}
			maxWidth := max(min(width-8, 72), 12)
			visible := max(height-6, 1)
			if len(help) > visible {
				help = append(help[:max(visible-1, 0)], "... F1 closes help")
			}
			for index := range help {
				help[index] = trim(help[index], max(maxWidth-4, 1))
			}
			popup := lipgloss.NewStyle().Width(maxWidth).Border(lipgloss.RoundedBorder()).BorderForeground(accent).Padding(1, 2).Render(strings.Join(help, "\n"))
			return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, popup)
		}
		titles := map[string]string{"workspaces": "Select workspace", "objectives": "Select objective", "agents": "Select agent"}
		rows := []string{lipgloss.NewStyle().Foreground(accent).Bold(true).Render(titles[m.modal]), ""}
		modalWidth := min(68, max(width-8, 16))
		items := m.modalItems()
		if len(items) == 0 {
			rows = append(rows, lipgloss.NewStyle().Foreground(muted).Render("Nothing available"))
		}
		visible := max(height-8, 1)
		start := 0
		if m.modalIndex >= visible {
			start = m.modalIndex - visible + 1
		}
		end := min(start+visible, len(items))
		if start > 0 {
			rows = append(rows, lipgloss.NewStyle().Foreground(muted).Render("↑ more"))
		}
		for index := start; index < end; index++ {
			item := items[index]
			style := lipgloss.NewStyle().Width(modalWidth).Padding(0, 1)
			if index == m.modalIndex {
				style = style.Background(accent).Foreground(lipgloss.Color("#07130D")).Bold(true)
			}
			rows = append(rows, style.Render(trim(item.title+"  "+item.description, max(modalWidth-2, 1))))
		}
		if end < len(items) {
			rows = append(rows, lipgloss.NewStyle().Foreground(muted).Render("↓ more"))
		}
		popup := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(accent).Padding(1, 2).Render(strings.Join(rows, "\n"))
		return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, popup)
	}
	if !m.showPalette {
		return base
	}
	var rows []string
	rows = append(rows, lipgloss.NewStyle().Foreground(accent).Bold(true).Render("Commands"), "")
	paletteWidth := min(54, max(width-8, 12))
	visible := max(height-8, 1)
	start := 0
	if m.paletteIndex >= visible {
		start = m.paletteIndex - visible + 1
	}
	end := min(start+visible, len(paletteActions))
	if start > 0 {
		rows = append(rows, lipgloss.NewStyle().Foreground(muted).Render("↑ more"))
	}
	for index := start; index < end; index++ {
		action := paletteActions[index]
		style := lipgloss.NewStyle().Width(paletteWidth).Padding(0, 1)
		if index == m.paletteIndex {
			style = style.Background(accent).Foreground(lipgloss.Color("#07130D")).Bold(true)
		}
		rows = append(rows, style.Render(trim(action.title+"  "+action.description, max(paletteWidth-2, 1))))
	}
	if end < len(paletteActions) {
		rows = append(rows, lipgloss.NewStyle().Foreground(muted).Render("↓ more"))
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
	application.storageAccount = account
	if cached, ok := readOperatorCache(account); ok {
		application.dashboard, application.logs, application.workspaces = cached.dashboard, cached.logs, cached.workspaces
		application.workspaceErr, application.syncScheduler = cached.workspaceErr, cached.syncScheduler
		if len(application.workspaces) > 0 {
			application.selectedWorkspace = application.workspaces[0].Name
			application.ensureSelection()
		}
	}
	if application.factoryName == "" {
		application.factoryName = "Factory AI"
	}
	if application.purpose == "" {
		application.purpose = "Ship secure reviewed software continuously"
	}
	_ = appendLocalEvent("session.started", map[string]string{"command": "ui"})
	if _, err := tea.NewProgram(application, tea.WithAltScreen(), tea.WithMouseCellMotion()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = appendLocalEvent("session.ended", map[string]string{"status": "closed"})
}

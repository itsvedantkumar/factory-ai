package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
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
	dashboard dashboard
	logs      string
	err       error
}
type tickMsg time.Time
type resumeMsg struct{ err error }

type model struct {
	client      *azblob.Client
	factoryName string
	purpose     string
	width       int
	height      int
	tab         int
	scroll      int
	dashboard   dashboard
	logs        string
	loading     bool
	err         error
}

var (
	accent = lipgloss.Color("#78DBA9")
	blue   = lipgloss.Color("#77A8FF")
	warn   = lipgloss.Color("#EFC46B")
	danger = lipgloss.Color("#EF7D7D")
	muted  = lipgloss.Color("#7F8B99")
	panel  = lipgloss.Color("#15191F")
	border = lipgloss.Color("#303743")
	tabs   = []string{"Overview", "Objectives", "Agents", "Secrets", "Capabilities", "Logs", "Settings"}
	ansi   = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)`)
)

func clean(value string) string {
	value = ansi.ReplaceAllString(value, "")
	return strings.Map(func(character rune) rune {
		if character == '\n' || character == '\t' || character >= 0x20 && character != 0x7f {
			return character
		}
		return -1
	}, value)
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
		return snapshotMsg{dashboard: board, logs: string(logData)}
	}
}

func tickCmd() tea.Cmd {
	return tea.Tick(15*time.Second, func(value time.Time) tea.Msg { return tickMsg(value) })
}
func (m model) Init() tea.Cmd { return tea.Batch(fetchCmd(m.client), tickCmd()) }

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.KeyMsg:
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
		case "o", "n", "a", "p", "u", "y", "x":
			return m, tea.ExecProcess(exec.Command("factory-ui"), func(err error) tea.Msg { return resumeMsg{err: err} })
		case "r":
			m.loading = true
			return m, fetchCmd(m.client)
		default:
			if len(msg.String()) == 1 && msg.String()[0] >= '1' && msg.String()[0] <= '7' {
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
			m.dashboard, m.logs = msg.dashboard, msg.logs
		}
	case resumeMsg:
		m.err = msg.err
		if msg.err == nil {
			m.loading = true
			return m, fetchCmd(m.client)
		}
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

func (m model) overview() string {
	cost := "unavailable"
	if m.dashboard.Cost != nil {
		cost = fmt.Sprintf("%s %.2f", m.dashboard.Cost.Currency, m.dashboard.Cost.MonthToDate)
	}
	counts := []string{}
	for key, value := range m.dashboard.Summary.Objectives {
		counts = append(counts, fmt.Sprintf("%s %d", key, value))
	}
	in, cached, out := 0, 0, 0
	for _, value := range m.dashboard.ModelUsage {
		in += value.InputTokens
		cached += value.CachedInputTokens
		out += value.OutputTokens
	}
	value := fmt.Sprintf("%s\n\nHealth       %s\nQueue        %s\nDead letters %d\nAzure MTD    %s\nObjectives   %s\nTokens       %d in · %d cached · %d out\n\n%s\n\n", lipgloss.NewStyle().Bold(true).Render("SYSTEM"), badge(m.dashboard.Health.Status), lipgloss.NewStyle().Foreground(accent).Render(fmt.Sprint(m.dashboard.Queue.Active)), m.dashboard.Queue.DeadLetter, lipgloss.NewStyle().Foreground(warn).Render(cost), strings.Join(counts, "  "), in, cached, out, lipgloss.NewStyle().Bold(true).Render("RECENT OBJECTIVES"))
	for index := len(m.dashboard.Objectives) - 1; index >= 0 && index >= len(m.dashboard.Objectives)-8; index-- {
		item := m.dashboard.Objectives[index]
		value += fmt.Sprintf("%s  %s\n    %s\n\n", badge(item.Status), trim(item.Objective, 90), lipgloss.NewStyle().Foreground(muted).Render(clean(item.Repository)))
	}
	return value
}

func (m model) objectives() string {
	var value strings.Builder
	for index := len(m.dashboard.Objectives) - 1; index >= 0; index-- {
		item := m.dashboard.Objectives[index]
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
		value.WriteString("\n")
	}
	return value.String()
}

func (m model) agents() string {
	var value strings.Builder
	for _, item := range m.dashboard.Objectives {
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

func (m model) body() string {
	switch m.tab {
	case 0:
		return m.overview()
	case 1:
		return m.objectives()
	case 2:
		return m.agents()
	case 3:
		var b strings.Builder
		b.WriteString("GLOBAL KEY VAULT\nValues are never displayed.\n\n")
		for _, item := range m.dashboard.Secrets {
			fmt.Fprintf(&b, "● %-55s %s\n", clean(item.Name), clean(item.Updated))
		}
		return b.String()
	case 4:
		return "CURATED CAPABILITIES\n\nSkills: /goal, /loop, TDD, debugging, verification, security, release discipline\nMCP: Context7, Playwright, knowledge-graph memory\nScanners: Trivy, Gitleaks, OSV-Scanner, Semgrep"
	case 5:
		if m.logs == "" {
			return "No log snapshot available."
		}
		return clean(m.logs)
	default:
		return fmt.Sprintf("FACTORY SETTINGS\n\nName     %s\nPurpose  %s\nStorage  Azure Blob snapshot\nRefresh  15 seconds\n\nUse `factory configure models` or `factory models set ROLE PROVIDER/MODEL` to change routing.", clean(m.factoryName), clean(m.purpose))
	}
}

func (m model) View() string {
	width := m.width
	if width < 80 {
		width = 80
	}
	header := lipgloss.NewStyle().Bold(true).Foreground(accent).Render(strings.ToUpper(clean(m.factoryName))) + "  " + lipgloss.NewStyle().Foreground(muted).Render(clean(m.purpose))
	tabValues := []string{}
	for index, value := range tabs {
		style := lipgloss.NewStyle().Padding(0, 1).Foreground(muted)
		if index == m.tab {
			style = style.Foreground(lipgloss.Color("#07130D")).Background(accent).Bold(true)
		}
		tabValues = append(tabValues, style.Render(fmt.Sprintf("%d %s", index+1, value)))
	}
	tabLine := lipgloss.JoinHorizontal(lipgloss.Top, tabValues...)
	height := m.height - 6
	if height < 10 {
		height = 10
	}
	lines := strings.Split(m.body(), "\n")
	visible := height - 2
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
	content := lipgloss.NewStyle().Width(width-4).Height(height).Border(lipgloss.RoundedBorder()).BorderForeground(border).Padding(1, 2).Render(strings.Join(lines[scroll:end], "\n"))
	footer := "←/→ tabs  ·  ↑/↓ scroll  ·  o actions  ·  r refresh  ·  q quit"
	if m.loading {
		footer = "Refreshing snapshot…"
	}
	if m.err != nil {
		footer = lipgloss.NewStyle().Foreground(danger).Render(m.err.Error())
	}
	return lipgloss.JoinVertical(lipgloss.Left, header, tabLine, content, lipgloss.NewStyle().Foreground(muted).Render(footer))
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

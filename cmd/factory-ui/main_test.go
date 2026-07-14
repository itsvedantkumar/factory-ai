package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func TestCleanRemovesTerminalControlSequences(t *testing.T) {
	value := clean("safe\x1b]52;c;clipboard\x07\x1b[31mred\x1b[0m\x00")
	if value != "safered" || strings.ContainsRune(value, '\x1b') {
		t.Fatalf("unexpected sanitized value %q", value)
	}
}

func TestSynchronizedTranscriptAcceptsConcurrentStreams(t *testing.T) {
	var transcript synchronizedBuffer
	var group sync.WaitGroup
	for index := 0; index < 20; index++ {
		group.Add(1)
		go func(value int) { defer group.Done(); _, _ = fmt.Fprintf(&transcript, "line-%d\n", value) }(index)
	}
	group.Wait()
	if strings.Count(transcript.String(), "line-") != 20 {
		t.Fatal("concurrent transcript lost output")
	}
}

func TestCommandBarAcceptsTypedFactoryCommands(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	var updated tea.Model
	for _, character := range "workspace list" {
		updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{character}})
		current = updated.(model)
	}
	if current.editor.Value() != "workspace list" {
		t.Fatalf("got %q", current.editor.Value())
	}
	updated, command := current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.editor.Value() != "" || command == nil {
		t.Fatal("expected executable native command")
	}
}

func TestCommandPalettePrefillsSelectedAction(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "beta"}}
	current.selectedWorkspace = "beta"
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	current = updated.(model)
	if !current.showPalette {
		t.Fatal("expected command palette")
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.showPalette || current.editor.Value() != "submit beta " {
		t.Fatalf("palette did not prefill selected action: %q", current.editor.Value())
	}
}

func TestCommandHistoryUsesArrowKeys(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.commandHistory = []string{"workspace list", "models show"}
	current.historyIndex = len(current.commandHistory)
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyUp})
	current = updated.(model)
	if current.editor.Value() != "models show" {
		t.Fatalf("history did not recall latest command: %q", current.editor.Value())
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyDown})
	current = updated.(model)
	if current.editor.Value() != "" {
		t.Fatalf("history did not return to empty input: %q", current.editor.Value())
	}
}

func TestParseCommandLineSupportsQuotesAndFactoryPrefix(t *testing.T) {
	args, err := parseCommandLine(`factory submit smoke "add focused tests"`)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"submit", "smoke", "add focused tests"}
	if len(args) != len(expected) {
		t.Fatalf("got %#v", args)
	}
	for index := range expected {
		if args[index] != expected[index] {
			t.Fatalf("got %#v", args)
		}
	}
	if _, err := parseCommandLine(`submit smoke "unterminated`); err == nil {
		t.Fatal("expected unterminated quote error")
	}
}

func TestValidateFactoryCommandRejectsRecursionAndShellSyntax(t *testing.T) {
	if err := validateFactoryCommand([]string{"workspace", "list"}); err != nil {
		t.Fatal(err)
	}
	if err := validateFactoryCommand([]string{"ui"}); err == nil {
		t.Fatal("expected recursive UI rejection")
	}
	if err := validateFactoryCommand([]string{"rm", "-rf", "/"}); err == nil {
		t.Fatal("expected non-factory command rejection")
	}
}

func TestCommandResultsUseDedicatedConsoleAndApprovalIDsRender(t *testing.T) {
	base := newModel(nil, "Factory AI", "Test")
	updated, _ := base.Update(commandResultMsg{command: "factory workspace list", output: "smoke"})
	current := updated.(model)
	if current.err != nil || !strings.Contains(current.commandOutput, "smoke") {
		t.Fatal("command output was not routed to console")
	}
	item := objective{ID: "o", Objective: "Ship", Status: "approval_required", Repository: "https://github.com/acme/app.git"}
	item.Approval = &struct {
		ApprovalID string `json:"approvalId"`
		Status     string `json:"status"`
		Policy     string `json:"policy"`
		Reason     string `json:"reason"`
	}{ApprovalID: "approval-build", Status: "approval_required", Policy: "new_dependencies", Reason: "Review dependency"}
	current.dashboard.Objectives = []objective{item}
	current.workspaces = []workspace{{Name: "app", Repository: "acme/app"}}
	current.selectedWorkspace = "app"
	if rendered := current.objectives(); !strings.Contains(rendered, "approval-build") {
		t.Fatalf("approval ID missing from %q", rendered)
	}
}

func TestCommandFailureStaysInConsoleInsteadOfGlobalPageError(t *testing.T) {
	base := newModel(nil, "Factory AI", "Test")
	updated, _ := base.Update(commandResultMsg{command: "factory wrong", output: "unknown command", err: fmt.Errorf("exit 2")})
	current := updated.(model)
	if current.err != nil {
		t.Fatal("command error leaked into global page state")
	}
	if !strings.Contains(current.commandOutput, "unknown command") {
		t.Fatal("command error missing from console")
	}
}

func TestNavigationIsWorkspaceFirstAndOperationalViewsAreConsolidated(t *testing.T) {
	expected := []string{"Dashboard", "Objectives", "Agents", "Settings"}
	if len(tabs) != len(expected) {
		t.Fatalf("tabs are not consolidated: %#v", tabs)
	}
	for index := range expected {
		if tabs[index] != expected[index] {
			t.Fatalf("tabs are not consolidated: %#v", tabs)
		}
	}
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "app", Repository: "acme/app"}}
	current.selectedWorkspace = "app"
	current.dashboard.Objectives = []objective{{ID: "a", Repository: "https://github.com/acme/app.git"}, {ID: "b", Repository: "https://github.com/acme/other.git"}}
	visible := current.visibleObjectives()
	if len(visible) != 1 || visible[0].ID != "a" {
		t.Fatalf("workspace scope failed: %#v", visible)
	}
}

func TestWorkspaceSelectionSurvivesRefreshAndScopesShortcuts(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "alpha"}, {Name: "beta"}}
	current.selectedWorkspace = "beta"
	updated, _ := current.Update(snapshotMsg{workspaces: []workspace{{Name: "beta"}, {Name: "alpha"}}})
	current = updated.(model)
	if current.selectedWorkspace != "beta" {
		t.Fatalf("selection changed to %q", current.selectedWorkspace)
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	current = updated.(model)
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.editor.Value() != "submit beta " {
		t.Fatalf("shortcut ignored workspace: %q", current.editor.Value())
	}
}

func TestDashboardCountsAndConsoleAreScopedAndScrollable(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "app", Repository: "acme/app"}}
	current.selectedWorkspace = "app"
	current.dashboard.Objectives = []objective{{Repository: "https://github.com/acme/app.git", Status: "complete"}, {Repository: "https://github.com/acme/other.git", Status: "failed"}}
	rendered := current.overview()
	if !strings.Contains(rendered, "complete 1") || strings.Contains(rendered, "failed 1") {
		t.Fatalf("dashboard counts are not scoped: %q", rendered)
	}
	updated, _ := current.Update(commandResultMsg{command: "factory --help", output: strings.Repeat("line\n", 12)})
	current = updated.(model)
	current.content.Height = 4
	current.syncViewport()
	current.content.GotoBottom()
	before := current.content.YOffset
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	current = updated.(model)
	if current.content.YOffset >= before {
		t.Fatal("console did not scroll upward")
	}
}

func TestLargeWorkspaceCatalogCannotHideCommandLine(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 120, 35
	current.selectedWorkspace = "workspace-50"
	current.commandOutput = strings.Repeat("output\n", 50)
	for index := 0; index < 100; index++ {
		current.workspaces = append(current.workspaces, workspace{Name: fmt.Sprintf("workspace-%d", index), Repository: fmt.Sprintf("acme/repo-%d", index)})
	}
	current.resize()
	current.syncViewport()
	rendered := current.View()
	if lipgloss.Height(rendered) > current.height {
		t.Fatalf("rendered height %d exceeds terminal %d", lipgloss.Height(rendered), current.height)
	}
	if !strings.Contains(rendered, "Factory command") {
		t.Fatal("command line disappeared")
	}
}

func TestInterfaceFitsNarrowTerminalsAndPalette(t *testing.T) {
	for _, size := range [][2]int{{80, 24}, {40, 15}} {
		current := newModel(nil, "Factory AI with a very long name", "Test")
		current.width, current.height = size[0], size[1]
		current.resize()
		current.syncViewport()
		for _, palette := range []bool{false, true} {
			current.showPalette = palette
			rendered := current.View()
			if lipgloss.Width(rendered) > current.width || lipgloss.Height(rendered) > current.height {
				t.Fatalf("rendered %dx%d exceeds terminal %dx%d (palette=%v editor=%dx%d content=%dx%d)", lipgloss.Width(rendered), lipgloss.Height(rendered), current.width, current.height, palette, lipgloss.Width(current.editor.View()), lipgloss.Height(current.editor.View()), lipgloss.Width(current.content.View()), lipgloss.Height(current.content.View()))
			}
		}
	}
}

func TestGlobalQuitWorksInsidePalette(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.showPalette = true
	_, command := current.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if command == nil {
		t.Fatal("ctrl+c was swallowed by command palette")
	}
	if _, ok := command().(tea.QuitMsg); !ok {
		t.Fatal("ctrl+c did not issue quit")
	}
}

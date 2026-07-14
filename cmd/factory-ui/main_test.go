package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func TestCleanRemovesTerminalControlSequences(t *testing.T) {
	value := clean("safe\x1b]52;c;clipboard\x07\x1b[31mred\x1b[0m\x00")
	if value != "safered" || strings.ContainsRune(value, '\x1b') {
		t.Fatalf("unexpected sanitized value %q", value)
	}
}

func TestOperatorSnapshotCacheProvidesImmediateWarmState(t *testing.T) {
	t.Setenv("FACTORY_UI_CACHE_FILE", filepath.Join(t.TempDir(), "snapshot.json"))
	message := snapshotMsg{workspaces: []workspace{{Name: "app", Repository: "acme/app"}}}
	message.dashboard.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	writeOperatorCache("accountone", message)
	cached, ok := readOperatorCache("accountone")
	if !ok || len(cached.workspaces) != 1 || cached.workspaces[0].Name != "app" {
		t.Fatalf("warm cache did not round-trip: %#v", cached)
	}
	if _, ok := readOperatorCache("accounttwo"); ok {
		t.Fatal("operator cache leaked across storage accounts")
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

func TestEditorShowsAndAcceptsCommandCompletions(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 100, 30
	current.resize()
	for _, character := range "work" {
		updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{character}})
		current = updated.(model)
	}
	if rendered := current.View(); !strings.Contains(rendered, "workspace list") {
		t.Fatalf("matching command completion is not visible: %q", rendered)
	}
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyTab})
	current = updated.(model)
	if current.editor.Value() != "workspace list" {
		t.Fatalf("tab did not accept completion: %q", current.editor.Value())
	}
}

func TestEditorCompletesWorkspaceArguments(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "alpha"}, {Name: "beta"}}
	current.width, current.height = 100, 30
	current.editor.SetValue("submit b")
	current.resize()
	if rendered := current.View(); !strings.Contains(rendered, "submit beta") {
		t.Fatalf("workspace completion is not visible: %q", rendered)
	}
	updated, command := current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if command != nil || current.editor.Value() != "submit beta " {
		t.Fatalf("enter did not accept workspace completion: %q", current.editor.Value())
	}
}

func TestWorkspaceCanBeSelectedFromDesktopPicker(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 100, 30
	current.workspaces = []workspace{{Name: "alpha"}, {Name: "beta"}}
	current.selectedWorkspace = "alpha"
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	current = updated.(model)
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyDown})
	current = updated.(model)
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.selectedWorkspace != "beta" {
		t.Fatalf("workspace picker selected %q", current.selectedWorkspace)
	}
}

func TestWorkspacePickerScrollsWithoutExceedingTerminal(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 100, 20
	for index := 0; index < 10; index++ {
		current.workspaces = append(current.workspaces, workspace{Name: fmt.Sprintf("workspace-%d", index)})
	}
	current.selectedWorkspace = "workspace-7"
	current.resize()
	current.syncViewport()
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	current = updated.(model)
	if rendered := current.View(); lipgloss.Height(rendered) > current.height {
		t.Fatalf("workspace picker exceeds terminal: %d > %d", lipgloss.Height(rendered), current.height)
	}
	for range 3 {
		updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyUp})
		current = updated.(model)
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.selectedWorkspace != "workspace-4" {
		t.Fatalf("scrolled picker selected wrong workspace: %q", current.selectedWorkspace)
	}
}

func TestPaletteBlocksMouseAndNarrowLayoutCannotFocusHiddenSidebar(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 100, 30
	current.workspaces = []workspace{{Name: "alpha"}, {Name: "beta"}}
	current.selectedWorkspace = "alpha"
	current.showPalette = true
	updated, _ := current.Update(tea.MouseMsg{X: 75, Y: 5, Button: tea.MouseButtonLeft, Action: tea.MouseActionPress})
	current = updated.(model)
	if current.selectedWorkspace != "alpha" {
		t.Fatalf("palette leaked mouse event to workspace: %q", current.selectedWorkspace)
	}
	current.showPalette = false
	current.width = 80
	current.resize()
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	current = updated.(model)
	if current.modal != "workspaces" || current.editor.Focused() {
		t.Fatal("narrow workspace picker did not capture modal focus")
	}
}

func TestTabsAndAgentsCanBeClickedForDetailedActivity(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 100, 30
	current.workspaces = []workspace{{Name: "app", Repository: "acme/app"}}
	current.selectedWorkspace = "app"
	first := task{ID: "first", Role: "builder", Title: "First agent", Model: "model-a", State: "running"}
	second := task{ID: "second", Role: "tester", Title: "Second agent", Model: "model-b", State: "failed", Retries: 2, LastError: "tests failed"}
	second.Activity = &activity{Type: "tool", Tool: "shell", Phase: "running tests", OccurredAt: "now", RetryCount: 2, LastError: "exit 1"}
	current.dashboard.Objectives = []objective{{ID: "objective", Objective: "Ship it", Repository: "acme/app", Tasks: []task{first, second}}}
	current.ensureSelection()
	current.resize()
	current.syncViewport()
	updated, _ := current.Update(tea.MouseMsg{X: 75, Y: current.sidebarAgentStartY() + 2, Button: tea.MouseButtonLeft, Action: tea.MouseActionPress})
	current = updated.(model)
	rendered := current.agents()
	for _, expected := range []string{"SELECTED AGENT", "Second agent", "running tests", "shell", "tests failed"} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("agent detail missing %q: %q", expected, rendered)
		}
	}
}

func TestSessionStreamShowsSelectedAgentTimelineChronologically(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "app", Repository: "acme/app"}}
	current.selectedWorkspace = "app"
	current.selectedObjectiveID = "objective"
	current.selectedAgentID = "builder"
	current.dashboard.Objectives = []objective{{
		ID: "objective", Objective: "Ship it", Repository: "acme/app", Status: "running",
		Tasks: []task{{ID: "builder", Role: "builder", Title: "Build feature", State: "running", Events: []activity{
			{Type: "tool.completed", Tool: "test", Phase: "testing", OccurredAt: "2026-07-14T10:02:00Z"},
			{Type: "agent.started", Phase: "starting", OccurredAt: "2026-07-14T10:00:00Z"},
		}}},
	}}
	rendered := current.sessionStream()
	if strings.Index(rendered, "agent.started") > strings.Index(rendered, "tool.completed") {
		t.Fatalf("activity timeline is not chronological: %q", rendered)
	}
	for _, expected := range []string{"Build feature", "starting", "testing", "test"} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("session stream missing %q: %q", expected, rendered)
		}
	}
}

func TestSelectedAgentCanSwitchBetweenActivityAndCodeDiff(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "app", Repository: "acme/app"}}
	current.selectedWorkspace = "app"
	current.selectedObjectiveID = "objective"
	current.selectedAgentID = "builder"
	current.dashboard.Objectives = []objective{{ID: "objective", Objective: "Ship", Repository: "acme/app", Tasks: []task{{ID: "builder", Role: "builder", Title: "Build", State: "running"}}}}
	updated, command := current.Update(tea.KeyMsg{Type: tea.KeyCtrlD})
	current = updated.(model)
	if command == nil || current.agentView != "diff" || !current.agentPatchLoading {
		t.Fatal("ctrl+d did not start agent diff retrieval")
	}
	updated, _ = current.Update(agentDiffMsg{objectiveID: "objective", taskID: "builder", requestID: current.agentDiffRequest, patch: "diff --git a/app.go b/app.go\n+code", source: "working-tree", status: "M app.go"})
	current = updated.(model)
	if rendered := current.sessionStream(); !strings.Contains(rendered, "CODE DIFF") || !strings.Contains(rendered, "+code") {
		t.Fatalf("agent diff is not visible: %q", rendered)
	}
	updated, command = current.Update(tea.KeyMsg{Type: tea.KeyCtrlY})
	current = updated.(model)
	if command == nil {
		t.Fatal("ctrl+y did not create a clipboard command")
	}
	updated, _ = current.Update(clipboardMsg{})
	if updated.(model).notice != "Agent code copied to clipboard" {
		t.Fatal("clipboard success was not visible")
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyCtrlA})
	current = updated.(model)
	if current.agentView != "activity" {
		t.Fatal("ctrl+a did not restore activity view")
	}
}

func TestOpenCodeStylePickersWorkWhenSidebarsAreHidden(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 80, 24
	current.workspaces = []workspace{{Name: "alpha"}, {Name: "beta"}}
	current.selectedWorkspace = "alpha"
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	current = updated.(model)
	if !strings.Contains(current.View(), "Select workspace") {
		t.Fatal("workspace picker did not open")
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyDown})
	current = updated.(model)
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.selectedWorkspace != "beta" {
		t.Fatalf("workspace picker selected %q", current.selectedWorkspace)
	}
}

func TestWorkspacePickerCanStartWorkspaceImport(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 80, 24
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	current = updated.(model)
	if rendered := current.View(); !strings.Contains(rendered, "Add workspace") {
		t.Fatalf("workspace picker has no add action: %q", rendered)
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.modal != "" || current.editor.Value() != "workspace import " || !current.editor.Focused() {
		t.Fatalf("add workspace did not focus import editor: modal=%q value=%q", current.modal, current.editor.Value())
	}
}

func TestWorkspacePickerAddShortcutWorksWithExistingWorkspaces(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.workspaces = []workspace{{Name: "alpha"}, {Name: "beta"}}
	current.selectedWorkspace = "alpha"
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	current = updated.(model)
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	current = updated.(model)
	if current.editor.Value() != "workspace import " || current.modal != "" {
		t.Fatalf("workspace add shortcut failed: %q", current.editor.Value())
	}
}

func TestOpenPickerSelectionSurvivesSnapshotReordering(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 80, 24
	current.workspaces = []workspace{{Name: "alpha"}, {Name: "beta"}}
	current.selectedWorkspace = "alpha"
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlW})
	current = updated.(model)
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyDown})
	current = updated.(model)
	updated, _ = current.Update(snapshotMsg{workspaces: []workspace{{Name: "beta"}, {Name: "alpha"}}})
	current = updated.(model)
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.selectedWorkspace != "beta" {
		t.Fatalf("refresh changed open picker selection to %q", current.selectedWorkspace)
	}
}

func TestAgentPickerKeepsLargeAgentTeamsSelectable(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 100, 20
	current.workspaces = []workspace{{Name: "app", Repository: "acme/app"}}
	current.selectedWorkspace = "app"
	item := objective{ID: "objective", Repository: "acme/app"}
	for index := 0; index < 20; index++ {
		item.Tasks = append(item.Tasks, task{ID: fmt.Sprint(index), Role: "builder", Title: fmt.Sprintf("Agent %d", index), State: "running"})
	}
	current.dashboard.Objectives = []objective{item}
	current.ensureSelection()
	current.resize()
	current.syncViewport()
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyCtrlG})
	current = updated.(model)
	for range 15 {
		updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyDown})
		current = updated.(model)
	}
	if rendered := current.View(); lipgloss.Height(rendered) > current.height {
		t.Fatalf("agent picker exceeds terminal: %d > %d", lipgloss.Height(rendered), current.height)
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.selectedAgentID != "15" || !strings.Contains(current.sessionStream(), "Agent 15") {
		t.Fatalf("agent picker selected %q", current.selectedAgentID)
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
	expected := []string{"Session", "Objectives", "Dashboard", "Settings"}
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
	for _, size := range [][2]int{{80, 24}, {40, 15}, {20, 7}} {
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
		current.showPalette = false
		current.editor.SetValue("w")
		current.resize()
		rendered := current.View()
		if lipgloss.Width(rendered) > current.width || lipgloss.Height(rendered) > current.height {
			t.Fatalf("autocomplete rendered %dx%d in terminal %dx%d", lipgloss.Width(rendered), lipgloss.Height(rendered), current.width, current.height)
		}
		current.modal = "help"
		rendered = current.View()
		if lipgloss.Width(rendered) > current.width || lipgloss.Height(rendered) > current.height {
			t.Fatalf("help rendered %dx%d in terminal %dx%d", lipgloss.Width(rendered), lipgloss.Height(rendered), current.width, current.height)
		}
		current.modal = ""
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

func TestBeginnerHelpExplainsPrimaryWorkflow(t *testing.T) {
	current := newModel(nil, "Factory AI", "Test")
	current.width, current.height = 100, 30
	updated, _ := current.Update(tea.KeyMsg{Type: tea.KeyF1})
	current = updated.(model)
	rendered := current.View()
	for _, expected := range []string{"Getting started", "Ctrl+W", "Ctrl+S", "Ctrl+G", "Ctrl+D", "Ctrl+Y"} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("help is missing %q: %q", expected, rendered)
		}
	}
	updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if updated.(model).modal != "" {
		t.Fatal("escape did not close help")
	}
}

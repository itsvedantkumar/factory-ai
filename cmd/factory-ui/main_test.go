package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
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
	updated, _ := (model{}).Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{':'}})
	current := updated.(model)
	if !current.commandMode {
		t.Fatal("expected command mode")
	}
	for _, character := range "workspace list" {
		updated, _ = current.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{character}})
		current = updated.(model)
	}
	if current.commandInput != "workspace list" {
		t.Fatalf("got %q", current.commandInput)
	}
	updated, command := current.Update(tea.KeyMsg{Type: tea.KeyEnter})
	current = updated.(model)
	if current.commandMode || command == nil {
		t.Fatal("expected executable native command")
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

func TestCommandResultsScrollIntoViewAndApprovalIDsRender(t *testing.T) {
	updated, _ := (model{}).Update(commandResultMsg{command: "factory workspace list", output: "smoke"})
	current := updated.(model)
	if current.scroll == 0 || !strings.Contains(current.commandOutput, "smoke") {
		t.Fatal("command output was not focused")
	}
	item := objective{ID: "o", Objective: "Ship", Status: "approval_required"}
	item.Approval = &struct {
		ApprovalID string `json:"approvalId"`
		Status     string `json:"status"`
		Policy     string `json:"policy"`
		Reason     string `json:"reason"`
	}{ApprovalID: "approval-build", Status: "approval_required", Policy: "new_dependencies", Reason: "Review dependency"}
	current.dashboard.Objectives = []objective{item}
	if rendered := current.objectives(); !strings.Contains(rendered, "approval-build") {
		t.Fatalf("approval ID missing from %q", rendered)
	}
}

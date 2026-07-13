package main

import (
	"strings"
	"testing"
)

func TestCleanRemovesTerminalControlSequences(t *testing.T) {
	value := clean("safe\x1b]52;c;clipboard\x07\x1b[31mred\x1b[0m\x00")
	if value != "safered" || strings.ContainsRune(value, '\x1b') {
		t.Fatalf("unexpected sanitized value %q", value)
	}
}

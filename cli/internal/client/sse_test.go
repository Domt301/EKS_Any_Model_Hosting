package client

import (
	"strings"
	"testing"
)

func collect(t *testing.T, raw string) [][2]string {
	t.Helper()
	var events [][2]string
	err := ParseSSE(strings.NewReader(raw), func(event, data string) (bool, error) {
		events = append(events, [2]string{event, data})
		return false, nil
	})
	if err != nil {
		t.Fatalf("ParseSSE error: %v", err)
	}
	return events
}

func TestParseSSE_TokenUsageDone(t *testing.T) {
	raw := "event: token\ndata: {\"text\":\"Hello\"}\n\n" +
		"event: token\ndata: {\"text\":\" world\"}\n\n" +
		"event: usage\ndata: {\"prompt_tokens\":3,\"completion_tokens\":2}\n\n" +
		"event: done\ndata: {}\n\n"
	events := collect(t, raw)
	if len(events) != 4 {
		t.Fatalf("got %d events, want 4: %v", len(events), events)
	}
	if events[0][0] != "token" || events[0][1] != `{"text":"Hello"}` {
		t.Errorf("first event = %v", events[0])
	}
	if events[3][0] != "done" {
		t.Errorf("last event = %v", events[3])
	}
}

func TestParseSSE_StopsOnCallback(t *testing.T) {
	raw := "event: token\ndata: {\"text\":\"a\"}\n\n" +
		"event: token\ndata: {\"text\":\"b\"}\n\n"
	count := 0
	err := ParseSSE(strings.NewReader(raw), func(event, data string) (bool, error) {
		count++
		return true, nil // stop after first frame
	})
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if count != 1 {
		t.Fatalf("callback invoked %d times, want 1", count)
	}
}

func TestParseSSE_CRLFAndComments(t *testing.T) {
	raw := ": heartbeat\r\n\r\n" +
		"event: token\r\ndata: {\"text\":\"x\"}\r\n\r\n" +
		"event: done\r\ndata: {}\r\n\r\n"
	events := collect(t, raw)
	if len(events) != 2 {
		t.Fatalf("got %d events, want 2 (comment ignored): %v", len(events), events)
	}
	if events[0][1] != `{"text":"x"}` {
		t.Errorf("event data = %q", events[0][1])
	}
}

func TestParseSSE_TrailingFrameNoBlankLine(t *testing.T) {
	raw := "event: token\ndata: {\"text\":\"tail\"}" // no terminating blank line
	events := collect(t, raw)
	if len(events) != 1 || events[0][1] != `{"text":"tail"}` {
		t.Fatalf("trailing frame not flushed: %v", events)
	}
}

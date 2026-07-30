package client

import (
	"bufio"
	"io"
	"strings"
)

// ParseSSE reads a Server-Sent Events stream and invokes onEvent once per frame
// (frames are separated by a blank line). onEvent returns (stop, err): a true
// stop or non-nil err ends parsing. A frame with no explicit `event:` is
// reported as "message". Comment lines (starting with ':') are ignored.
//
// This mirrors the SPA's SSE parser (spa/src/api/chat.ts) and tolerates both LF
// and CRLF line endings and a trailing frame with no terminating blank line.
func ParseSSE(r io.Reader, onEvent func(event, data string) (bool, error)) error {
	reader := bufio.NewReader(r)
	var event string
	var dataLines []string

	flush := func() (bool, error) {
		if event == "" && len(dataLines) == 0 {
			return false, nil
		}
		ev := event
		if ev == "" {
			ev = "message"
		}
		data := strings.Join(dataLines, "\n")
		event = ""
		dataLines = nil
		return onEvent(ev, data)
	}

	for {
		line, readErr := reader.ReadString('\n')
		trimmed := strings.TrimRight(line, "\r\n")

		switch {
		case trimmed == "":
			// Blank line: only a frame boundary if we have accumulated content.
			// (Avoids treating the final newline of a frame as an empty frame.)
			if event != "" || len(dataLines) > 0 {
				stop, err := flush()
				if err != nil {
					return err
				}
				if stop {
					return nil
				}
			}
		case strings.HasPrefix(trimmed, ":"):
			// SSE comment / heartbeat — ignore.
		case strings.HasPrefix(trimmed, "event:"):
			event = strings.TrimSpace(trimmed[len("event:"):])
		case strings.HasPrefix(trimmed, "data:"):
			d := trimmed[len("data:"):]
			d = strings.TrimPrefix(d, " ")
			dataLines = append(dataLines, d)
		}

		if readErr != nil {
			if readErr == io.EOF {
				// Flush any trailing frame lacking a terminating blank line.
				if _, err := flush(); err != nil {
					return err
				}
				return nil
			}
			return readErr
		}
	}
}

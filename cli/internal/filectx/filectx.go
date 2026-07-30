// Package filectx pulls local files into a chat prompt as read-only context.
//
// It powers the CLI's lightweight "coding context": inline @file references in
// the REPL and the -f/--file flag for one-shot. It does NOT edit files or run
// commands — it only reads files and embeds their contents in the user message.
//
// The backend caps a single message at 8000 characters (MAX_CHARS_PER_MESSAGE
// in services/api/app/models.py) and injects its own system prompt, so file
// contents must ride inside the user turn and stay within a budget below 8000.
package filectx

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Default budgets, chosen to stay comfortably under the server's 8000-char
// per-message limit while leaving room for the user's own text.
const (
	DefaultMaxPerFile    = 6000
	DefaultMaxPerMessage = 7000
)

// Options tunes file reading and budgeting.
type Options struct {
	MaxPerFile    int    // per-file character cap (0 → DefaultMaxPerFile)
	MaxPerMessage int    // total injected-context cap (0 → DefaultMaxPerMessage)
	Root          string // base dir for relative paths (empty → cwd)
}

func (o Options) maxPerFile() int {
	if o.MaxPerFile > 0 {
		return o.MaxPerFile
	}
	return DefaultMaxPerFile
}

func (o Options) maxPerMessage() int {
	if o.MaxPerMessage > 0 {
		return o.MaxPerMessage
	}
	return DefaultMaxPerMessage
}

// @path or @"quoted path". The path stops at whitespace unless quoted.
var atRefRe = regexp.MustCompile(`@(?:"([^"]+)"|([^\s]+))`)

// ExpandInline scans text for @file references, reads the ones that resolve to
// real files, and returns a message = fenced file blocks + the original text.
// notes describes what was attached, truncated, or skipped (for display).
// If no references resolve, it returns (text, nil) unchanged.
func ExpandInline(text string, opt Options) (string, []string) {
	var paths []string
	seen := map[string]bool{}
	for _, m := range atRefRe.FindAllStringSubmatch(text, -1) {
		p := m[1]
		if p == "" {
			p = m[2]
		}
		// Strip trailing punctuation that commonly abuts an inline reference.
		p = strings.TrimRight(p, ".,;:)!?")
		if p == "" || seen[p] {
			continue
		}
		if !isReadableFile(resolve(opt.Root, p)) {
			continue // not a real file (e.g. @someone, a decorator) — leave as-is
		}
		seen[p] = true
		paths = append(paths, p)
	}
	if len(paths) == 0 {
		return text, nil
	}
	block, notes := buildBlock(paths, opt)
	if block == "" {
		return text, notes
	}
	return block + "\n" + text, notes
}

// Attach builds a message from explicit file paths (the -f flag) plus a prompt.
func Attach(paths []string, prompt string, opt Options) (string, []string) {
	var existing []string
	var notes []string
	for _, p := range paths {
		if !isReadableFile(resolve(opt.Root, p)) {
			notes = append(notes, fmt.Sprintf("skipped %s (not a readable file)", p))
			continue
		}
		existing = append(existing, p)
	}
	if len(existing) == 0 {
		return prompt, notes
	}
	block, bnotes := buildBlock(existing, opt)
	notes = append(notes, bnotes...)
	if block == "" {
		return prompt, notes
	}
	if strings.TrimSpace(prompt) == "" {
		return block, notes
	}
	return block + "\n" + prompt, notes
}

// buildBlock reads files within the message budget and formats them as fenced
// code blocks labelled with their paths.
func buildBlock(paths []string, opt Options) (string, []string) {
	var notes []string
	var b strings.Builder
	b.WriteString("Referenced files (read-only context):\n")

	budget := opt.maxPerMessage()
	used := 0
	attached := 0

	for _, p := range paths {
		if used >= budget {
			notes = append(notes, fmt.Sprintf("skipped %s (context budget reached)", p))
			continue
		}
		data, err := os.ReadFile(resolve(opt.Root, p))
		if err != nil {
			notes = append(notes, fmt.Sprintf("skipped %s (%v)", p, err))
			continue
		}
		content := string(data)
		limit := opt.maxPerFile()
		if remaining := budget - used; remaining < limit {
			limit = remaining
		}
		truncated := false
		if len(content) > limit {
			content = content[:limit]
			truncated = true
		}
		used += len(content)
		attached++

		fmt.Fprintf(&b, "\n// %s\n```%s\n%s\n```\n", p, langFor(p), content)
		if truncated {
			notes = append(notes, fmt.Sprintf("attached %s (truncated to %d chars to fit the message limit)", p, limit))
		} else {
			notes = append(notes, fmt.Sprintf("attached %s (%d chars)", p, len(content)))
		}
	}

	if attached == 0 {
		return "", notes
	}
	return b.String(), notes
}

func resolve(root, p string) string {
	if root == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(root, p)
}

func isReadableFile(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return false
	}
	return true
}

// langFor guesses a fenced-code language from a file extension (best effort).
func langFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".go":
		return "go"
	case ".py":
		return "python"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx":
		return "javascript"
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".sh", ".bash":
		return "bash"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".rb":
		return "ruby"
	case ".md":
		return "markdown"
	case ".html":
		return "html"
	case ".css":
		return "css"
	case ".sql":
		return "sql"
	case ".tf":
		return "hcl"
	case ".toml":
		return "toml"
	default:
		return ""
	}
}

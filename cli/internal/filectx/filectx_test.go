package filectx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestExpandInline_AttachesReferencedFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "main.go", "package main\nfunc main() {}\n")

	out, notes := ExpandInline("what does @main.go do?", Options{Root: dir})
	if !strings.Contains(out, "package main") {
		t.Fatalf("file content not injected:\n%s", out)
	}
	if !strings.Contains(out, "// main.go") {
		t.Errorf("missing path label:\n%s", out)
	}
	if !strings.Contains(out, "```go") {
		t.Errorf("missing go fence:\n%s", out)
	}
	if !strings.Contains(out, "what does @main.go do?") {
		t.Errorf("original text should be preserved:\n%s", out)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "attached main.go") {
		t.Errorf("notes = %v", notes)
	}
}

func TestExpandInline_QuotedPathWithSpaces(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "my file.txt", "hello world")
	out, _ := ExpandInline(`look at @"my file.txt" please`, Options{Root: dir})
	if !strings.Contains(out, "hello world") {
		t.Fatalf("quoted path not attached:\n%s", out)
	}
}

func TestExpandInline_UnresolvedTokenLeftAlone(t *testing.T) {
	out, notes := ExpandInline("email @someone and check @nope.go", Options{Root: t.TempDir()})
	if out != "email @someone and check @nope.go" {
		t.Errorf("text should be unchanged, got %q", out)
	}
	if notes != nil {
		t.Errorf("no notes expected, got %v", notes)
	}
}

func TestExpandInline_TrailingPunctuation(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.go", "package a")
	// The reference abuts a question mark.
	out, _ := ExpandInline("explain @a.go?", Options{Root: dir})
	if !strings.Contains(out, "package a") {
		t.Fatalf("file with trailing punct not attached:\n%s", out)
	}
}

func TestBuildBlock_TruncatesPerFile(t *testing.T) {
	dir := t.TempDir()
	// Filler char 'Z' does not appear anywhere else in the template/paths.
	big := strings.Repeat("Z", 10000)
	writeFile(t, dir, "big.dat", big)

	out, notes := ExpandInline("@big.dat", Options{Root: dir, MaxPerFile: 100, MaxPerMessage: 5000})
	if zs := strings.Count(out, "Z"); zs != 100 {
		t.Errorf("injected %d filler chars, want 100", zs)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "truncated") {
		t.Errorf("expected truncation note, got %v", notes)
	}
}

func TestBuildBlock_MessageBudgetSkipsLaterFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "a.txt", strings.Repeat("a", 90))
	writeFile(t, dir, "b.txt", strings.Repeat("b", 90))

	// Budget only fits the first file.
	out, notes := ExpandInline("@a.txt @b.txt", Options{Root: dir, MaxPerFile: 100, MaxPerMessage: 90})
	if !strings.Contains(out, strings.Repeat("a", 90)) {
		t.Error("first file should be attached")
	}
	if strings.Contains(out, strings.Repeat("b", 90)) {
		t.Error("second file should be skipped over budget")
	}
	joined := strings.Join(notes, " ")
	if !strings.Contains(joined, "budget") {
		t.Errorf("expected budget note, got %v", notes)
	}
}

func TestAttach_ExplicitFiles(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, dir, "x.py", "print('hi')")
	out, notes := Attach([]string{"x.py"}, "review this", Options{Root: dir})
	if !strings.Contains(out, "print('hi')") || !strings.Contains(out, "```python") {
		t.Fatalf("python file not attached correctly:\n%s", out)
	}
	if !strings.Contains(out, "review this") {
		t.Errorf("prompt should follow the block:\n%s", out)
	}
	if len(notes) == 0 {
		t.Error("expected an attach note")
	}
}

func TestAttach_MissingFileNoted(t *testing.T) {
	out, notes := Attach([]string{"does-not-exist.go"}, "hi", Options{Root: t.TempDir()})
	if out != "hi" {
		t.Errorf("prompt should be unchanged, got %q", out)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "skipped") {
		t.Errorf("expected skip note, got %v", notes)
	}
}

func TestLangFor(t *testing.T) {
	cases := map[string]string{
		"a.go": "go", "b.py": "python", "c.tsx": "typescript",
		"d.unknown": "", "e.yaml": "yaml", "f.tf": "hcl",
	}
	for name, want := range cases {
		if got := langFor(name); got != want {
			t.Errorf("langFor(%q) = %q, want %q", name, got, want)
		}
	}
}

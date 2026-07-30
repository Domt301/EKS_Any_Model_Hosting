// Package repl implements the interactive terminal chat loop and the one-shot
// (non-interactive) prompt path. It behaves like a minimal Claude Code: you
// type, the assistant streams back, and context is kept across turns via a
// server-side session id.
package repl

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/domt301/eks_any_model_hosting/cli/internal/auth"
	"github.com/domt301/eks_any_model_hosting/cli/internal/client"
	"github.com/domt301/eks_any_model_hosting/cli/internal/config"
	"github.com/domt301/eks_any_model_hosting/cli/internal/filectx"
)

// Deps are the collaborators the REPL needs. main wires these up.
type Deps struct {
	Client  *client.Client
	Creds   *config.Credentials
	HTTP    *http.Client
	Save    func(*config.Credentials) error
	Relogin func(ctx context.Context) error
	In      io.Reader
	Out     io.Writer
	AppURL  string
	// CtxOptions tunes @file / -f context expansion.
	CtxOptions filectx.Options
}

const (
	defaultTemperature     = 0.7
	defaultMaxOutputTokens = 512
)

// newSessionID returns a random id matching the server's ^[A-Za-z0-9_-]{1,128}$.
func newSessionID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "cli-session"
	}
	return "cli-" + hex.EncodeToString(b)
}

// Run drives the interactive REPL until EOF, Ctrl-D, or /exit.
func Run(ctx context.Context, d Deps) error {
	out := d.Out
	sessionID := newSessionID()
	var history []client.Message

	fmt.Fprintf(out, "Llama Pilot CLI — model %q on %s\n", d.Creds.ModelName, d.Creds.APIBaseURL)
	fmt.Fprintln(out, "Type your message and press Enter. Reference files with @path to add them as context.")
	fmt.Fprintln(out, "/help for commands, /exit to quit.")
	fmt.Fprintln(out)

	reader := bufio.NewReader(d.In)
	for {
		fmt.Fprint(out, "› ")
		line, err := reader.ReadString('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				fmt.Fprintln(out)
				return nil
			}
			return err
		}
		text := strings.TrimSpace(line)
		if text == "" {
			continue
		}

		if strings.HasPrefix(text, "/") {
			quit, herr := handleCommand(ctx, d, text, &sessionID, &history)
			if herr != nil {
				fmt.Fprintf(out, "  %s\n", herr)
			}
			if quit {
				return nil
			}
			continue
		}

		if err := turn(ctx, d, &history, sessionID, text); err != nil {
			fmt.Fprintf(out, "\n  %s\n", err)
		}
	}
}

// OneShot answers a single prompt and returns (used for `-p` / piped stdin).
// files are attached as read-only context (the -f/--file flag); inline @file
// references in the prompt are also expanded.
func OneShot(ctx context.Context, d Deps, prompt string, files []string) error {
	outgoing, notes := filectx.ExpandInline(strings.TrimSpace(prompt), d.CtxOptions)
	if len(files) > 0 {
		var n2 []string
		outgoing, n2 = filectx.Attach(files, outgoing, d.CtxOptions)
		notes = append(notes, n2...)
	}
	printNotes(d.Out, notes)
	_, err := stream(ctx, d, "", []client.Message{{Role: "user", Content: outgoing}})
	return err
}

// turn sends one user message and streams the assistant reply. Inline @file
// references are expanded into the outgoing message, but only the original
// (clean) text is kept in history — so file bytes are sent only in the turn
// they're referenced and multi-turn history stays small.
func turn(ctx context.Context, d Deps, history *[]client.Message, sessionID, userText string) error {
	outgoing, notes := filectx.ExpandInline(userText, d.CtxOptions)
	printNotes(d.Out, notes)

	msgs := append(append([]client.Message{}, (*history)...), client.Message{Role: "user", Content: outgoing})
	reply, err := stream(ctx, d, sessionID, msgs)
	if err != nil {
		return err
	}
	*history = append(*history,
		client.Message{Role: "user", Content: userText},
		client.Message{Role: "assistant", Content: reply},
	)
	return nil
}

// stream sends a message list and streams the assistant reply to Out, returning
// the full reply text.
func stream(ctx context.Context, d Deps, sessionID string, msgs []client.Message) (string, error) {
	token, err := freshToken(ctx, d)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	cb := client.StreamCallbacks{
		OnToken: func(t string) {
			fmt.Fprint(d.Out, t)
			b.WriteString(t)
		},
	}

	streamErr := d.Client.StreamChat(ctx, token, client.ChatRequest{
		Messages:        msgs,
		Temperature:     defaultTemperature,
		MaxOutputTokens: defaultMaxOutputTokens,
		SessionID:       sessionID,
	}, cb)

	fmt.Fprintln(d.Out)

	if streamErr != nil {
		if errors.Is(streamErr, client.ErrUnauthorized) {
			return "", errors.New("session expired — run /login to paste a fresh token")
		}
		return "", streamErr
	}
	return b.String(), nil
}

// printNotes writes context-expansion notes (attached/truncated/skipped files).
func printNotes(out io.Writer, notes []string) {
	for _, n := range notes {
		fmt.Fprintf(out, "  · %s\n", n)
	}
}

// freshToken refreshes the access token if needed and persists it.
func freshToken(ctx context.Context, d Deps) (string, error) {
	refreshed, err := auth.EnsureFresh(ctx, d.Creds, d.HTTP)
	if err != nil {
		if errors.Is(err, auth.ErrNoRefreshToken) {
			return "", errors.New("session expired — run /login to paste a fresh token")
		}
		return "", err
	}
	if refreshed && d.Save != nil {
		_ = d.Save(d.Creds)
	}
	return d.Creds.AccessToken, nil
}

// handleCommand processes a slash command. Returns quit=true to exit the REPL.
func handleCommand(ctx context.Context, d Deps, line string, sessionID *string, history *[]client.Message) (bool, error) {
	fields := strings.Fields(line)
	cmd := fields[0]
	out := d.Out

	switch cmd {
	case "/exit", "/quit", "/q":
		return true, nil

	case "/help", "/?":
		printHelp(out)
		return false, nil

	case "/clear", "/new":
		token, err := freshToken(ctx, d)
		if err == nil {
			_ = d.Client.ForgetSession(ctx, token, *sessionID)
		}
		*sessionID = newSessionID()
		*history = nil
		fmt.Fprintln(out, "  started a new conversation.")
		return false, nil

	case "/model":
		token, err := freshToken(ctx, d)
		if err != nil {
			return false, err
		}
		models, err := d.Client.Models(ctx, token)
		if err != nil {
			return false, err
		}
		fmt.Fprintf(out, "  model: %s\n", strings.Join(models, ", "))
		return false, nil

	case "/whoami":
		token, err := freshToken(ctx, d)
		if err != nil {
			return false, err
		}
		me, err := d.Client.Me(ctx, token)
		if err != nil {
			return false, err
		}
		fmt.Fprintf(out, "  sub=%s client_id=%s scope=%s\n", me.Sub, me.ClientID, me.Scope)
		return false, nil

	case "/login":
		if d.Relogin == nil {
			return false, errors.New("re-login is not available here")
		}
		if err := d.Relogin(ctx); err != nil {
			return false, err
		}
		*history = nil
		*sessionID = newSessionID()
		fmt.Fprintln(out, "  re-authenticated.")
		return false, nil

	case "/logout":
		if err := config.Clear(); err != nil {
			return false, err
		}
		fmt.Fprintln(out, "  logged out (credentials removed). Exiting.")
		return true, nil

	default:
		return false, fmt.Errorf("unknown command %q — try /help", cmd)
	}
}

func printHelp(out io.Writer) {
	fmt.Fprintln(out, "  Commands:")
	fmt.Fprintln(out, "    /help            show this help")
	fmt.Fprintln(out, "    @path            add a local file as read-only context (inline in your message)")
	fmt.Fprintln(out, "    /clear, /new     start a new conversation (clears server + local memory)")
	fmt.Fprintln(out, "    /model           show the served model")
	fmt.Fprintln(out, "    /whoami          show your Cognito identity")
	fmt.Fprintln(out, "    /login           paste a fresh connection token")
	fmt.Fprintln(out, "    /logout          remove stored credentials and exit")
	fmt.Fprintln(out, "    /exit, /quit     leave the CLI")
}

// Command llama-cli is a terminal client for the Self-Hosted Llama Pilot on
// EKS. It authenticates with Amazon Cognito using a connection token minted by
// the web app's "CLI access" page, then streams chat completions from the same
// FastAPI/API-Gateway endpoint the SPA uses.
//
// Usage:
//
//	llama-cli                 start the interactive chat REPL (logs in on first run)
//	llama-cli login           paste a connection token from the web app
//	llama-cli logout          remove stored credentials
//	llama-cli whoami          print your Cognito identity
//	llama-cli -p "question"   answer one prompt and exit (also reads piped stdin)
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/domt301/eks_any_model_hosting/cli/internal/auth"
	"github.com/domt301/eks_any_model_hosting/cli/internal/client"
	"github.com/domt301/eks_any_model_hosting/cli/internal/config"
	"github.com/domt301/eks_any_model_hosting/cli/internal/filectx"
	"github.com/domt301/eks_any_model_hosting/cli/internal/repl"
)

// version is overridable at build time: -ldflags "-X main.version=v1.2.3".
var version = "dev"

// stringsFlag collects a repeatable flag (e.g. -f a.go -f b.go).
type stringsFlag []string

func (s *stringsFlag) String() string { return strings.Join(*s, ",") }
func (s *stringsFlag) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func main() {
	printPrompt := flag.String("p", "", "answer a single prompt non-interactively and exit")
	appURL := flag.String("app-url", os.Getenv("LLAMA_PILOT_APP_URL"),
		"URL of the Llama Pilot web app, used in the login instructions")
	showVersion := flag.Bool("version", false, "print version and exit")
	var files stringsFlag
	flag.Var(&files, "f", "attach a local file as read-only context (repeatable)")
	flag.Var(&files, "file", "attach a local file as read-only context (repeatable)")
	flag.Parse()

	if *showVersion {
		fmt.Println("llama-cli", version)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := run(ctx, flag.Args(), *printPrompt, *appURL, files); err != nil {
		if errors.Is(err, context.Canceled) {
			return
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, printPrompt, appURL string, files []string) error {
	streamHTTP := &http.Client{} // no client timeout; the context controls cancellation
	authHTTP := &http.Client{Timeout: 30 * time.Second}
	in := os.Stdin
	out := os.Stdout

	subcommand := ""
	if len(args) > 0 {
		subcommand = args[0]
	}

	switch subcommand {
	case "login":
		creds, err := doLogin(appURL, in, out)
		if err != nil {
			return err
		}
		if err := config.Save(creds); err != nil {
			return err
		}
		fmt.Fprintln(out, "Saved. Run `llama-cli` to start chatting.")
		return nil

	case "logout":
		if err := config.Clear(); err != nil {
			return err
		}
		fmt.Fprintln(out, "Logged out — credentials removed.")
		return nil
	}

	// All remaining paths need credentials; log in on first use.
	creds, err := config.Load()
	if err != nil {
		return err
	}
	if creds == nil {
		fmt.Fprintln(out, "No saved credentials — let's log in.")
		creds, err = doLogin(appURL, in, out)
		if err != nil {
			return err
		}
		if err := config.Save(creds); err != nil {
			return err
		}
		fmt.Fprintln(out)
	}

	api := client.New(creds.APIBaseURL, streamHTTP)
	relogin := func(ctx context.Context) error {
		nc, err := doLogin(appURL, in, out)
		if err != nil {
			return err
		}
		if err := config.Save(nc); err != nil {
			return err
		}
		*creds = *nc
		api.BaseURL = strings.TrimRight(creds.APIBaseURL, "/")
		return nil
	}

	deps := repl.Deps{
		Client:     api,
		Creds:      creds,
		HTTP:       authHTTP,
		Save:       config.Save,
		Relogin:    relogin,
		In:         in,
		Out:        out,
		AppURL:     appURL,
		CtxOptions: filectx.Options{}, // defaults; Root empty → cwd-relative paths
	}

	switch subcommand {
	case "whoami":
		return whoami(ctx, deps)
	case "chat", "":
		// fall through to interactive / one-shot below
	default:
		return fmt.Errorf("unknown command %q (try: login, logout, whoami, chat)", subcommand)
	}

	// One-shot when there's a prompt (from -p or piped stdin). -f attaches files
	// to that prompt. A bare `-f` with no prompt in a terminal falls through to
	// the interactive REPL (use @file inline there).
	if prompt := oneShotPrompt(printPrompt, in); prompt != "" {
		return repl.OneShot(ctx, deps, prompt, files)
	}
	if len(files) > 0 {
		fmt.Fprintln(out, "note: -f attaches files to a one-shot prompt (add -p \"...\"). In the REPL, reference files inline with @path.")
	}

	return repl.Run(ctx, deps)
}

// oneShotPrompt returns a non-interactive prompt from -p or piped stdin, else "".
func oneShotPrompt(printPrompt string, in *os.File) string {
	if strings.TrimSpace(printPrompt) != "" {
		return printPrompt
	}
	if fi, err := in.Stat(); err == nil && (fi.Mode()&os.ModeCharDevice) == 0 {
		// stdin is a pipe/file, not a terminal — read it all as the prompt.
		data, _ := io.ReadAll(in)
		return strings.TrimSpace(string(data))
	}
	return ""
}

func whoami(ctx context.Context, d repl.Deps) error {
	refreshed, err := auth.EnsureFresh(ctx, d.Creds, d.HTTP)
	if err != nil {
		if errors.Is(err, auth.ErrNoRefreshToken) {
			return errors.New("session expired — run `llama-cli login` again")
		}
		return err
	}
	if refreshed {
		_ = config.Save(d.Creds)
	}
	me, err := d.Client.Me(ctx, d.Creds.AccessToken)
	if err != nil {
		if errors.Is(err, client.ErrUnauthorized) {
			return errors.New("unauthorized — run `llama-cli login` again")
		}
		return err
	}
	fmt.Fprintf(d.Out, "sub:       %s\nclient_id: %s\nscope:     %s\nmodel:     %s\nendpoint:  %s\n",
		me.Sub, me.ClientID, me.Scope, d.Creds.ModelName, d.Creds.APIBaseURL)
	return nil
}

// doLogin prints instructions, reads the pasted connection token, and decodes it.
func doLogin(appURL string, in io.Reader, out io.Writer) (*config.Credentials, error) {
	fmt.Fprintln(out, "Connect llama-cli to your Llama Pilot deployment:")
	if strings.TrimSpace(appURL) != "" {
		fmt.Fprintf(out, "  1. Open %s/#cli in your browser.\n", strings.TrimRight(appURL, "/"))
	} else {
		fmt.Fprintln(out, "  1. Open your Llama Pilot web app and click \"CLI access\"")
		fmt.Fprintln(out, "     (or visit <app-url>/#cli). Tip: set LLAMA_PILOT_APP_URL to skip this.")
	}
	fmt.Fprintln(out, "  2. Sign in with Cognito.")
	fmt.Fprintln(out, "  3. Copy the connection token shown on the page.")
	fmt.Fprint(out, "\nPaste the connection token and press Enter:\n> ")

	reader := bufio.NewReader(in)
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return nil, err
	}
	creds, err := auth.DecodeBundle(line)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(out, "Connected to %s (model %q).\n", creds.APIBaseURL, creds.ModelName)
	return creds, nil
}

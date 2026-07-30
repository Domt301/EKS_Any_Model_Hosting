# llama-cli

A terminal client for the **Self-Hosted Llama Pilot on EKS**. It streams chat
completions from the same FastAPI / API Gateway endpoint the web app uses, and
authenticates with the **same Amazon Cognito user pool** — no separate account,
no client secret.

It works like a minimal Claude Code: launch it, and you get an interactive
prompt that streams the model's reply token-by-token and remembers the
conversation across turns.

```
$ llama-cli
Llama Pilot CLI — model "llama-pilot" on https://abc123.execute-api.us-east-1.amazonaws.com
Type your message and press Enter. /help for commands, /exit to quit.

› write a haiku about self-hosting a model
Silicon whispers—
a llama grazes on-prem,
tokens drift like snow.
›
```

## How authentication works

The Cognito app client only allows the **Authorization Code + PKCE** flow via
the Hosted UI, and its redirect URLs are a fixed allow-list. Rather than run a
browser OAuth flow from the terminal, the CLI reuses the web app you already
deploy:

1. You open the web app's **CLI access** page and sign in normally (Cognito).
2. The page shows a **connection token** — a compact bundle containing the API
   endpoint, the Cognito details, and your tokens (access + refresh).
3. You paste that token into `llama-cli login`.

The CLI stores it and then **keeps your session alive on its own** by
refreshing the access token with Cognito (the same public-client
`refresh_token` grant the SPA uses), so you normally only paste once.

> **The connection token is a credential.** It contains a refresh token — treat
> it like a password. Don't commit it or share it. It is stored locally at
> `~/.config/llama-pilot/credentials.json` with `0600` permissions.

## Install

You need [Go](https://go.dev/dl/) 1.22+ to build from source.

### From source (this repo)

```bash
cd cli
make install          # installs `llama-cli` into $(go env GOPATH)/bin
# or, without make:
go install .
```

Make sure `$(go env GOPATH)/bin` is on your `PATH`.

### Build a local binary

```bash
cd cli
make build            # produces ./llama-cli
./llama-cli --version
```

### Cross-compiled release binaries

```bash
cd cli
make dist             # writes dist/llama-cli-<os>-<arch>[.exe]
```

Copy the binary for your platform somewhere on your `PATH` (e.g.
`/usr/local/bin/llama-cli`).

## Usage

### First-time login

```bash
llama-cli login
```

You'll be prompted to open the web app, sign in, and paste the connection token.
To have the CLI print the exact URL, tell it where your web app lives:

```bash
export LLAMA_PILOT_APP_URL=https://main.d123.amplifyapp.com
llama-cli login
# → "Open https://main.d123.amplifyapp.com/#cli in your browser."
```

(You can also pass `--app-url` per invocation.) If you don't set it, just open
your Llama Pilot web app and click **CLI access**, or visit `<app-url>/#cli`.

### Interactive chat

```bash
llama-cli               # starts the REPL (runs login automatically on first use)
```

In-REPL slash commands:

| Command          | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `/help`          | show commands                                                 |
| `/clear`, `/new` | start a new conversation (drops server + local memory)        |
| `/model`         | show the served model                                         |
| `/whoami`        | show your Cognito identity (`GET /api/v1/me`)                 |
| `/login`         | paste a fresh connection token                                |
| `/logout`        | remove stored credentials and exit                            |
| `/exit`, `/quit` | leave the CLI                                                 |

### One-shot / scripting

```bash
llama-cli -p "summarize the CAP theorem in two sentences"
echo "explain vLLM paged attention" | llama-cli
```

Both print a single streamed answer and exit — handy in pipelines.

### Other commands

```bash
llama-cli whoami        # print identity + endpoint, then exit
llama-cli logout        # forget stored credentials
llama-cli --version
```

## How it talks to the backend

- `POST /api/v1/chat/completions` (SSE stream) — the request body matches the
  server contract in `services/api/app/models.py`
  (`messages[{role,content}]`, `temperature`, `max_output_tokens`, `stream`,
  `session_id`). Only `user`/`assistant` roles are sent; the system prompt and
  model are enforced server-side.
- A per-session `session_id` enables the server's in-memory conversation window
  (`services/api/app/sessions.py`). `/clear` calls `DELETE /api/v1/sessions/{id}`.
- `GET /api/v1/me` and `GET /api/v1/models` back `/whoami` and `/model`.

### Streaming caveat (API Gateway)

The public edge is an API Gateway **HTTP API**, which buffers responses and caps
a request at ~**29 seconds** (see `docs/adr/ADR-005-api-gateway-https.md`). The
CLI parses the SSE stream identically whether tokens arrive incrementally or in
one buffered flush, but very long generations can be cut at the edge. The
server also clamps output to **512 tokens**, which comfortably fits the window.

## Local development

Run the whole suite:

```bash
cd cli
make            # fmt + vet + test + build
go test ./...   # tests only
```

You can exercise the REPL against a local FastAPI without Cognito by running the
API with `AUTH_DISABLED=true` (see `services/api/README.md`) and pasting a
hand-made bundle, or by pointing `--app-url` at a local SPA (`npm run dev` in
`spa/`, which serves the `#cli` page at `http://localhost:5173/#cli`).

## Project layout

```
cli/
  main.go                 subcommand dispatch, login prompt, one-shot vs REPL
  internal/config/        credential store (~/.config/llama-pilot/credentials.json)
  internal/auth/          connection-bundle decode + Cognito token refresh
  internal/client/        HTTP + SSE streaming client for the FastAPI backend
  internal/repl/          interactive chat loop and slash commands
  Makefile                build / test / cross-compile
```

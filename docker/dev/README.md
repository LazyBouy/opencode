# OpenCode dev stack (Docker)

Runs OpenCode, including the `/merge` feature and the iphi web UI, entirely in containers. Nothing is
installed on the host. All commands run from the repository root.

| Service  | What it runs                               | Host address                | Limits (default) |
| -------- | ------------------------------------------ | --------------------------- | ---------------- |
| `server` | `opencode serve` (API, sessions, `/merge`) | none: reached through `web` | 4 CPUs, 6 GB     |
| `web`    | the web UI (Vite) and the API, forwarded   | `http://127.0.0.1:4444`     | 2 CPUs, 3 GB     |
| `tools`  | one-off commands (typecheck, tests)        | on demand (`run --rm`)      | 4 CPUs, 6 GB     |
| `e2e`    | Playwright browser tests                   | on demand (`run --rm`)      | 4 CPUs, 6 GB     |

## Start

```sh
docker compose -f docker/dev/compose.yaml up -d --build server web
```

Open http://127.0.0.1:4444.

**One server.** The browser talks only to 4444: the `web` service serves the app and forwards every API
request (the event stream and the terminal's WebSocket included) to `server` inside Docker's network
(`packages/app/vite.dev-stack.config.ts`, run on Node from `/opt/node`, whose HTTP server lets the proxy
forward WebSockets). Settings → Servers lists that one server, `127.0.0.1:4444`. The API server's port
(4096) isn't published on the host; for a one-off call use `curl http://127.0.0.1:4444/global/health`.
A browser that saved `localhost:4096` as a server earlier keeps it in the list; remove it there.

**Your home folder is mounted into the server, at the same path** (`$HOME`, `/root` by default). This is
the production model: the agent reaches your files as Claude Code on the host does. Everything the server
keeps is in your home folder, as on the host:

- Global's folder and config: `~/.config/opencode`;
- OpenCode's data (sessions, provider credentials) and state: `~/.local/share/opencode`, `~/.local/state/opencode`;
- Claude Code's login and transcripts for `/merge claude`: `~/.claude` (`CLAUDE_CONFIG_DIR`);
- your projects, under `WORKSPACE` (default `/root/projects`), which must be inside your home folder.

They are one file system, so a project can move between Global and another namespace, and a move takes
merged agents' records of its sessions along (Claude Code's `~/.claude/projects/<folder>`), so those
sessions resume in the new place. The container runs as root: with a home folder that isn't root's, the
files it writes there are root's.

**A fresh stack opens onboarding** in the web UI: it asks for the working folder (default
`~/opencode-home`), where every namespace but Global lives, at `<working folder>/<namespace>` (OpenCode at
`<working folder>/opencode`), and makes OpenCode's default project in it (`<working folder>/opencode/opencode`
by default). It warns about a merged agent whose data is outside your home folder. This repository is never
added as a project; add it from **Operator → Projects** to work on it. Set `OPENCODE_WORKING_DIR` (below) to
skip onboarding. **Operator → Projects → Add project** makes a project at `<namespace folder>/<name>` (a git
repository by default, so it is its own project), or adds a folder that exists.

Connect a model provider for OpenCode's own agents under **Settings → Providers**.

### Isolated mode

For a stack that must not touch your home folder (a demo, CI, a second install), add
`compose.isolated.yaml`. The server then keeps its data in the named volumes `opencode-config`,
`opencode-data`, `opencode-state` and `claude-config`, and sees only `WORKSPACE`:

```sh
docker compose -f docker/dev/compose.yaml -f docker/dev/compose.isolated.yaml up -d --build server web
```

Global's folder is then another file system than the workspace: moving a project between Global and
another namespace is refused as crossing file systems (the move plan says so). Use the same two files for
every later command (`exec`, `down`).

The server runs from source through `serve.sh`, which gives it the version in
`packages/opencode/package.json`. Without it the version is `local`, and OpenCode Zen's free models
refuse the request ("OpenCode's free tier can only be used from within OpenCode").

## Live code changes

```sh
docker compose -f docker/dev/compose.yaml watch
```

Edits under `packages/app`, `ui`, `session-ui` and `sdk/js` hot-reload in the web UI. Edits to the
server packages (`opencode`, `core`, `schema`, `server`, `protocol`, `llm`, `plugin`) restart the
server. A `bun.lock` change rebuilds the image.

## Claude Code for `/merge claude`

The image includes Claude Code 2.1.123 (the version the merge adapter was verified against), in
`/opt/claude/bin`. It uses your `~/.claude`: if you are logged in on the host, it is logged in. Otherwise
log it in once (in isolated mode the login goes to the `claude-config` volume):

```sh
docker compose -f docker/dev/compose.yaml exec server claude
# run /login, follow the link, then /exit
```

Then in any session: `/merge claude`, `/merge status`, `/merge detach`. Its transcripts are in
`~/.claude/projects`, next to the host's.

## One-off commands

The `tools` service runs against the image's copy of the source, so rebuild after editing:

```sh
docker compose -f docker/dev/compose.yaml build
docker compose -f docker/dev/compose.yaml run --rm tools bun run --cwd packages/opencode typecheck
docker compose -f docker/dev/compose.yaml run --rm tools bun run --cwd packages/opencode test test/merge
```

Browser (Playwright) tests run in the `e2e` service: the Playwright image with Bun and the workspace,
limited to 4 CPUs and 6 GB, with 2 workers. They use the app's mock server, not the running stack:

```sh
docker compose -f docker/dev/compose.yaml --profile e2e build e2e
docker compose -f docker/dev/compose.yaml run --rm e2e npx playwright test e2e/operator e2e/regression e2e/smoke
```

## Messaging backends (optional)

Agent messaging (SPEC-0023) runs on SQLite and the server's memory by default. RabbitMQ (messages between projects'
inboxes) and Redis (the memory lane) are optional services behind the `messaging` profile, with resource limits and
data volumes (`rabbitmq-data`, `redis-data`; never pruned):

```sh
docker compose -f docker/dev/compose.yaml --profile messaging up -d rabbitmq redis
# The server uses them when given their addresses:
OPENCODE_OPERATOR_RABBITMQ_URL=amqp://opencode:opencode@rabbitmq:5672 \
OPENCODE_OPERATOR_REDIS_URL=redis://redis:6379 \
  docker compose -f docker/dev/compose.yaml up -d server web
# Tests against them (they're skipped without these):
docker compose -f docker/dev/compose.yaml run --rm \
  -e OPENCODE_TEST_RABBITMQ_URL=amqp://opencode:opencode@rabbitmq:5672 -e OPENCODE_TEST_REDIS_URL=redis://redis:6379 \
  tools bun run --cwd packages/opencode test test/operator/messaging-rabbitmq.test.ts
```

## Services on the host

The server reaches the host as `host.docker.internal` (`extra_hosts` in `compose.yaml`), for example a remote MCP
server or Activepieces' step tools at `http://host.docker.internal:3000/api/v1/opencode/mcp`. The host service has to
listen on all interfaces, not only `127.0.0.1`.

## Merging upstream releases

`script/fork/upstream-merge.sh` merges upstream OpenCode and runs the fork's checks in these
containers. See `FORK.md`.

## Settings

Override in the shell or in `docker/dev/.env`:

| Variable                                                                                                             | Default                    | Purpose                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `HOME`                                                                                                               | your shell's, else `/root` | home folder mounted into the server, same path                                                                                     |
| `WORKSPACE`                                                                                                          | `/root/projects`           | where projects live (inside `HOME`); a workspace root with `~/opencode-home`; isolated mode mounts it alone                        |
| `OPENCODE_WEB_PORT`                                                                                                  | `4444`                     | web UI port on the host (127.0.0.1 only)                                                                                           |
| `OPENCODE_WEB_HOST`                                                                                                  | `127.0.0.1`                | the address you open the web UI at: the app's one server is `http://<it>:<OPENCODE_WEB_PORT>`                                      |
| `OPENCODE_SERVER_PASSWORD`                                                                                           | unset                      | require basic auth on the API                                                                                                      |
| `OPENCODE_WORKING_DIR`                                                                                               | unset                      | the working folder, set on first start instead of onboarding: every namespace but Global lives in it (OpenCode at `<it>/opencode`) |
| `SERVER_CPUS` / `SERVER_MEMORY`, `WEB_CPUS` / `WEB_MEMORY`, `TOOLS_CPUS` / `TOOLS_MEMORY`, `E2E_CPUS` / `E2E_MEMORY` | see table                  | resource limits                                                                                                                    |
| `E2E_WORKERS`                                                                                                        | `2`                        | Playwright workers                                                                                                                 |

## Stop

```sh
docker compose -f docker/dev/compose.yaml down        # your home folder keeps everything
docker compose -f docker/dev/compose.yaml -f docker/dev/compose.isolated.yaml down -v   # isolated: also delete its volumes
```

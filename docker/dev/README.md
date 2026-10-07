# OpenCode dev stack (Docker)

Runs OpenCode, including the `/merge` feature and the iphi web UI, entirely in containers. Nothing is
installed on the host. All commands run from the repository root.

| Service  | What it runs                               | Host address            | Limits (default) |
| -------- | ------------------------------------------ | ----------------------- | ---------------- |
| `server` | `opencode serve` (API, sessions, `/merge`) | `http://127.0.0.1:4096` | 4 CPUs, 6 GB     |
| `web`    | web UI dev server (Vite)                   | `http://127.0.0.1:4444` | 2 CPUs, 3 GB     |
| `tools`  | one-off commands (typecheck, tests)        | on demand (`run --rm`)  | 4 CPUs, 6 GB     |
| `e2e`    | Playwright browser tests                   | on demand (`run --rm`)  | 4 CPUs, 6 GB     |

## Start

```sh
docker compose -f docker/dev/compose.yaml up -d --build server web
```

Open http://127.0.0.1:4444. Add a project with **Add project**; the server sees your projects at the
same paths as the host (default `/root/projects`, change with `WORKSPACE`). **Operator → Projects →
Add project** browses that folder and can create new sub-folders there (as git repositories, so each is
its own project). They are written to the mounted host folder, so they persist.

Connect a model provider for OpenCode's own agents under **Settings → Providers**. Credentials are kept
in the `opencode-data` volume.

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

The image includes Claude Code 2.1.123 (the version the merge adapter was verified against). Log it in
once. The login is stored in the `claude-config` volume, not in your host `~/.claude`:

```sh
docker compose -f docker/dev/compose.yaml exec server claude
# run /login, follow the link, then /exit
```

Then in any session: `/merge claude`, `/merge status`, `/merge detach`. Claude transcripts created
from the container live in the same volume.

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

## Merging upstream releases

`script/fork/upstream-merge.sh` merges upstream OpenCode and runs the fork's checks in these
containers. See `FORK.md`.

## Settings

Override in the shell or in `docker/dev/.env`:

| Variable                                                                                                             | Default          | Purpose                                        |
| -------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------- |
| `WORKSPACE`                                                                                                          | `/root/projects` | host folder mounted into the server, same path |
| `OPENCODE_SERVER_PORT`                                                                                               | `4096`           | API port on the host (127.0.0.1 only)          |
| `OPENCODE_WEB_PORT`                                                                                                  | `4444`           | web UI port on the host (127.0.0.1 only)       |
| `OPENCODE_SERVER_PASSWORD`                                                                                           | unset            | require basic auth on the API                  |
| `SERVER_CPUS` / `SERVER_MEMORY`, `WEB_CPUS` / `WEB_MEMORY`, `TOOLS_CPUS` / `TOOLS_MEMORY`, `E2E_CPUS` / `E2E_MEMORY` | see table        | resource limits                                |
| `E2E_WORKERS`                                                                                                        | `2`              | Playwright workers                             |

## Stop

```sh
docker compose -f docker/dev/compose.yaml down        # keep sessions, settings and the Claude login
docker compose -f docker/dev/compose.yaml down -v     # also delete those volumes
```

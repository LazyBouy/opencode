# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OpenCode is an open source AI coding agent: a Bun + Turbo TypeScript monorepo built on Effect v4 (beta, patched under `patches/`) with SolidJS frontends.

Read these alongside this file:

- `FORK.md` describes this fork: its additions (`/merge`, the iphi theme, the operator console), the fork-only paths new work must use, the aggregators that register fork routes, config keys, pages and strings, the list of upstream files the fork edits, and how to merge upstream releases.

- `AGENTS.md` (root) holds the style guide, import rules, commit/branch conventions, and V2 Session invariants. Packages and some subdirectories have their own `AGENTS.md` with stricter local rules: `packages/opencode/test/`, `packages/opencode/test/server/`, `packages/opencode/src/session/llm/`, `packages/opencode/src/server/routes/instance/httpapi/`, `packages/core/src/tool/`, `packages/llm/`, `packages/schema/`, `packages/app/` (and `app/e2e/`), `packages/ui/`, `packages/session-ui/`, `packages/desktop/`.
- `CONTEXT.md` is the domain glossary for the Session runtime (System Context, Context Epoch, Admitted Prompt, Session Drain, ...) and the client-contract design. Use its terms.
- `specs/` holds design docs, especially `specs/v2/*` (session, tools, config, provider-model) and `specs/tui-package.md`.

## Commands

**In this checkout, nothing is installed on the host.** Bun, dependencies, builds, tests, dev servers and browser tests all run in Docker with resource limits through the stack in [docker/dev/](docker/dev/README.md): `server` (API on 4096), `web` (web UI on 4444), and `tools` for one-off commands. Run the `bun …` commands below inside that stack, for example `docker compose -f docker/dev/compose.yaml run --rm tools bun run --cwd packages/opencode test test/merge`. Rebuild the image first so `tools` sees source edits.

Bun version is pinned in the root `packageManager`. The pre-push hook checks it and runs `bun typecheck`. `bunfig.toml` uses exact installs and refuses package versions published less than 3 days ago, so a just-released dependency may fail to resolve.

```bash
bun install
bun dev                      # run the opencode CLI/TUI against packages/opencode
bun dev <dir>                # ...against another directory (bun dev . = repo root)
bun dev serve --port 4096    # headless API server
bun dev spawn                # TUI without the worker-thread server (use for server breakpoints)
bun typecheck                # all packages via turbo (tsgo); prefer per-package, see below
bun lint                     # oxlint (type-aware), from root
./script/format.ts           # prettier: no semicolons, printWidth 120
```

The TUI is interactive. Don't run it as a blocking foreground command. Start it in tmux (`tmux new-session -d -s opencode-dev 'bun dev'`), read it with `tmux capture-pane -pt opencode-dev`, and kill the session when done.

Web UI development: from `packages/opencode`, run `bun run ./src/index.ts serve --port 4096`; from `packages/app`, run `bun dev -- --port 4444`. Then open `http://localhost:4444`. `opencode web` proxies the hosted app, so local UI changes don't appear there.

### Tests and typecheck (always from a package directory)

```bash
cd packages/opencode         # or core, llm, tui, client, sdk-next, ...
bun typecheck
bun run test                             # whole package (script adds --timeout/--only-failures)
bun run test test/session/foo.test.ts    # one file; extra args are appended to the script
bun run test test/foo.test.ts -t "name"  # one test by name pattern
```

Running tests from the repo root is blocked on purpose. Use `bun run test` rather than bare `bun test` in `opencode`, `core`, and `llm`: `bunfig.toml` can't set the 30s timeout, so the scripts pass it. Test preloads isolate state: `core` uses an in-memory DB and a fixture models.dev catalog with fetching disabled, and `opencode` points XDG dirs at a temp directory.

- `packages/app`: `bun run test:unit`, `bun run test:browser`, `bun run test:e2e` (Playwright).
- Recorded provider tests (`packages/llm`, `packages/core`, via `@opencode-ai/http-recorder`) replay cassettes from `test/fixtures/recordings` by default. To re-record, set `RECORD=true` with the provider API keys, and narrow the run with `RECORDED_PREFIX`, `RECORDED_PROVIDER`, `RECORDED_TAGS`, or `RECORDED_TEST`. Don't re-record whole files.

### Code generation (CI checks these)

- **Current client** (`packages/client/src/generated*`): after changing a Protocol or Server `HttpApi`, run `bun run generate` in `packages/client`. CI runs `bun run check:generated` there and `bun run test:httpapi` in `packages/opencode` (HttpApi coverage, auth, and effect exerciser gates).
- **Legacy JS SDK and `packages/sdk/openapi.json`**: run `./script/generate.ts` from the repo root. It builds `packages/sdk/js`, dumps `bun dev generate` to the OpenAPI file, and formats.
- **Database migrations**: the Drizzle schema lives in `packages/core/src/**/*.sql.ts`. From `packages/core`, run `bun run migration --name <name>` to generate migrations plus `migration.gen.ts`/`schema.gen.ts`, and `bun run migration --check` to verify they are current.
- **Standalone binary**: `./packages/opencode/script/build.ts --single` writes `packages/opencode/dist/opencode-<platform>/bin/opencode`.

## Architecture

### Package layering

The dependency direction is enforced: Schema → Core and Protocol → Server.

- `packages/schema` (`@opencode-ai/schema`): browser-safe wire and storage contracts (Effect Schema). No runtime behavior. Current contracts are unversioned; legacy ones are named `*V1`.
- `packages/protocol`: the public `/api` `HttpApi` groups (paths, payloads, errors, cursors, streams) built from Schema. `makeApi`/`makeDefaultApi` take the Location middleware keys as parameters.
- `packages/core` (`@opencode-ai/core`): the V2 domain runtime as Effect services. It holds the SQLite/Drizzle database and migrations, Locations, Sessions (durable `session_input` inbox, `SessionExecution`, `run-coordinator`, `runner/`, event projectors), the tool registry, permissions, catalog/providers, system context, PTY, and plugins. `src/v1/` keeps legacy contracts during migration.
- `packages/server`: the concrete handlers for Protocol groups plus Location/session-location middleware. It imports Core and Protocol.
- `packages/client`: generated Promise client (root export, zero Effect) and Effect client (`/effect`), compiled from Server's `HttpApi` by `packages/httpapi-codegen`. It may depend only on Schema and Protocol.
- `packages/sdk-next`: "Embedded OpenCode". It runs Server's router in memory over Client + Core + Server, with no listener and the same handler semantics as networked use.
- `packages/sdk/js`: the legacy generated SDK (from `packages/sdk/openapi.json`). The TUI and web app still use it.

### The `opencode` package and the V1→V2 transition

`packages/opencode` is the shipping `opencode` binary:

- yargs commands live in `src/cli/cmd/*`.
- `src/server/server.ts` is an Effect HTTP server. It hosts the legacy instance API groups (`src/server/routes/instance/httpapi/`) together with the current API composed from Protocol + Server middleware.
- The legacy (V1) session loop lives in `src/session/` (`prompt.ts`, `processor.ts`, `llm.ts`). `event-v2-bridge.ts` shadows V1 activity into V2 events.

Much of the code is mid-migration from the `opencode` package into `core`. Before changing behavior, check which runtime owns it. Do not bridge V2 Session execution through the legacy `SessionPrompt.loop`.

`opencode` services follow `packages/opencode/AGENTS.md`:

- Flat exports with an `export * as Foo from "./foo"` self-reexport, and no barrels in multi-sibling dirs.
- `makeRuntime` for services and `InstanceState` (a ScopedCache keyed by directory) for per-project state.
- `EffectBridge` for re-entering Effect from native callbacks.

### LLM path

- `packages/llm` is an Effect Schema-first LLM client. A route is Protocol + Endpoint + Auth + Framing, and provider facades configure routes.
- `packages/opencode/src/session/llm.ts` selects the runtime per request. The AI SDK is the default; `OPENCODE_EXPERIMENTAL_NATIVE_LLM=true` opts into `@opencode-ai/llm` for supported providers.
- Both runtimes emit the same `LLMEvent` stream.
- V2 Core's runner makes one explicit `llm.stream(request)` call per provider turn.

### Frontends and other packages

- `packages/tui`: the canonical terminal UI (SolidJS on opentui), extracted from `packages/opencode`. It must reach the backend only through the SDK, never by importing Core. `packages/opencode` and `packages/cli` both consume it.
- `packages/cli`: a new Effect-based CLI (bin `lildax`), still in development.
- `packages/app`: the SolidJS web UI.
- `packages/desktop`: Electron wrapper around the app.
- `packages/ui` and `packages/session-ui`: shared components. All user-visible strings must go through i18n.
- `packages/plugin`: the public `@opencode-ai/plugin` API.
- `packages/codemode`: confined execution over schema-described tools.
- `packages/effect-drizzle-sqlite`: a generic vendored adapter, with no opencode-specific code.
- `packages/console/*`, `packages/stats/*`, `packages/web` (Astro docs site), `packages/enterprise`, `packages/function`, and `packages/slack` are hosted services and sites, deployed with SST (`sst.config.ts`, `infra/`). They are unrelated to the CLI runtime.
- New model providers normally need no code here. They are added to models.dev.

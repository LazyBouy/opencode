import type { Page, Route } from "@playwright/test"

// The default and small model by level (default_models_spec.md §11), layered over mockOperator (registered
// after it, so it wins for these paths): Settings' values, each namespace's, each project's, and the writes.

type Key = "model" | "small_model"
type Values = { model?: string; small_model?: string }

export type ModelDefaultsMock = {
  settings: Values
  namespaces: Record<string, Values>
  /** `own`: the project has a config of its own (else a write asks to copy its namespace's first). */
  projects: Record<string, Values & { namespace: string; own?: boolean }>
  /** What OpenCode decides when nothing is set. */
  decides: { model: string; small: string }
  /** An environment variable that sets the default model, if any. */
  environment?: { variable: "OPENCODE_CONFIG" | "OPENCODE_CONFIG_DIR" | "OPENCODE_CONFIG_CONTENT"; model: string }
  writes: Array<Record<string, unknown>>
}

export const modelProviders = {
  all: [
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-5": { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", limit: { context: 200_000 } },
        "claude-haiku-4-5": { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", limit: { context: 200_000 } },
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      models: { "gpt-5": { id: "gpt-5", name: "GPT-5", limit: { context: 400_000 } } },
    },
  ],
  connected: ["anthropic", "openai"],
  default: { anthropic: "claude-sonnet-4-5", openai: "gpt-5" },
}

const SETTINGS_FILE = "/root/.config/opencode/opencode.jsonc"

const link = (level: string, value: string | undefined, path: string) => ({
  level,
  set: value !== undefined,
  ...(value !== undefined ? { model: value } : {}),
  path,
})

// One key's chain over the given levels, in order; the last that sets it is in effect.
function chain(
  mock: ModelDefaultsMock,
  key: Key,
  levels: Array<{ level: string; value: string | undefined; path: string }>,
) {
  const env = key === "model" ? mock.environment : undefined
  const all = [
    ...levels.map((item) => link(item.level, item.value, item.path)),
    ...(env ? [{ ...link("environment", env.model, env.variable), variable: env.variable }] : []),
  ]
  const effectiveOf = (list: typeof all) => {
    const last = list.filter((item) => item.set).at(-1)
    return last
      ? {
          model: last.model,
          from: last.level,
          ...("variable" in last ? { variable: last.variable } : {}),
        }
      : {
          model: key === "model" ? mock.decides.model : mock.decides.small,
          from: "opencode",
          rule: key === "model" ? "ranking" : "small-family",
        }
  }
  // The Inherit option: without the deepest level's own setting.
  const deepest = levels.at(-1)?.level
  return {
    levels: all.map((item) =>
      env && item.set && item.level !== "environment" ? { ...item, overriddenBy: env.variable } : item,
    ),
    effective: effectiveOf(all),
    inherited: effectiveOf(all.filter((item) => item.level !== deepest)),
  }
}

export function modelChains(mock: ModelDefaultsMock, namespace?: string, project?: string) {
  const ns = namespace && namespace !== "global" ? namespace : undefined
  const levels = (key: Key) => [
    { level: "settings", value: mock.settings[key], path: SETTINGS_FILE },
    ...(ns
      ? [
          {
            level: "namespace",
            value: mock.namespaces[ns]?.[key],
            path: `/root/opencode-home/${ns}/.opencode/opencode.jsonc`,
          },
        ]
      : []),
    ...(project
      ? [{ level: "project", value: mock.projects[project]?.[key], path: `${project}/.opencode/opencode.jsonc` }]
      : []),
  ]
  return { model: chain(mock, "model", levels("model")), small: chain(mock, "small_model", levels("small_model")) }
}

export function modelDefaultsMock(): ModelDefaultsMock {
  return {
    settings: { model: "anthropic/claude-sonnet-4-5" },
    namespaces: {},
    projects: {},
    decides: { model: "anthropic/claude-sonnet-4-5", small: "anthropic/claude-haiku-4-5" },
    writes: [],
  }
}

/** The model routes' answers, for the mocks' route handlers (undefined: not a model route). */
export function modelRoute(mock: ModelDefaultsMock, url: URL, method: string, body: () => unknown) {
  if (url.pathname === "/operator/model" && method === "GET") {
    const project = url.searchParams.get("directory") ?? undefined
    const namespace = project ? (mock.projects[project]?.namespace ?? "opencode") : "opencode"
    const chain = modelChains(mock, namespace, project)
    // The older fields, as the server still sends them.
    return {
      body: {
        model: { model: chain.model.effective.model, source: "ranking", how: "default" },
        small: { model: chain.small.effective.model, source: "small-family", how: "default" },
        global: { path: SETTINGS_FILE },
        chain,
      },
    }
  }
  if (url.pathname === "/operator/model/namespace" && method === "GET") {
    const namespace = url.searchParams.get("namespace") ?? undefined
    const settings = !namespace || namespace === "global"
    return {
      body: {
        ...(namespace ? { namespace, name: namespace === "opencode" ? "OpenCode" : namespace } : {}),
        settings,
        path: settings ? SETTINGS_FILE : `/root/opencode-home/${namespace}/.opencode/opencode.jsonc`,
        chain: modelChains(mock, namespace),
      },
    }
  }
  if (url.pathname === "/operator/model/default" && method === "PUT") {
    const input = body() as {
      level: string
      namespace?: string
      directory?: string
      key: Key
      model: string | null
      confirmCopy?: boolean
    }
    // A project without its own config asks first (copy-on-write).
    if (input.level === "project" && !mock.projects[input.directory!]?.own && !input.confirmCopy)
      return {
        status: 409,
        body: {
          name: "OperatorProjectConfigCopyNeededError",
          data: {
            message: "This project uses its namespace's config.",
            project: input.directory,
            namespace: mock.projects[input.directory!]?.namespace ?? "opencode",
            file: `${input.directory}/.opencode/opencode.jsonc`,
          },
        },
      }
    mock.writes.push(input)
    const target =
      input.level === "settings"
        ? mock.settings
        : input.level === "namespace"
          ? (mock.namespaces[input.namespace!] ??= {})
          : (mock.projects[input.directory!] ??= { namespace: "opencode" })
    if (input.level === "project") (target as { own?: boolean }).own = true
    if (input.model === null) delete target[input.key]
    else target[input.key] = input.model
    return { body: { path: SETTINGS_FILE, changed: true, reload: "now" } }
  }
  if (url.pathname === "/operator/model/default-for" && method === "GET") {
    const model = url.searchParams.get("model")
    return {
      body: {
        model,
        ...(mock.settings.model === model || mock.settings.small_model === model
          ? {
              settings: {
                model: mock.settings.model === model,
                small: mock.settings.small_model === model,
                path: SETTINGS_FILE,
              },
            }
          : {}),
        namespaces: Object.entries(mock.namespaces)
          .filter(([, value]) => value.model === model || value.small_model === model)
          .map(([id, value]) => ({
            id,
            name: id,
            model: value.model === model,
            small: value.small_model === model,
            path: `/root/opencode-home/${id}/.opencode/opencode.jsonc`,
          })),
        projects: Object.entries(mock.projects)
          .filter(([, value]) => value.model === model || value.small_model === model)
          .map(([key, value]) => ({
            key,
            name: key.split("/").at(-1),
            namespace: value.namespace,
            model: value.model === model,
            small: value.small_model === model,
            path: `${key}/.opencode/opencode.jsonc`,
          })),
      },
    }
  }
  return undefined
}

/** The model routes with their own state, registered after mockOperator (so it wins for these paths). */
export async function mockModelDefaults(page: Page, mock = modelDefaultsMock()) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  await page.route(
    (url) => url.pathname.startsWith("/operator/model"),
    (route) => {
      const url = new URL(route.request().url())
      const found = modelRoute(mock, url, route.request().method(), () => route.request().postDataJSON())
      return found ? json(route, found.body, found.status) : route.fallback()
    },
  )
  return mock
}

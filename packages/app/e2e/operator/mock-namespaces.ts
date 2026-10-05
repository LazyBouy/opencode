import type { Route } from "@playwright/test"

// An in-memory stand-in for the prompt profile API (/operator/namespaces, /operator/project-settings,
// /operator/agent-prompt): namespaces with their types, layers, groups and profiles, OpenCode's
// built-in items, project links and agent settings.

const PREFIX = "opencode:"

type GroupType = { id: string; name: string; description: string; builtin: boolean }
type Layer = {
  id: string
  name: string
  type: string
  section: string
  replaces?: string
  text: string
  origin: string
  delivery?: "tool" | "conversation"
}
type Group = { id: string; name: string; types: string[]; builtin: boolean }
type Profile = { id: string; name: string; group: string; slots: Record<string, string[]>; builtin: boolean }
type Namespace = {
  id: string
  name: string
  purpose: string
  defaultProfile?: string
  createdAt: number
  updatedAt: number
}
type Items = { types: GroupType[]; layers: Layer[]; groups: Group[]; profiles: Profile[] }
type Override = { group?: string; slots?: Record<string, string[]> }
export type AgentSetting = { profile?: string; override?: Override }
export type ProjectSetting = { namespace: string; purpose?: string; defaultProfile?: string }

const type = (id: string, name: string): GroupType => ({ id, name, description: "", builtin: true })
const builtin = (id: string, name: string, type: string, section: string, origin: string, text = ""): Layer => ({
  id: `${PREFIX}${id}`,
  name,
  type,
  section,
  text,
  origin,
})

export const builtinTypes: GroupType[] = [
  type("platform", "Platform/system constraints"),
  type("purpose", "Purpose"),
  type("role", "Agent role"),
  type("identity", "Agent identity"),
  type("dynamic", "Dynamic"),
  type("capabilities", "Stable capability boundaries"),
  type("additional", "Optional additional blocks"),
  type("output", "Output format"),
  type("helper", "Helper"),
]

export const builtinLayers: Layer[] = [
  builtin(
    "base.anthropic",
    "base.anthropic",
    "identity",
    "base",
    "builtin",
    "You are OpenCode, the best coding agent.",
  ),
  builtin("base.default", "base.default", "identity", "base", "builtin", "You are opencode, an interactive CLI tool."),
  builtin("slot.base", "Base prompt (by model)", "dynamic", "dynamic", "slot"),
  builtin("slot.agent-or-base", "Agent prompt, else base prompt", "dynamic", "dynamic", "slot"),
  builtin("slot.agent", "Agent prompt", "dynamic", "dynamic", "slot"),
  builtin("generated.mcp", "MCP instructions", "dynamic", "dynamic", "generated"),
  builtin("generated.skills", "Skills", "dynamic", "dynamic", "generated"),
  builtin("generated.environment", "Environment", "dynamic", "dynamic", "generated"),
  builtin("generated.references", "References", "dynamic", "dynamic", "generated"),
  builtin("generated.instructions", "Instructions", "dynamic", "dynamic", "generated"),
  builtin("helper.title", "title", "helper", "helper", "builtin", "You are a title generator."),
  builtin("helper.summary", "summary", "helper", "helper", "builtin", "Summarize what was done."),
  builtin("helper.compaction", "compaction", "helper", "helper", "builtin", "Summarize the conversation."),
  builtin("helper.agent-generator", "agent-generator", "helper", "helper", "builtin", "Write an agent."),
  builtin(
    "notice.structured-output",
    "notice.structured-output",
    "output",
    "output",
    "builtin",
    "Use StructuredOutput.",
  ),
  {
    ...builtin("reminder.plan", "reminder.plan", "platform", "message", "builtin", "Plan mode is active."),
    delivery: "conversation",
  },
  {
    ...builtin("notice.max-steps", "notice.max-steps", "platform", "message", "builtin", "Maximum steps reached."),
    delivery: "conversation",
  },
  builtin("purpose.org", "Org purpose", "purpose", "purpose", "automatic"),
]

export const builtinGroups: Group[] = [
  {
    id: `${PREFIX}group.spec`,
    name: "Default",
    types: ["platform", "purpose", "role", "identity", "dynamic", "capabilities", "additional", "output"],
    builtin: true,
  },
  {
    id: `${PREFIX}group.opencode`,
    name: "OpenCode",
    types: ["purpose", "role", "identity", "dynamic", "additional", "capabilities", "output"],
    builtin: true,
  },
  { id: `${PREFIX}group.helper`, name: "Helper", types: ["helper"], builtin: true },
]

const environment = [
  `${PREFIX}generated.environment`,
  `${PREFIX}generated.references`,
  `${PREFIX}generated.instructions`,
]
const capabilities = [`${PREFIX}generated.mcp`, `${PREFIX}generated.skills`]
export const builtinProfiles: Profile[] = [
  {
    id: `${PREFIX}profile.opencode`,
    name: "OpenCode",
    group: `${PREFIX}group.opencode`,
    slots: {
      role: [],
      identity: [],
      dynamic: [`${PREFIX}slot.agent-or-base`, ...environment, ...capabilities],
      output: [`${PREFIX}notice.structured-output`],
    },
    builtin: true,
  },
  ...["title", "summary", "compaction", "agent-generator"].map((name) => ({
    id: `${PREFIX}profile.helper.${name}`,
    name: (name.charAt(0).toUpperCase() + name.slice(1)).replace("-", " "),
    group: `${PREFIX}group.helper`,
    slots: { helper: [`${PREFIX}helper.${name}`] },
    builtin: true,
  })),
  {
    id: `${PREFIX}profile.spec`,
    name: "Spec",
    group: `${PREFIX}group.spec`,
    slots: {
      platform: [],
      role: [],
      identity: [],
      dynamic: [`${PREFIX}slot.base`, `${PREFIX}slot.agent`, ...capabilities, ...environment],
      output: [`${PREFIX}notice.structured-output`],
    },
    builtin: true,
  },
]

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export interface PromptMock {
  readonly namespaces: Namespace[]
  readonly items: Record<string, Items>
  readonly projects: Record<string, ProjectSetting>
  readonly agents: Record<string, AgentSetting>
  readonly writes: Array<{ method: string; path: string; body: unknown }>
}

// What OpenCode writes per request in the mock: generated layers by id (empty ones are not sent).
const generated = (directory: string): Record<string, { text: string; source: string }> => ({
  [`${PREFIX}generated.environment`]: {
    text: "You are powered by the model named Claude Opus 4.6.\n<env>\n  Working directory: /repo\n</env>",
    source: "generated",
  },
  [`${PREFIX}generated.instructions`]: {
    text: `Instructions from: ${directory}/AGENTS.md\nUse Bun.`,
    source: `${directory}/AGENTS.md`,
  },
  [`${PREFIX}generated.skills`]: {
    text: "<available_skills>\n  <skill>review</skill>\n</available_skills>",
    source: "generated",
  },
})

export function createPromptMock(
  projects: Array<{ key: string; name: string }>,
  // An agent's own prompt, if it has one.
  ownPrompt: (agent: string) => string | undefined = () => undefined,
  // Whether a folder is in a git repository (a project without registering).
  git: (folder: string) => boolean = () => false,
) {
  const state: PromptMock = {
    namespaces: [{ id: "opencode", name: "OpenCode", purpose: "", createdAt: 0, updatedAt: 0 }],
    items: { opencode: { types: [], layers: [], groups: [], profiles: [] } },
    projects: Object.fromEntries(projects.map((project) => [project.key, { namespace: "opencode" }])),
    agents: {},
    writes: [],
  }
  const nameOf = (key: string) =>
    projects.find((project) => project.key === key)?.name ?? key.split("/").filter(Boolean).at(-1) ?? key
  // A namespace's own item, if there is one with this id.
  const ownItem = (ns: string, list: "layers" | "profiles", id: string | undefined) => {
    const found = (state.items[ns]?.[list] as Array<{ id: string; name: string }> | undefined)?.find(
      (item) => item.id === id,
    )
    return found ? [{ list, found }] : []
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
  const invalid = (route: Route, message: string) =>
    json(route, { name: "OperatorProfileInvalidError", data: { message } }, 400)
  const free = (list: Array<{ id: string }>, name: string) => {
    const base = slug(name) || "item"
    const next = (index: number): string => {
      const id = index === 1 ? base : `${base}-${index}`
      return list.some((item) => item.id === id) ? next(index + 1) : id
    }
    return next(1)
  }
  const summary = (namespace: Namespace) => ({
    namespace,
    projects: Object.entries(state.projects)
      .filter(([, setting]) => setting.namespace === namespace.id)
      .map(([key]) => key),
  })
  const catalog = (ns: string) => {
    const namespace = state.namespaces.find((item) => item.id === ns)!
    const items = state.items[ns]!
    const keys = summary(namespace).projects
    return {
      namespace,
      types: [...builtinTypes, ...items.types],
      layers: [...builtinLayers, ...items.layers],
      groups: [...builtinGroups, ...items.groups],
      profiles: [...builtinProfiles, ...items.profiles],
      projects: keys.map((key) => ({ key, name: nameOf(key), ...state.projects[key] })),
      agents: Object.entries(state.agents)
        .map(([id, setting]) => {
          const [project, name] = id.split("\n")
          return { project: project!, name: name!, ...setting }
        })
        .filter((agent) => keys.includes(agent.project)),
    }
  }
  // Which profile an agent uses, and where that comes from.
  const agentPrompt = (project: string, name: string) => {
    const setting = state.agents[`${project}\n${name}`] ?? {}
    const link = state.projects[project] ?? { namespace: "opencode" }
    const loaded = catalog(link.namespace)
    const find = (id: string | undefined) => loaded.profiles.find((item) => item.id === id)
    const helpers = ["title", "summary", "compaction", "agent-generator"]
    const fallback =
      (helpers.includes(name) ? find(`${PREFIX}profile.helper.${name}`) : undefined) ??
      find(link.defaultProfile) ??
      find(loaded.namespace.defaultProfile) ??
      builtinProfiles[0]!
    const source = setting.profile
      ? "agent"
      : helpers.includes(name)
        ? "helper"
        : find(link.defaultProfile)
          ? "project"
          : "namespace"
    const profile = find(setting.profile) ?? fallback
    return {
      setting,
      namespace: { id: loaded.namespace.id, name: loaded.namespace.name },
      profile: { id: profile.id, name: profile.name, source },
      default: { id: fallback.id, name: fallback.name },
    }
  }

  // A small stand-in for the assembler: Purpose, then the effective group's slots in order.
  const preview = (url: URL) => {
    const project = url.searchParams.get("directory") ?? ""
    const name = url.searchParams.get("agent") ?? "build"
    const chosen = agentPrompt(project, name)
    const link = state.projects[project] ?? { namespace: "opencode" }
    const loaded = catalog(link.namespace)
    const asked = url.searchParams.get("profile")
    const profile = loaded.profiles.find((item) => item.id === (asked ?? chosen.profile.id))!
    const override = asked ? undefined : chosen.setting.override
    const group = loaded.groups.find((item) => item.id === (override?.group ?? profile.group))!
    const typeName = (id: string) => loaded.types.find((item) => item.id === id)?.name ?? id
    const own = ownPrompt(name)
    const base = builtinLayers.find((layer) => layer.id === `${PREFIX}base.default`)!
    const extra = generated(project)
    const section = (type: string, entry: string, layer: Layer, text: string, source: string, automatic = false) => ({
      type,
      typeName: typeName(type),
      layer: layer.id,
      layerName: layer.name,
      entry,
      automatic,
      changed: !!override?.slots?.[type],
      source,
      text,
    })
    const purpose = loaded.layers.find((layer) => layer.id === link.purpose)
    const org = builtinLayers.find((layer) => layer.id === `${PREFIX}purpose.org`)!
    const sections = [
      ...(loaded.namespace.purpose
        ? [section("purpose", org.id, org, loaded.namespace.purpose, loaded.namespace.name, true)]
        : []),
      ...(purpose ? [section("purpose", purpose.id, purpose, purpose.text, purpose.name, true)] : []),
      ...group.types
        .filter((type) => type !== "purpose")
        .flatMap((type) =>
          (override?.slots?.[type] ?? profile.slots[type] ?? []).flatMap((entry) => {
            const layer = loaded.layers.find((item) => item.id === entry)
            if (!layer) return []
            if (entry === `${PREFIX}slot.base`) return [section(type, entry, layer, base.text, "base.default")]
            if (entry === `${PREFIX}slot.agent`) return own ? [section(type, entry, layer, own, name)] : []
            if (entry === `${PREFIX}slot.agent-or-base`)
              return [
                own ? section(type, entry, layer, own, name) : section(type, entry, layer, base.text, "base.default"),
              ]
            const written = extra[entry]
            if (written) return [section(type, entry, layer, written.text, written.source)]
            if (layer.type === "helper") return [section(type, entry, layer, layer.text, "OpenCode")]
            if (layer.origin !== "user" || layer.replaces) return []
            return [section(type, entry, layer, layer.text, layer.name)]
          }),
        ),
    ]
    return {
      agent: name,
      model: "opencode/claude-opus-4-6",
      base: "base.default",
      namespace: chosen.namespace,
      project: { key: project, name: nameOf(project) },
      profile: asked ? { id: profile.id, name: profile.name, source: chosen.profile.source } : chosen.profile,
      group: { id: group.id, name: group.name },
      override: Object.keys(override?.slots ?? {}),
      sections,
      system: [sections.map((item) => item.text).join("\n")],
    }
  }

  const handle = (route: Route, url: URL, method: string) => {
    const body = (method === "GET" || method === "DELETE" ? null : route.request().postDataJSON()) as Record<
      string,
      unknown
    > | null
    if (method !== "GET") state.writes.push({ method, path: url.pathname, body })

    if (url.pathname === "/operator/prompt/preview") return json(route, preview(url))
    // A Dynamic layer's sample: what it fills in for the agent of the project.
    if (url.pathname === "/operator/prompt/sample") {
      const layer = url.searchParams.get("layer") ?? ""
      const agent = url.searchParams.get("agent") ?? "build"
      const written = generated(url.searchParams.get("directory") ?? "")[layer]
      const base = {
        text: builtinLayers.find((item) => item.id === `${PREFIX}base.default`)!.text,
        source: "base.default",
      }
      const found =
        written ??
        (layer === `${PREFIX}slot.base` || layer === `${PREFIX}slot.agent-or-base` ? base : { text: "", source: "" })
      return json(route, { agent, model: "opencode/claude-opus-4-6", layer, ...found })
    }
    if (url.pathname === "/operator/project-settings/resolve") {
      const folder = url.searchParams.get("directory") ?? ""
      if (git(folder)) return json(route, { directory: folder, project: { key: folder, git: true } })
      const key = Object.keys(state.projects)
        .filter((item) => folder === item || folder.startsWith(`${item}/`))
        .toSorted((a, b) => b.length - a.length)[0]
      return json(route, { directory: folder, ...(key ? { project: { key, git: false } } : {}) })
    }
    if (url.pathname === "/operator/project-settings/register") {
      const input = body as { directory: string; git?: boolean; namespace?: string; from?: string; sessions?: boolean }
      const namespace =
        input.namespace ?? (input.from ? state.projects[input.from]?.namespace : undefined) ?? "opencode"
      state.projects[input.directory] = { namespace }
      return json(route, {
        project: { key: input.directory, name: nameOf(input.directory), namespace, registered: true },
        // A copy brings the source's agents and tools, and its sessions when asked.
        ...(input.from
          ? {
              copied: {
                files: [".opencode/agents/docs.md", ".opencode/tools/hello.ts"],
                kept: [],
                items: [],
                sessions: input.sessions ? 2 : 0,
              },
            }
          : {}),
      })
    }
    if (url.pathname === "/operator/project-settings/folder/move") return json(route, { moved: 1, archived: 0 })
    if (url.pathname === "/operator/project-settings/folder/archive") return json(route, { archived: 1 })
    if (url.pathname === "/operator/project-settings") {
      if (method === "GET")
        return json(
          route,
          Object.entries(state.projects).map(([key, setting]) => ({
            key,
            name: nameOf(key),
            ...setting,
            registered: true,
          })),
        )
      const input = body as {
        key: string
        namespace?: string
        purpose?: string
        defaultProfile?: string
        dryRun?: boolean
      }
      const current = state.projects[input.key] ?? { namespace: "opencode" }
      const next = {
        namespace: input.namespace ?? current.namespace,
        purpose: input.purpose === "" ? undefined : (input.purpose ?? current.purpose),
        defaultProfile: input.defaultProfile === "" ? undefined : (input.defaultProfile ?? current.defaultProfile),
      }
      // A move copies the project's own purpose and default profile that the target lacks.
      const copied =
        next.namespace === current.namespace
          ? []
          : [
              ...ownItem(current.namespace, "layers", current.purpose),
              ...ownItem(current.namespace, "profiles", current.defaultProfile),
            ].filter((item) => !state.items[next.namespace]![item.list].some((there) => there.id === item.found.id))
      if (!input.dryRun) {
        for (const item of copied)
          (state.items[next.namespace]![item.list] as unknown[]).push(structuredClone(item.found))
        state.projects[input.key] = next
      }
      return json(route, {
        project: { key: input.key, name: nameOf(input.key), ...next },
        copied: copied.map((item) => ({ kind: item.list.slice(0, -1), id: item.found.id, name: item.found.name })),
      })
    }

    const agent = url.pathname.match(/^\/operator\/agent-prompt\/([^/]+)$/)
    if (agent) {
      const name = decodeURIComponent(agent[1]!)
      const project = url.searchParams.get("directory") ?? ""
      if (method === "PUT") {
        const setting = { ...(body as AgentSetting) }
        state.agents[`${project}\n${name}`] = setting
      }
      return json(route, agentPrompt(project, name))
    }

    const parts = url.pathname.slice("/operator/namespaces".length).split("/").filter(Boolean).map(decodeURIComponent)
    if (parts.length === 0) {
      if (method === "GET") return json(route, state.namespaces.map(summary))
      const name = String(body?.name ?? "")
      const namespace = {
        id: free(state.namespaces, name),
        name,
        purpose: String(body?.purpose ?? ""),
        createdAt: 1,
        updatedAt: 1,
      }
      state.namespaces.push(namespace)
      state.items[namespace.id] = structuredClone(state.items.opencode!)
      return json(route, namespace)
    }
    const [ns, kind, id, action] = parts as [string, string?, string?, string?]
    const namespace = state.namespaces.find((item) => item.id === ns)
    if (!namespace)
      return json(route, { name: "OperatorProfileNotFoundError", data: { message: `No namespace ${ns}` } }, 404)
    const items = state.items[ns]!
    if (!kind) {
      if (method === "GET") return json(route, namespace)
      if (method === "DELETE") {
        state.namespaces.splice(state.namespaces.indexOf(namespace), 1)
        return json(route, true)
      }
      Object.assign(namespace, body)
      return json(route, namespace)
    }
    if (kind === "catalog") return json(route, catalog(ns))
    if (kind === "copy") {
      const input = body as { kind: string; id: string; target: string }
      const list = items[`${input.kind}s` as keyof Items] as Array<{ id: string; name: string }>
      const found = list.find((item) => item.id === input.id)
      if (!found) return invalid(route, `No ${input.kind} ${input.id}`)
      const target = state.items[input.target]![`${input.kind}s` as keyof Items] as Array<{ id: string; name: string }>
      const name = target.some((item) => item.name === found.name) ? `${found.name} (copy)` : found.name
      const copy = { ...structuredClone(found), id: free(target, name), name }
      target.push(copy)
      return json(route, { copied: [{ kind: input.kind, id: copy.id, name: copy.name }] })
    }
    const list = { types: items.types, layers: items.layers, groups: items.groups, profiles: items.profiles }[kind] as
      | Array<{ id: string; name: string }>
      | undefined
    if (!list) return route.fallback()
    if (method === "DELETE") {
      list.splice(
        list.findIndex((item) => item.id === id),
        1,
      )
      return json(route, true)
    }
    if (kind === "layers" && action === "copy") {
      const original = builtinLayers.find((layer) => layer.id === id)!
      const name = `${original.name} – copy`
      const copy: Layer = {
        ...original,
        id: free(list, name),
        name,
        replaces: original.id,
        text: String(body?.text ?? original.text),
        origin: "user",
      }
      items.layers.push(copy)
      return json(route, copy)
    }
    const extra =
      kind === "layers"
        ? { origin: "user", section: "custom" }
        : kind === "types"
          ? { description: "", builtin: false }
          : { builtin: false }
    const before = list.find((item) => item.id === id)
    const saved = { ...extra, ...before, ...body, id: id ?? free(list, String(body?.name ?? kind)) } as {
      id: string
      name: string
    }
    delete (saved as Record<string, unknown>).ns
    if (before) list[list.indexOf(before)] = saved
    else list.push(saved)
    return json(route, saved)
  }

  return { state, handle }
}

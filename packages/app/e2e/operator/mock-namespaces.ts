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
  folder?: string
  defaultProject?: string
  inheritGlobal?: boolean
  createdAt: number
  updatedAt: number
}
type Items = { types: GroupType[]; layers: Layer[]; groups: Group[]; profiles: Profile[] }
type Override = { group?: string; slots?: Record<string, string[]> }
export type AgentSetting = { profile?: string; override?: Override }
export type ProjectSetting = {
  namespace: string
  purpose?: string
  defaultProfile?: string
  flag?: "outside-opencode" | "not-in-place"
}

// Global's folder in the mock; the working directory starts set, as in the dev stack.
export const GLOBAL_FOLDER = "/home/me/.config/opencode"

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
  {
    ...builtin(
      "base.default",
      "base.default",
      "identity",
      "base",
      "builtin",
      "You are opencode, an interactive CLI tool.",
    ),
    file: "packages/opencode/src/session/prompt/default.txt",
  },
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
  /** Blank (undefined): Global and OpenCode are one namespace. */
  workingDir: string | undefined
  /** Global's record, listed while the working directory is set. */
  readonly global: Namespace
  /** Moves asked for (plans and moves), and what blocks the next plan's items. */
  readonly moves: Array<{ path: string; body: unknown }>
  moveBlockers?: Array<{ kind: string; message: string }>
  /** Merged agents' records of the moved folder's sessions that follow it. */
  moveAgents?: Array<{ adapter: string; name: string; folders: number }>
  /** The upgrade's confirmation waits (§12.3). */
  upgrade: { waiting: boolean; needsWorkingDir: boolean; suggested?: string }
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

// A Dynamic layer's resolution trace (resolver.ts), for the mocked preview and calls.
export const candidate = (
  location: string,
  group: string | undefined,
  fields: { read?: string; filtered?: string; selected?: boolean; why: string; score?: number },
) => ({
  source: 0,
  kind: "file",
  location,
  name: location.split("/").at(-1),
  ...(group ? { group } : {}),
  read: fields.read ?? "ok",
  chars: 12,
  ...(fields.filtered ? { filtered: fields.filtered } : {}),
  score: fields.score ?? 0,
  parts: fields.score ? [{ rule: "precedence (name)", points: fields.score }] : [],
  selected: fields.selected ?? false,
  why: fields.why,
})
export const resolution = (candidates: ReturnType<typeof candidate>[]) => ({
  policy: "one",
  candidates,
  chars: 24,
  overBudget: 0,
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
    items: {
      opencode: { types: [], layers: [], groups: [], profiles: [] },
      global: { types: [], layers: [], groups: [], profiles: [] },
    },
    projects: Object.fromEntries(projects.map((project) => [project.key, { namespace: "opencode" }])),
    agents: {},
    writes: [],
    workingDir: "/workspace",
    global: { id: "global", name: "Global", purpose: "", createdAt: 0, updatedAt: 0 },
    moves: [],
    upgrade: { waiting: false, needsWorkingDir: false },
  }
  // The last plan made, for the move that follows it.
  let planned: Array<{ id: string; kind: string; name: string; from: string; to: string; namespace: string }> = []
  // Global first when separate; with a blank working directory OpenCode is Global.
  const listed = () => (state.workingDir ? [state.global, ...state.namespaces] : state.namespaces)
  const place = (namespace: Namespace) => {
    const global = namespace.id === "global" || (!state.workingDir && namespace.id === "opencode")
    const target = global
      ? GLOBAL_FOLDER
      : state.workingDir
        ? `${state.workingDir}/${namespace.id}`
        : (namespace.folder ?? "")
    const folder = global ? GLOBAL_FOLDER : (namespace.folder ?? target)
    return {
      folder,
      target,
      inPlace: global || !state.workingDir || folder === target,
      global,
      configFile: global ? `${GLOBAL_FOLDER}/opencode.jsonc` : `${folder}/.opencode/opencode.jsonc`,
    }
  }
  // Like the server: a project assigned to another namespace than OpenCode stays there until its folder
  // is in the namespace's ("Outside OpenCode's folder" is only set by a test).
  const notInPlace = (key: string, ns: string) => {
    const namespace = ns === "opencode" ? undefined : listed().find((item) => item.id === ns)
    if (!namespace) return false
    const folder = place(namespace).folder
    return !!folder && key !== folder && !key.startsWith(`${folder}/`)
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
  // Projects in the order they were added; the chosen default while it is there, else the first.
  const summary = (namespace: Namespace) => {
    const keys = Object.entries(state.projects)
      .filter(([, setting]) => setting.namespace === namespace.id)
      .map(([key]) => key)
    const chosen =
      namespace.defaultProject && keys.includes(namespace.defaultProject) ? namespace.defaultProject : keys[0]
    const { folder, ...where } = place(namespace)
    return {
      namespace: { ...namespace, folder },
      ...where,
      projects: keys,
      ...(chosen ? { defaultProject: chosen } : {}),
      ...(keys[0] ? { firstProject: keys[0] } : {}),
    }
  }
  // Built-ins belong to OpenCode; another namespace has its own copies ("<id>" for "opencode:<id>").
  const own = (id: string) => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id)
  const versionId = (ns: string, id: string) => (ns === "opencode" ? id : own(id))
  const copies = {
    layers: builtinLayers
      .filter((layer) => layer.origin !== "automatic")
      .map((layer): Layer => ({ ...layer, id: own(layer.id), origin: "user", replaces: layer.id })),
    groups: builtinGroups.map((group): Group => ({ ...group, id: own(group.id), builtin: false })),
    profiles: builtinProfiles.map(
      (profile): Profile => ({
        ...profile,
        id: own(profile.id),
        group: own(profile.group),
        slots: Object.fromEntries(Object.entries(profile.slots).map(([type, ids]) => [type, ids.map(own)])),
        builtin: false,
      }),
    ),
  }
  const catalog = (ns: string) => {
    const namespace = listed().find((item) => item.id === ns)!
    const items = state.items[ns]!
    const keys = summary(namespace).projects
    const opencode = ns === "opencode"
    return {
      namespace,
      types: [...builtinTypes, ...items.types],
      layers: [...(opencode ? builtinLayers : copies.layers), ...items.layers],
      groups: [...(opencode ? builtinGroups : copies.groups), ...items.groups],
      profiles: [...(opencode ? builtinProfiles : copies.profiles), ...items.profiles],
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
      (helpers.includes(name) ? find(versionId(link.namespace, `${PREFIX}profile.helper.${name}`)) : undefined) ??
      find(link.defaultProfile) ??
      find(loaded.namespace.defaultProfile) ??
      find(versionId(link.namespace, `${PREFIX}profile.opencode`))!
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
    // Unsaved override edits are previewed in place of the saved override.
    const draft = url.searchParams.get("override")
    const override = asked
      ? undefined
      : draft
        ? ((JSON.parse(draft) as { group?: string; slots?: Record<string, string[]> } | null) ?? undefined)
        : chosen.setting.override
    const group = loaded.groups.find((item) => item.id === (override?.group ?? profile.group))!
    const typeName = (id: string) => loaded.types.find((item) => item.id === id)?.name ?? id
    const own = ownPrompt(name)
    const base = builtinLayers.find((layer) => layer.id === `${PREFIX}base.default`)!
    const extra = generated(project)
    // How each section resolved, down to its file (as the server traces it).
    const traceOf = (entry: string, layer: Layer, source: string): unknown[] => {
      if (source === "base.default")
        return [
          ...(entry === `${PREFIX}slot.agent-or-base` ? [{ kind: "agent-none", name }] : []),
          { kind: "model-rule", name: "opencode/claude-opus-4-6", detail: "no other rule matches" },
          { kind: "builtin-layer", name: "base.default", detail: `${PREFIX}base.default` },
          { kind: "file", path: "packages/opencode/src/session/prompt/default.txt" },
        ]
      if (source === name)
        return [
          { kind: "agent-own", name },
          { kind: "agent-file", path: `${project}/.opencode/agents/${name}.md` },
        ]
      if (entry === `${PREFIX}generated.environment`) return [{ kind: "written" }]
      if (entry === `${PREFIX}generated.instructions`) return [{ kind: "instruction-file", path: source }]
      if (entry === `${PREFIX}purpose.org`) return [{ kind: "org-purpose", name: source }]
      if (layer.origin !== "user") return [{ kind: "builtin-layer", name: layer.name, detail: layer.id }]
      return [
        { kind: "layer", name: layer.name, detail: layer.id },
        { kind: "file", path: `/home/me/.config/opencode/namespaces/${link.namespace}/layers/${layer.id}.md` },
      ]
    }
    // OpenCode's per-request layers, as the pipeline resolved them (Skills: a text that differs from upstream's).
    const resolutionOf = (entry: string) => {
      if (entry === `${PREFIX}generated.instructions`)
        return {
          parity: "same",
          resolution: resolution([
            candidate("/home/me/.config/opencode/AGENTS.md", "global", {
              read: "missing",
              filtered: "available",
              why: "filtered: not available (missing)",
            }),
            candidate(`${project}/AGENTS.md`, "project", { selected: true, why: "selected", score: 10 }),
            candidate(`${project}/CLAUDE.md`, "project", {
              why: "lost to AGENTS.md (precedence (name))",
              score: 5,
            }),
          ]),
        }
      if (entry === `${PREFIX}generated.skills`)
        return {
          parity: "differs",
          resolution: resolution([
            candidate("/skills/review/SKILL.md", undefined, { selected: true, why: "selected" }),
          ]),
        }
      return {}
    }
    const section = (type: string, entry: string, layer: Layer, text: string, source: string, automatic = false) => ({
      ...resolutionOf(entry),
      type,
      typeName: typeName(type),
      layer: layer.id,
      layerName: layer.name,
      entry,
      automatic,
      changed: !!override?.slots?.[type],
      source,
      trace: traceOf(entry, layer, source),
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
          (override?.slots?.[type] ?? profile.slots[type] ?? []).flatMap((listed) => {
            const layer = loaded.layers.find((item) => item.id === listed)
            if (!layer) return []
            // A namespace's copy of a built-in works as the built-in.
            const entry = layer.replaces && own(layer.replaces) === layer.id ? layer.replaces : listed
            if (entry === `${PREFIX}slot.base`) return [section(type, entry, layer, base.text, "base.default")]
            if (entry === `${PREFIX}slot.agent`) return own ? [section(type, entry, layer, own, name)] : []
            if (entry === `${PREFIX}slot.agent-or-base`)
              return [
                own ? section(type, entry, layer, own, name) : section(type, entry, layer, base.text, "base.default"),
              ]
            const written = extra[entry]
            if (written) return [section(type, entry, layer, written.text, written.source)]
            if (layer.type === "helper") return [section(type, entry, layer, layer.text, "OpenCode")]
            if (layer.origin !== "user" || (layer.replaces && entry !== layer.replaces)) return []
            if (layer.replaces && layer.delivery) return []
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
      modelSource: url.searchParams.get("provider")
        ? { model: `${url.searchParams.get("provider")}/${url.searchParams.get("model")}`, source: "chosen" }
        : { model: "opencode/claude-opus-4-6", source: "ranking" },
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
    // The purpose generator's draft.
    if (url.pathname === "/operator/prompt/purpose") {
      const input = body as { kind: string; brief?: string }
      return json(route, { text: `A drafted ${input.kind} purpose${input.brief ? ` (${input.brief})` : ""}.` })
    }
    // A Dynamic layer's sample: what it fills in for the agent of the project.
    if (url.pathname === "/operator/prompt/sample") {
      const layer = url.searchParams.get("layer") ?? ""
      const agent = url.searchParams.get("agent") ?? "build"
      // Your Dynamic layers are written by the dynamic generator.
      const own = Object.values(state.items)
        .flatMap((items) => items.layers)
        .find((item) => item.id === layer && item.type === "dynamic")
      if (own)
        return json(route, {
          agent,
          model: "opencode/claude-opus-4-6",
          layer,
          text: `Written from: ${own.prompt}`,
          source: own.name,
          modelSource: { model: "opencode/claude-opus-4-6", source: "ranking" },
          trace: [
            { kind: "dynamic-written", name: own.name },
            { kind: "layer", name: own.name, detail: own.id },
          ],
        })
      const written = generated(url.searchParams.get("directory") ?? "")[layer]
      const base = {
        text: builtinLayers.find((item) => item.id === `${PREFIX}base.default`)!.text,
        source: "base.default",
      }
      const folder = url.searchParams.get("directory") ?? ""
      // triage is a file agent (.opencode/agent/triage.md); build has no prompt of its own.
      const triage = agent === "triage" && (layer === `${PREFIX}slot.agent` || layer === `${PREFIX}slot.agent-or-base`)
      const found = triage
        ? { text: "Triage issues.", source: "triage" }
        : (written ??
          (layer === `${PREFIX}slot.base` || layer === `${PREFIX}slot.agent-or-base` ? base : { text: "", source: "" }))
      const base_ = [
        { kind: "model-rule", name: "opencode/claude-opus-4-6", detail: "no other rule matches" },
        { kind: "builtin-layer", name: "base.default", detail: `${PREFIX}base.default` },
        { kind: "file", path: "packages/opencode/src/session/prompt/default.txt" },
      ]
      const traces: Record<string, unknown[]> = {
        [`${PREFIX}generated.environment`]: [{ kind: "written" }],
        [`${PREFIX}generated.instructions`]: [{ kind: "instruction-file", path: `${folder}/AGENTS.md` }],
        [`${PREFIX}slot.base`]: base_,
        [`${PREFIX}slot.agent-or-base`]: [{ kind: "agent-none", name: agent }, ...base_],
        [`${PREFIX}slot.agent`]: [{ kind: "agent-none", name: agent }],
      }
      const trace = triage
        ? [
            { kind: "agent-own", name: "triage" },
            { kind: "agent-file", path: `${folder}/.opencode/agent/triage.md` },
          ]
        : (traces[layer] ?? [])
      return json(route, {
        agent,
        model: "opencode/claude-opus-4-6",
        layer,
        ...found,
        modelSource: { model: "opencode/claude-opus-4-6", source: "ranking" },
        trace,
      })
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
      const input = body as {
        directory?: string
        name?: string
        git?: boolean
        namespace?: string
        from?: string
        sessions?: boolean
      }
      // A new project at <namespace folder>/<name>; a folder given joins the namespace whose folder holds it.
      const target = listed().find((item) => item.id === (input.namespace ?? "opencode"))
      const directory = input.directory ?? `${target ? place(target).folder : ""}/${input.name}`
      const byLocation = listed()
        .map((item) => ({ id: item.id, folder: place(item).folder }))
        .filter((item) => item.folder && (directory === item.folder || directory.startsWith(`${item.folder}/`)))
        .toSorted((a, b) => b.folder.length - a.folder.length)[0]?.id
      const namespace =
        input.namespace ?? (input.from ? state.projects[input.from]?.namespace : undefined) ?? byLocation ?? "opencode"
      state.projects[directory] = { namespace }
      return json(route, {
        project: { key: directory, name: nameOf(directory), namespace, registered: true },
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
            ...(!setting.flag && notInPlace(key, setting.namespace) ? { flag: "not-in-place" } : {}),
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

    if (url.pathname === "/operator/layout/plan") {
      state.moves.push({ path: url.pathname, body })
      const input = body as { kind: string; project?: string; namespace: string; name?: string }
      // The upgrade: every namespace not at <working directory>/<id>.
      if (input.kind === "upgrade") {
        planned = listed()
          .filter((item) => !place(item).inPlace)
          .map((item, index) => ({
            id: `mi_${index + 1}`,
            kind: "namespace",
            name: item.id,
            from: place(item).folder,
            to: place(item).target,
            namespace: item.id,
          }))
        return json(route, {
          id: "mp_1",
          kind: "upgrade",
          items: planned.map((item) => ({ ...item, sessions: 0, blockers: [] })),
        })
      }
      const namespace = listed().find((item) => item.id === input.namespace)
      if (!namespace) return json(route, { name: "OperatorLayoutError", data: { message: "No namespace" } }, 400)
      const where = place(namespace)
      planned =
        input.kind === "project"
          ? [
              {
                id: "mi_1",
                kind: "project",
                name: input.project!.split("/").at(-1)!,
                from: input.project!,
                to: `${where.folder}/${input.name ?? input.project!.split("/").at(-1)}`,
                namespace: namespace.id,
              },
            ]
          : [
              {
                id: "mi_1",
                kind: "namespace",
                name: namespace.id,
                from: where.folder,
                to: where.target,
                namespace: namespace.id,
              },
            ]
      return json(route, {
        id: "mp_1",
        kind: input.kind,
        items: planned.map((item) => ({
          ...item,
          sessions: 2,
          size: 4096,
          ...(state.moveAgents ? { agents: state.moveAgents } : {}),
          blockers: state.moveBlockers ?? [],
        })),
      })
    }
    if (url.pathname === "/operator/layout/move") {
      state.moves.push({ path: url.pathname, body })
      const input = body as { plan: string; items: string[] }
      const chosen = planned.filter((item) => input.items.includes(item.id))
      for (const item of chosen) {
        if (item.kind === "project")
          state.projects[item.from] = { ...state.projects[item.from]!, namespace: item.namespace }
        else {
          const namespace = state.namespaces.find((entry) => entry.id === item.namespace)
          if (namespace) namespace.folder = item.to
        }
      }
      state.upgrade = { ...state.upgrade, waiting: false }
      return json(route, {
        id: "mv_1",
        plan: input.plan,
        status: chosen.length ? "done" : "failed",
        moved: chosen.map((item) => ({
          item: item.id,
          name: item.name,
          from: item.from,
          to: item.to,
          sessions: 2,
          ...(state.moveAgents ? { agents: state.moveAgents } : {}),
        })),
        skipped: [],
        byHand: [],
        startedAt: 1,
        finishedAt: 2,
      })
    }
    if (url.pathname === "/operator/layout/upgrade/later") {
      state.upgrade = { ...state.upgrade, waiting: false }
      return json(route, true)
    }
    if (url.pathname === "/operator/layout" || url.pathname === "/operator/layout/working-dir") {
      if (method === "PUT") {
        if (state.workingDir) return json(route, { name: "OperatorLayoutError", data: { message: "Already set" } }, 400)
        const folder = String(body?.workingDir ?? "")
        if (!folder.startsWith("/"))
          return json(route, { name: "OperatorLayoutError", data: { message: "Must be absolute" } }, 400)
        state.workingDir = folder
      }
      return json(route, {
        ...(state.workingDir ? { workingDir: state.workingDir } : {}),
        merged: !state.workingDir,
        namespaces: listed().map((namespace) => ({
          id: namespace.id,
          name: namespace.name,
          ...place(namespace),
          inheritGlobal: place(namespace).global || namespace.inheritGlobal !== false,
        })),
        flagged: Object.entries(state.projects).flatMap(([key, setting]) =>
          setting.flag ? [{ project: key, name: nameOf(key), namespace: setting.namespace, flag: setting.flag }] : [],
        ),
        upgrade: { ...state.upgrade, namespaces: 0, projects: 0 },
      })
    }

    if (url.pathname === "/operator/namespace-folder") {
      const name = url.searchParams.get("name") ?? ""
      if (!state.workingDir) return invalid(route, "Set a working directory first: namespaces live in it.")
      const id = free(state.namespaces, name)
      return json(route, { id, folder: `${state.workingDir}/${id}`, exists: false, empty: true })
    }

    const parts = url.pathname.slice("/operator/namespaces".length).split("/").filter(Boolean).map(decodeURIComponent)
    if (parts.length === 0) {
      if (method === "GET") return json(route, listed().map(summary))
      // A new namespace lives at <working directory>/<id>: its record names no folder.
      const name = String(body?.name ?? "")
      if (!state.workingDir) return invalid(route, "Set a working directory first: namespaces live in it.")
      const namespace = {
        id: free(state.namespaces, name),
        name,
        purpose: String(body?.purpose ?? ""),
        ...(body?.inheritGlobal === false ? { inheritGlobal: false } : {}),
        createdAt: 1,
        updatedAt: 1,
      }
      state.namespaces.push(namespace)
      state.items[namespace.id] = structuredClone(state.items.opencode!)
      return json(route, namespace)
    }
    const [ns, kind, id, action] = parts as [string, string?, string?, string?]
    const namespace = listed().find((item) => item.id === ns)
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
      // An empty string clears a choice.
      if (namespace.defaultProject === "") delete namespace.defaultProject
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

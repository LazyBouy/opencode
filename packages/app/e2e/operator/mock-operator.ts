import type { Page, Route } from "@playwright/test"

// Responses for the fork's operator endpoints, layered over mockOpenCodeServer (later routes win).

export const directory = "C:/OpenCode/SmokeProject"
export const now = Date.now()

export const sessions = [
  {
    id: "ses_op_1",
    slug: "fix-parser",
    projectID: "proj_smoke_timeline",
    directory,
    title: "Fix the parser",
    agent: "build",
    version: "1",
    cost: 0.42,
    tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
    model: { id: "claude-opus-4-6", providerID: "opencode" },
    time: { created: now - 3_600_000, updated: now - 600_000 },
    project: { id: "proj_smoke_timeline", name: "smoke-project", worktree: directory },
  },
  {
    id: "ses_op_2",
    slug: "plan-release",
    projectID: "proj_smoke_timeline",
    directory,
    title: "Plan the release",
    agent: "plan",
    version: "1",
    cost: 0,
    time: { created: now - 7_200_000, updated: now - 1_800_000 },
    project: { id: "proj_smoke_timeline", name: "smoke-project", worktree: directory },
  },
]

const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10)
const totals = (sessions: number, cost: number) => ({
  sessions,
  projects: 1,
  cost,
  tokens: { input: 12_000, output: 3_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
})

export const stats = {
  all: totals(40, 12.5),
  range: totals(12, 3.25),
  activeToday: 3,
  agents: [
    { agent: "build", sessions: 9, cost: 3, lastUsed: now - 600_000 },
    { agent: "plan", sessions: 3, cost: 0.25, lastUsed: now - 1_800_000 },
  ],
  days: Array.from({ length: 14 }, (_, index) => ({
    day: day(13 - index),
    sessions: index % 3,
    cost: index / 10,
    tokens: index * 100,
  })),
}

export const agents = [
  {
    name: "build",
    description: "Default agent for building",
    mode: "primary",
    native: true,
    permission: [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "ask" },
    ],
    options: {},
    source: { kind: "builtin", customized: true },
    disabled: false,
    settings: { temperature: 0.1 },
    sessions: { total: 9, lastUsed: now - 600_000 },
  },
  {
    name: "reviewer",
    description: "Reviews diffs",
    mode: "subagent",
    permission: [],
    options: {},
    prompt: "Review the diff carefully.",
    model: { providerID: "opencode", modelID: "claude-opus-4-6" },
    source: { kind: "file", path: `${directory}/.opencode/agents/reviewer.md`, customized: false },
    home: "/work/reviews",
    disabled: false,
    settings: { description: "Reviews diffs", mode: "subagent", prompt: "Review the diff carefully." },
    sessions: { total: 0 },
  },
  {
    name: "title",
    mode: "primary",
    native: true,
    hidden: true,
    permission: [],
    options: {},
    source: { kind: "builtin", customized: false },
    disabled: false,
    settings: {},
    sessions: { total: 0 },
  },
]

export const identityLayers = [
  {
    scope: "global",
    file: "company.md",
    path: "/home/me/.config/opencode/identity/company.md",
    name: "Company",
    kind: "org",
    priority: 50,
    enabled: true,
    content: "We build editors.",
  },
  {
    scope: "project",
    file: "repo.md",
    path: `${directory}/.opencode/identity/repo.md`,
    name: "Repo",
    kind: "project",
    priority: 10,
    enabled: true,
    content: "This repo uses Bun.",
  },
  {
    scope: "project",
    file: "style.md",
    path: `${directory}/.opencode/identity/style.md`,
    name: "Style",
    kind: "project",
    priority: 20,
    agents: ["build"],
    enabled: true,
    content: "Use tabs.",
  },
]

export const pendingRequest = {
  directory,
  time: now - 120_000,
  request: {
    id: "per_op_1",
    sessionID: "ses_op_1",
    permission: "bash",
    patterns: ["git push origin main"],
    metadata: {},
    always: ["git push *"],
  },
}

export const workspace = "/workspace"

export const promptCatalog = {
  prompts: [
    { id: "base", kind: "base", builtin: "" },
    { id: "base.anthropic", kind: "base", builtin: "You are OpenCode, the best coding agent on the planet." },
    { id: "base.default", kind: "base", builtin: "You are opencode, an interactive CLI tool.", global: "Be terse." },
    { id: "reminder.plan", kind: "reminder", builtin: "Plan mode is active. Do not edit files." },
    { id: "notice.max-steps", kind: "notice", builtin: "Maximum steps reached.", project: "" },
  ],
  tools: [
    { id: "read", builtin: "Reads a file from the local filesystem.", project: "Reads files." },
    { id: "bash", builtin: "Runs a shell command." },
  ],
  toggles: { environment: true, skills: true, mcp: true },
  folders: { global: "/home/me/.config/opencode/prompts", project: `${directory}/.opencode/prompts` },
}

const section = (
  groupName: string,
  groupType: string,
  layerName: string,
  fields: { layer: string; section: string; text: string; source?: string; mandatory?: boolean; overrides?: string },
) => ({
  group: `builtin.${groupType}`,
  groupName,
  groupType,
  entry: fields.layer,
  layerName,
  source: "generated",
  mandatory: false,
  message: ["purpose", "identity", "role", "platform"].includes(groupType) ? 1 : 2,
  ...fields,
})

export const promptPreview = {
  agent: "build",
  model: "opencode/claude-opus-4-6",
  base: "base.default",
  project: { key: "opencode", name: "OpenCode" },
  profile: { id: "default", name: "Default" },
  mode: "profile",
  sections: [
    section("Purpose", "purpose", "Terse", {
      layer: "terse",
      section: "base",
      overrides: "base.default",
      text: "Be terse.",
      source: "terse",
      mandatory: true,
    }),
    section("Identity", "identity", "voice", { layer: "file-voice", section: "identity", text: "We build editors." }),
    section("Environment", "custom", "Environment", {
      layer: "generated.environment",
      section: "generated",
      text: "You are powered by the model named Claude Opus 4.6.\n<env>\n  Working directory: /repo\n</env>",
    }),
    section("Project instructions", "custom", "Instructions", {
      layer: "generated.instructions",
      section: "generated",
      text: `Instructions from: ${directory}/AGENTS.md\nUse Bun.`,
      source: `${directory}/AGENTS.md`,
    }),
    section("Capabilities", "capabilities", "Skills", {
      layer: "generated.skills",
      section: "generated",
      text: "<available_skills>\n  <skill>review</skill>\n</available_skills>",
    }),
  ],
  system: ["Be terse.\nWe build editors.", "You are powered by the model named Claude Opus 4.6."],
}

export const memoryOverview = {
  files: [
    {
      kind: "instructions",
      scope: "project",
      path: `${directory}/AGENTS.md`,
      size: 1536,
      modified: now - 600_000,
      loaded: "always",
      editable: true,
    },
    {
      kind: "nested",
      scope: "project",
      path: `${directory}/packages/web/AGENTS.md`,
      size: 200,
      modified: now - 86_400_000,
      loaded: "when-reading",
      editable: true,
    },
    {
      kind: "skill",
      scope: "global",
      path: "/home/me/.config/opencode/skills/review/SKILL.md",
      size: 900,
      loaded: "on-demand",
      editable: true,
    },
    { kind: "url", scope: "project", path: "https://example.com/rules.md", loaded: "always", editable: false },
  ],
  creatable: [{ scope: "global", path: "/home/me/.config/opencode/AGENTS.md" }],
  database: {
    path: "/home/me/.local/share/opencode/opencode.db",
    size: 5 * 1024 * 1024,
    tables: [
      { name: "message", rows: 120 },
      { name: "part", rows: 900 },
      { name: "session", rows: 12 },
    ],
  },
  summaries: [
    {
      sessionID: "ses_op_1",
      title: "Fix the parser",
      time: now - 600_000,
      text: "We fixed the tokenizer and added tests.",
    },
  ],
}

export interface OperatorMock {
  readonly replies: Array<{ url: string; body: unknown }>
  readonly writes: Array<{ url: string; body: unknown }>
  readonly connects: string[]
  readonly sessionQueries: URLSearchParams[]
  readonly agentWrites: Array<{ method: string; url: string; body: unknown }>
  readonly identityWrites: Array<{ method: string; url: string; body: unknown }>
  readonly sessionCreates: Array<{ url: string; body: unknown }>
  readonly promptWrites: Array<{ method: string; url: string; body: unknown }>
  readonly folderWrites: Array<{ url: string; body: unknown }>
  readonly memoryWrites: Array<{ url: string; body: unknown }>
  readonly projectsOpened: string[]
  readonly folders: Set<string>
  pending: (typeof pendingRequest)[]
  rejectWrite?: string
}

export async function mockOperator(page: Page) {
  const state: OperatorMock = {
    replies: [],
    writes: [],
    connects: [],
    sessionQueries: [],
    agentWrites: [],
    identityWrites: [],
    sessionCreates: [],
    promptWrites: [],
    folderWrites: [],
    memoryWrites: [],
    projectsOpened: [],
    folders: new Set([`${workspace}/apps`, `${workspace}/site`]),
    pending: [pendingRequest],
  }
  const repositories = new Set([`${workspace}/site`])
  const listing = (path: string) => ({
    path,
    root: workspace,
    ...(path === workspace ? {} : { parent: path.slice(0, path.lastIndexOf("/")) || "/" }),
    project: repositories.has(path),
    folders: [...state.folders]
      .filter((folder) => folder.slice(0, folder.lastIndexOf("/")) === path)
      .sort()
      .map((folder) => ({ name: folder.slice(path.length + 1), path: folder, project: repositories.has(folder) })),
  })
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

  await page.route("**/operator/**", (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/operator/status")
      return json(route, { version: "1.18.34-fork", startedAt: now - 7_200_000, platform: "linux", arch: "x64" })
    if (url.pathname === "/operator/stats") return json(route, stats)
    if (url.pathname === "/operator/permission") return json(route, state.pending)
    if (url.pathname === "/operator/project")
      return json(route, [
        {
          id: "proj_smoke_timeline",
          name: "smoke-project",
          worktree: directory,
          vcs: "git",
          global: false,
          sessions: 2,
          cost: 0.42,
          lastActivity: now - 600_000,
          created: now - 86_400_000,
        },
        {
          id: "global",
          worktree: "/",
          global: true,
          sessions: 1,
          cost: 0.03,
          lastActivity: now - 3_600_000,
          created: now - 86_400_000,
        },
      ])
    if (url.pathname === "/operator/session") {
      state.sessionQueries.push(url.searchParams)
      const search = url.searchParams.get("search")?.toLowerCase()
      return json(
        route,
        sessions.filter((session) => !search || session.title.toLowerCase().includes(search)),
      )
    }
    if (url.pathname.startsWith("/operator/agent") && method !== "GET") {
      state.agentWrites.push({ method, url: url.toString(), body: route.request().postDataJSON() })
      return json(route, { path: `${directory}/.opencode/agents/new.md` })
    }
    if (url.pathname === "/operator/agent") return json(route, agents)
    if (url.pathname === "/operator/identity") return json(route, identityLayers)
    if (url.pathname === "/operator/identity/preview")
      return json(route, {
        text:
          url.searchParams.get("agent") === "build"
            ? "We build editors.\n\nThis repo uses Bun.\n\nUse tabs."
            : "We build editors.\n\nThis repo uses Bun.",
      })
    if (url.pathname.startsWith("/operator/identity/")) {
      state.identityWrites.push({ method, url: url.toString(), body: route.request().postDataJSON() })
      if (url.pathname === "/operator/identity/reorder") return json(route, identityLayers)
      if (method === "DELETE") return json(route, true)
      return json(route, identityLayers[1])
    }
    if (url.pathname === "/operator/tool")
      return json(route, [
        { id: "read", description: "Read a file", origin: "builtin" },
        { id: "hello", description: "Say hello", origin: "custom", source: `${directory}/.opencode/tools/hello.ts` },
        { id: "docs_search", description: "Search the docs", origin: "mcp", source: "docs" },
      ])
    if (url.pathname === "/operator/config/layer")
      return json(route, {
        sources: [
          { kind: "global", path: "/home/me/.config/opencode/opencode.jsonc", text: '{ "theme": "iphi" }' },
          { kind: "directory", path: `${directory}/.opencode/opencode.jsonc`, text: '{\n  "username": "me"\n}\n' },
        ],
        targets: {
          global: "/home/me/.config/opencode/opencode.jsonc",
          project: `${directory}/.opencode/opencode.jsonc`,
        },
      })
    if (url.pathname === "/operator/config/raw" && method === "PUT") {
      state.writes.push({ url: url.toString(), body: route.request().postDataJSON() })
      if (state.rejectWrite)
        return json(
          route,
          {
            name: "OperatorConfigInvalidError",
            data: { path: `${directory}/.opencode/opencode.jsonc`, message: state.rejectWrite },
          },
          400,
        )
      return json(route, { path: `${directory}/.opencode/opencode.jsonc`, changed: true })
    }
    if (url.pathname === "/operator/config" && method === "PATCH") {
      state.writes.push({ url: url.toString(), body: route.request().postDataJSON() })
      return json(route, { path: `${directory}/.opencode/opencode.jsonc`, changed: true })
    }
    if (url.pathname === "/operator/prompt") return json(route, promptCatalog)
    if (url.pathname === "/operator/prompt/preview") {
      // An agent with its own prompt sends it instead of the base prompt.
      const own = (
        agents.find((agent) => agent.name === url.searchParams.get("agent")) as { prompt?: string } | undefined
      )?.prompt
      return json(route, {
        ...promptPreview,
        agent: url.searchParams.get("agent"),
        sections: [
          ...promptPreview.sections.slice(0, 2),
          ...(own
            ? [section("Identity", "identity", "Agent prompt", { layer: "slot.agent", section: "identity", text: own })]
            : []),
          ...promptPreview.sections.slice(2),
        ],
      })
    }
    if (url.pathname.startsWith("/operator/prompt/")) {
      state.promptWrites.push({ method, url: url.toString(), body: route.request().postDataJSON() })
      return json(route, true)
    }
    if (url.pathname === "/operator/folder/roots") return json(route, [workspace])
    if (url.pathname === "/operator/folder" && method === "GET")
      return json(route, listing(url.searchParams.get("path") ?? workspace))
    if (url.pathname === "/operator/folder" && method === "POST") {
      const body = route.request().postDataJSON() as { parent: string; name: string; git?: boolean }
      state.folderWrites.push({ url: url.toString(), body })
      const created = `${body.parent}/${body.name}`
      state.folders.add(created)
      if (body.git) repositories.add(created)
      return json(route, { path: created })
    }
    if (url.pathname === "/operator/folder/init") {
      const body = route.request().postDataJSON() as { path: string }
      state.folderWrites.push({ url: url.toString(), body })
      repositories.add(body.path)
      return json(route, { path: body.path })
    }
    if (url.pathname === "/operator/memory/overview") return json(route, memoryOverview)
    if (url.pathname === "/operator/memory/file" && method === "GET")
      return json(route, { path: url.searchParams.get("path"), text: "# Project rules\nUse Bun.\n" })
    if (url.pathname === "/operator/memory/file") {
      state.memoryWrites.push({ url: url.toString(), body: route.request().postDataJSON() })
      return json(route, true)
    }
    return route.fallback()
  })

  await page.route("**/project/current*", (route) => {
    const opened = new URL(route.request().url()).searchParams.get("directory")
    if (!opened?.startsWith(workspace)) return route.fallback()
    state.projectsOpened.push(opened)
    return json(route, {
      id: "proj_new",
      worktree: opened,
      vcs: "git",
      time: { created: now, updated: now },
      sandboxes: [],
    })
  })

  await page.route("**/session/*/children*", (route) =>
    json(route, [
      {
        ...sessions[1],
        id: "ses_op_child",
        parentID: "ses_smoke_target",
        title: "Explore the codebase",
        agent: "explore",
      },
    ]),
  )
  await page.route(
    (url) => url.pathname === "/session",
    (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      state.sessionCreates.push({ url: route.request().url(), body: route.request().postDataJSON() })
      return json(route, { ...sessions[0], id: "ses_op_new", title: "New session" })
    },
  )
  await page.route("**/permission/*/reply*", (route) => {
    state.replies.push({ url: route.request().url(), body: route.request().postDataJSON() })
    state.pending = []
    return json(route, true)
  })
  await page.route(
    (url) => url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"),
    (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === "/mcp") return json(route, { docs: { status: "disabled" } })
      if (url.pathname.endsWith("/connect")) {
        state.connects.push(url.pathname)
        return json(route, true)
      }
      return route.fallback()
    },
  )
  await page.route("**/skill*", (route) =>
    json(route, [
      {
        name: "release-notes",
        description: "Write release notes",
        location: `${directory}/.opencode/skills/release-notes/SKILL.md`,
        content: "",
      },
    ]),
  )
  await page.route("**/command*", (route) =>
    new URL(route.request().url()).pathname === "/command"
      ? json(route, [{ name: "review", description: "Review changes", template: "Review $ARGUMENTS", hints: [] }])
      : route.fallback(),
  )
  await page.route("**/config/providers*", (route) =>
    json(route, {
      providers: [
        {
          id: "opencode",
          name: "OpenCode",
          source: "api",
          env: [],
          options: {},
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              providerID: "opencode",
              name: "Claude Opus 4.6",
              api: { id: "claude-opus-4-6", url: "", npm: "" },
              capabilities: {
                temperature: true,
                reasoning: true,
                attachment: true,
                toolcall: true,
                input: { text: true, audio: false, image: true, video: false, pdf: true },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              cost: { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } },
              limit: { context: 200_000, output: 32_000 },
              status: "active",
              options: {},
              headers: {},
              release_date: "2026-02-01",
            },
          },
        },
      ],
      default: { opencode: "claude-opus-4-6" },
    }),
  )
  return state
}

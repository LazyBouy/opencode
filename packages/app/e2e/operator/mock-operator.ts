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

export interface OperatorMock {
  readonly replies: Array<{ url: string; body: unknown }>
  readonly writes: Array<{ url: string; body: unknown }>
  readonly connects: string[]
  readonly sessionQueries: URLSearchParams[]
  readonly agentWrites: Array<{ method: string; url: string; body: unknown }>
  readonly identityWrites: Array<{ method: string; url: string; body: unknown }>
  readonly sessionCreates: Array<{ url: string; body: unknown }>
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
    pending: [pendingRequest],
  }
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
    return route.fallback()
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

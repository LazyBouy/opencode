import type { Page, Route } from "@playwright/test"
import { createPromptMock, type PromptMock } from "./mock-namespaces"
import { callFor, callsFor, rawFor } from "./mock-calls"
import { draftFor, lastFor, permissionsFor, sessionPermissionsFor, toolPromptFor } from "./mock-tool-prompt"

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
    modelSource: { model: "opencode/claude-opus-4-6", source: "ranking" },
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
    modelSource: {
      model: "opencode/claude-opus-4-6",
      source: "agent",
      path: `${directory}/.opencode/agents/reviewer.md`,
    },
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
  {
    name: "triage",
    mode: "primary",
    hidden: true,
    permission: [],
    options: {},
    prompt: "Triage issues.",
    source: { kind: "file", path: `${directory}/.opencode/agent/triage.md`, customized: false },
    disabled: false,
    settings: { mode: "primary", hidden: true, prompt: "Triage issues." },
    sessions: { total: 0 },
    modelSource: {
      model: "opencode/claude-opus-4-6",
      source: "ranking",
      agent: { model: "opencode/gpt-6-luna", path: `${directory}/.opencode/agent/triage.md` },
    },
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
    metadata: { command: "git push origin main" },
    always: ["git push *"],
  },
  session: { title: "Fix the parser", agent: "build" },
  project: { key: directory, namespace: "opencode" },
  askedBy: {
    permission: "*",
    pattern: "*",
    action: "ask",
    index: 1,
    part: "opencode",
    from: { kind: "opencode-default" },
  },
  agentTarget: { builtin: true },
}

export const workspace = "/workspace"
// A folder outside git where a session ran.
export const notes = "/home/me/notes"

export const promptCatalog = {
  tools: [
    { id: "read", builtin: "Reads a file from the local filesystem." },
    { id: "bash", builtin: "Runs a shell command." },
  ],
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

export type CapabilityItem = {
  kind: string
  name: string
  description?: string
  origin: string
  location: string
  state: string
  hides: Array<{ origin: string; location: string }>
  disabledAt?: { origin: string; location: string }
}

// Short-term memory for the Memory page's Memory and Settings tabs.
type MemoryEntry = { title: string; file: string; description: string; line: number; updated?: string; by?: string }
type MemoryLevel = {
  level: "namespace" | "project" | "agent"
  folder: string
  exists: boolean
  entries: MemoryEntry[]
  invalid: Array<{ line: number; text: string }>
  unindexed: string[]
  lines: number
  chars: number
}
export type MemoryMock = {
  instructions: boolean
  levels: MemoryLevel[]
  content: Record<string, string>
  settings: {
    commit: boolean
    indexLines: number
    indexChars: number
    projects: Array<{
      key: string
      name: string
      override?: boolean
      commits: boolean
      repo?: string
      excluded?: boolean
    }>
  }
  writes: Array<{ method: string; path: string; body: unknown }>
}
function memoryMock(): MemoryMock {
  const level = (name: MemoryLevel["level"], folder: string, entries: MemoryEntry[]): MemoryLevel => ({
    level: name,
    folder,
    exists: entries.length > 0,
    entries,
    invalid: [],
    unindexed: [],
    lines: entries.length,
    chars: entries.reduce(
      (total, item) => total + item.title.length + item.file.length + item.description.length + 9,
      0,
    ),
  })
  return {
    instructions: true,
    levels: [
      level("namespace", "/home/me/.config/opencode/.memory", [
        {
          title: "Org conventions",
          file: "org-conventions.md",
          description: "How we name things",
          line: 1,
          by: "user",
        },
      ]),
      {
        ...level("project", `${directory}/.memory`, [
          {
            title: "Release checklist",
            file: "release-checklist.md",
            description: "Steps before tagging a release",
            line: 1,
            updated: new Date(now - 3_600_000).toISOString(),
            by: "agent build · session ses_op_1",
          },
        ]),
        invalid: [{ line: 2, text: "A note by hand" }],
        unindexed: ["orphan.md"],
      },
      level("agent", `${directory}/.memory/agents/build`, []),
    ],
    content: { "project/release-checklist.md": "1. Run the tests\n2. Tag" },
    settings: {
      commit: false,
      indexLines: 200,
      indexChars: 25000,
      projects: [{ key: directory, name: "smoke-project", commits: false, repo: directory, excluded: true }],
    },
    writes: [],
  }
}
function memoryRoute(memory: MemoryMock, url: URL, method: string, body: () => unknown) {
  const query = (key: string) => url.searchParams.get(key) ?? ""
  const find = (name: string) => memory.levels.find((item) => item.level === name)
  if (url.pathname === "/operator/memory/levels")
    return {
      body: {
        project: directory,
        namespace: { id: "opencode", name: "OpenCode" },
        instructions: memory.instructions,
        agent: query("agent") || "build",
        limits: { lines: memory.settings.indexLines, chars: memory.settings.indexChars },
        levels: memory.levels,
      },
    }
  if (url.pathname === "/operator/memory/settings") {
    if (method === "GET") return { body: memory.settings }
    const input = body() as {
      commit?: boolean
      indexLines?: number
      indexChars?: number
      project?: { key: string; commit: boolean | null }
    }
    memory.writes.push({ method, path: url.pathname, body: input })
    Object.assign(memory.settings, {
      ...(input.commit !== undefined ? { commit: input.commit } : {}),
      ...(input.indexLines !== undefined ? { indexLines: input.indexLines } : {}),
      ...(input.indexChars !== undefined ? { indexChars: input.indexChars } : {}),
    })
    if (input.project)
      memory.settings.projects = memory.settings.projects.map((item) =>
        item.key === input.project!.key
          ? {
              ...item,
              override: input.project!.commit ?? undefined,
              commits: input.project!.commit ?? memory.settings.commit,
            }
          : item,
      )
    return { body: memory.settings }
  }
  if (url.pathname === "/operator/memory/index" && method === "PUT") {
    const input = body() as { level: string; text: string }
    memory.writes.push({ method, path: url.pathname, body: input })
    return { body: find(input.level) }
  }
  if (url.pathname !== "/operator/memory/entry") return undefined
  if (method === "GET") {
    const level = find(query("level"))
    const entry = level?.entries.find((item) => item.file === query("file"))
    if (!level || !entry)
      return { body: { name: "OperatorMemoryInvalidError", data: { message: "No such memory" } }, status: 400 }
    return {
      body: {
        level: level.level,
        file: entry.file,
        path: `${level.folder}/${entry.file}`,
        title: entry.title,
        description: entry.description,
        ...(entry.updated ? { updated: entry.updated } : {}),
        ...(entry.by ? { by: entry.by } : {}),
        content: memory.content[`${level.level}/${entry.file}`] ?? "",
      },
    }
  }
  if (method === "DELETE") {
    memory.writes.push({ method, path: url.pathname, body: { level: query("level"), file: query("file") } })
    const level = find(query("level"))
    if (level) level.entries = level.entries.filter((item) => item.file !== query("file"))
    return { body: true }
  }
  const input = body() as { level: string; file?: string; title: string; description: string; content: string }
  memory.writes.push({ method, path: url.pathname, body: input })
  const level = find(input.level)!
  const file =
    input.file ??
    `${input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}.md`
  const entry = { title: input.title, file, description: input.description, line: level.entries.length + 1, by: "user" }
  level.entries = input.file
    ? level.entries.map((item) => (item.file === file ? { ...item, ...entry, line: item.line } : item))
    : [...level.entries, entry]
  memory.content[`${input.level}/${file}`] = input.content
  return {
    body: {
      level: input.level,
      file,
      path: `${level.folder}/${file}`,
      title: input.title,
      description: input.description,
      by: "user",
      content: input.content,
    },
  }
}

export interface OperatorMock {
  readonly replies: Array<{ url: string; body: unknown }>
  readonly writes: Array<{ url: string; body: unknown }>
  readonly connects: string[]
  readonly sessionQueries: URLSearchParams[]
  readonly agentWrites: Array<{ method: string; url: string; body: unknown }>
  readonly sessionCreates: Array<{ url: string; body: unknown }>
  readonly folderWrites: Array<{ url: string; body: unknown }>
  readonly memoryWrites: Array<{ url: string; body: unknown }>
  /** Short-term memory: the three levels, the writes to them, and the settings (memory_spec.md §8). */
  readonly memory: MemoryMock
  readonly projectsOpened: string[]
  readonly folders: Set<string>
  readonly prompt: PromptMock
  pending: (typeof pendingRequest)[]
  // The reply card's decisions, and the decisions recorded.
  decides: Array<{ id: string; body: Record<string, unknown> }>
  // Agents' locked rules, and every change to them.
  locks: Record<
    string,
    {
      locks: Array<{ permission: string; pattern: string }>
      inherit: "own" | "parent"
      deleted?: Array<{ permission: string; pattern: string }>
    }
  >
  lockWrites: Array<{ agent: string; body: unknown }>
  decisions: Array<Record<string, unknown>>
  rejectWrite?: string
  // The project's config (global_and_opencode_namespaces_spec.md §7): its own, or OpenCode's.
  projectConfig: {
    mode: "own" | "namespace"
    text: string
    tracked: boolean
    copy?: { namespace: string; name: string; copiedAt: number; changedSince: boolean }
  }
  // Each namespace's config text (none: no config yet).
  namespaceConfigs: Record<string, string | undefined>
  // Trash: what is in it, and every call to it.
  trash: Array<{
    id: string
    kind: string
    name: string
    deletedAt: number
    files: { path: string; stored: string }[]
    project?: string
  }>
  trashWrites: Array<{ method: string; path: string; body: unknown; directory?: string }>
  // A reason the next move to Trash fails with.
  trashFail?: string
  // The capabilities by scope (/operator/capability) and the actions taken on them.
  capabilities: CapabilityItem[]
  capabilityWrites: Array<{ action: string; body: Record<string, unknown>; directory?: string }>
  toolPromptQueries: URLSearchParams[]
  permissionWrites: Array<{ agent: string; body: { scope: string; rules: Array<Record<string, string>> } }>
  ownRules: Record<string, Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>>
  drafts: unknown[]
  projectRecordWrites: Array<Record<string, unknown>>
  mainSessions: Record<string, string>
  mainWrites: Array<{ agent: string; sessionID: string }>
  mainOpens: Array<{ agent: string; directory: string | null }>
  targets: Record<string, "main" | "active">
  queue: Array<Record<string, unknown> & { id: string; agent: string; status: string }>
  queueSends: Array<Record<string, unknown>>
  projectRecords: Record<string, Record<string, unknown>>
  sessionPermissionWrites: Array<{
    sessionID: string
    body: { rules: Array<Record<string, string>>; deleted?: Array<{ permission: string; pattern: string }> }
  }>
  sessionDeleted: Record<string, Array<{ permission: string; pattern: string }>>
  // Namespace and project permission levels, and every save.
  levels: Partial<Record<"namespace" | "project", Level>>
  levelWrites: Array<{ level: "namespace" | "project"; body: Level }>
  sessionRules: Record<
    string,
    Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny"; origin?: string; time?: number }>
  >
}

type Key = { permission: string; pattern: string }
type Line = Key & { action: "allow" | "ask" | "deny" }
type Level = { lines: Line[]; deleted: Key[]; locks: Key[] }
const sameKey = (a: Key, b: Key) => a.permission === b.permission && a.pattern === b.pattern

// The namespace's lines, as rows a project and its agents inherit.
function namespaceRows(state: OperatorMock) {
  const namespace = state.levels.namespace
  return (namespace?.lines ?? []).map((line, index) => ({
    ...line,
    index: index + 1,
    part: "config",
    level: "namespace",
    from: { kind: "config-permission", path: "/work/acme/.opencode/opencode.jsonc" },
    ...(namespace?.locks.some((key) => sameKey(key, line)) ? { locked: "namespace" } : {}),
  }))
}

// A level's view: OpenCode's lines (and the namespace's, for a project), then its own and its marks.
function levelFor(state: OperatorMock, name: "namespace" | "project", namespace = "opencode") {
  const own = state.levels[name] ?? { lines: [], deleted: [], locks: [] }
  const opencode = [
    { permission: "*", pattern: "*", action: "allow" as const },
    { permission: "question", pattern: "*", action: "deny" as const },
    { permission: "read", pattern: "*.env", action: "ask" as const },
  ].map((line) => ({ ...line, part: "opencode", level: "opencode", from: { kind: "opencode-default" } }))
  const inherited = [...opencode, ...(name === "project" ? namespaceRows(state) : [])].map((row, index) => ({
    ...row,
    index: index + 1,
  }))
  const file = name === "project" ? `${directory}/.opencode/opencode.jsonc` : "/work/acme/.opencode/opencode.jsonc"
  const rows = [
    ...inherited
      .filter((row) => !own.deleted.some((key) => sameKey(key, row)))
      .map((row) => {
        const mine = own.lines.find((line) => sameKey(line, row))
        const lined = mine && !("locked" in row) ? { ...row, action: mine.action, level: name } : row
        return own.locks.some((key) => sameKey(key, row)) && !("locked" in row) ? { ...lined, locked: name } : lined
      }),
    ...own.lines
      .filter((line) => !inherited.some((row) => sameKey(row, line)))
      .map((line) => ({
        ...line,
        part: "config",
        level: name,
        from: { kind: "config-permission", path: file },
        ...(own.locks.some((key) => sameKey(key, line)) ? { locked: name } : {}),
      })),
  ].map((row, index) => ({ ...row, index: index + 1 }))
  return {
    level: name,
    namespace,
    ...(name === "project" ? { project: directory } : {}),
    file,
    rows,
    deleted: inherited.filter((row) => own.deleted.some((key) => sameKey(key, row))),
    inherited,
    own: own.lines,
    marks: { deleted: own.deleted, locks: own.locks },
    canDeleteOpenCode: namespace !== "opencode",
    blocked: [],
    forms: { read: "path", edit: "path" },
    known: ["*", "bash", "edit", "read", "webfetch"],
  }
}

export async function mockOperator(page: Page) {
  const prompt = createPromptMock(
    [{ key: directory, name: "smoke-project" }],
    (name) => (agents.find((agent) => agent.name === name) as { prompt?: string } | undefined)?.prompt,
    (folder) => folder === directory || folder.startsWith(`${directory}/`) || folder.startsWith(workspace),
  )
  const state: OperatorMock = {
    replies: [],
    writes: [],
    projectConfig: { mode: "own", text: '{\n  "username": "me"\n}\n', tracked: false },
    namespaceConfigs: { opencode: '{ "model": "opencode/big" }' },
    connects: [],
    sessionQueries: [],
    agentWrites: [],
    sessionCreates: [],
    folderWrites: [],
    memoryWrites: [],
    memory: memoryMock(),
    projectsOpened: [],
    folders: new Set([`${workspace}/apps`, `${workspace}/site`]),
    prompt: prompt.state,
    pending: [pendingRequest],
    decides: [],
    locks: {},
    lockWrites: [],
    decisions: [],
    trash: [],
    trashWrites: [],
    capabilities: [
      { kind: "tool", name: "read", origin: "opencode", location: "<built-in>", state: "inherited", hides: [] },
      {
        kind: "tool",
        name: "hello",
        origin: "project",
        location: `${directory}/.opencode/tools/hello.ts`,
        state: "local",
        hides: [],
      },
      {
        kind: "skill",
        name: "release-notes",
        description: "Write release notes",
        origin: "project",
        location: `${directory}/.opencode/skills/release-notes/SKILL.md`,
        state: "local",
        hides: [],
      },
      { kind: "command", name: "review", origin: "opencode", location: "<built-in>", state: "inherited", hides: [] },
      {
        kind: "command",
        name: "deploy",
        description: "Ship it",
        origin: "namespace",
        location: `${workspace}/.opencode/commands/deploy.md`,
        state: "inherited",
        hides: [],
      },
      {
        kind: "mcp",
        name: "docs",
        origin: "global",
        location: "/home/me/.config/opencode/opencode.jsonc#mcp.docs",
        state: "inherited",
        hides: [],
      },
      { kind: "agent", name: "build", origin: "opencode", location: "<built-in>", state: "inherited", hides: [] },
      {
        kind: "plugin",
        name: "opencode-wakatime",
        origin: "global",
        location: "/home/me/.config/opencode/opencode.jsonc#plugin.opencode-wakatime",
        state: "inherited",
        hides: [],
      },
    ],
    capabilityWrites: [],
    toolPromptQueries: [],
    permissionWrites: [],
    ownRules: {},
    drafts: [],
    sessionPermissionWrites: [],
    sessionRules: {},
    sessionDeleted: {},
    levels: {},
    levelWrites: [],
    projectRecordWrites: [],
    projectRecords: {},
    mainSessions: {},
    mainWrites: [],
    mainOpens: [],
    targets: {},
    queue: [],
    queueSends: [],
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
    if (url.pathname === "/operator/permission/decision") return json(route, state.decisions)
    const decide = url.pathname.match(/^\/operator\/permission\/([^/]+)\/decide$/)
    if (decide && method === "POST") {
      const id = decide[1]!
      const body = route.request().postDataJSON() as Record<string, unknown>
      state.decides.push({ id, body })
      const asked = state.pending.find((item) => item.request.id === id)
      state.pending = state.pending.filter((item) => item.request.id !== id)
      // Allow for session: the patterns become rules of that session (as the server keeps them).
      if (asked && body.decision === "allow-session")
        state.sessionRules[asked.request.sessionID] = [
          ...(state.sessionRules[asked.request.sessionID] ?? []),
          ...((body.patterns as string[] | undefined) ?? asked.request.always).map((pattern) => ({
            permission: asked.request.permission,
            pattern,
            action: "allow" as const,
            origin: "allow",
            time: now,
          })),
        ]
      if (asked)
        state.decisions.unshift({
          requestID: id,
          sessionID: asked.request.sessionID,
          sessionTitle: asked.session.title,
          agent: asked.session.agent,
          directory,
          project: directory,
          namespace: "opencode",
          permission: asked.request.permission,
          patterns: asked.request.patterns,
          metadata: asked.request.metadata,
          askedAt: asked.time,
          decidedAt: now,
          decision: body.decision,
          ...(body.note ? { note: body.note } : {}),
          who: "me",
          via: body.via,
        })
      return json(route, { rules: [], covered: [] })
    }
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
        // Sessions outside git are listed per folder.
        {
          id: `folder:${notes}`,
          name: "notes",
          worktree: notes,
          global: false,
          folder: true,
          sessions: 1,
          cost: 0.03,
          lastActivity: now - 3_600_000,
          created: now - 86_400_000,
        },
        // Folders opened with Add project.
        ...state.projectsOpened.map((opened) => ({
          id: `proj_${opened}`,
          name: opened.split("/").at(-1),
          worktree: opened,
          vcs: "git",
          global: false,
          sessions: 0,
          cost: 0,
          created: now,
        })),
      ])
    if (url.pathname === "/operator/trash" || url.pathname.startsWith("/operator/trash/")) {
      const body = method === "GET" || method === "DELETE" ? null : route.request().postDataJSON()
      if (method !== "GET")
        state.trashWrites.push({
          method,
          path: url.pathname,
          body,
          ...(url.searchParams.get("directory") ? { directory: url.searchParams.get("directory")! } : {}),
        })
      if (state.trashFail && method === "POST" && !url.pathname.endsWith("/restore"))
        return json(route, { name: "OperatorTrashError", data: { message: state.trashFail } }, 400)
      if (method === "GET") return json(route, state.trash)
      if (method === "DELETE" && url.pathname === "/operator/trash") {
        const purged = state.trash.length
        state.trash.length = 0
        return json(route, { purged })
      }
      const id = url.pathname.split("/")[3]
      if (method === "DELETE" || url.pathname.endsWith("/restore")) {
        const entry = state.trash.find((item) => item.id === id)
        state.trash.splice(state.trash.indexOf(entry!), 1)
        return json(route, method === "DELETE" ? true : entry)
      }
      const input = body as { key?: string; sessionID?: string; kind?: string; name?: string }
      const kind = id === "project" ? "project" : id === "session" ? "session" : (input.kind ?? "item")
      const entry = {
        id: `trash-${state.trash.length + 1}`,
        kind,
        name: input.name ?? input.key?.split("/").at(-1) ?? input.sessionID ?? "",
        deletedAt: now,
        files: input.key ? [{ path: input.key, stored: "files/0" }] : [],
        ...(input.key ? { project: input.key } : {}),
        ...(input.sessionID ? { sessions: [input.sessionID] } : {}),
      }
      state.trash.push(entry)
      return json(route, entry)
    }
    if (url.pathname === "/operator/session") {
      state.sessionQueries.push(url.searchParams)
      const search = url.searchParams.get("search")?.toLowerCase()
      const agent = url.searchParams.get("agent")
      return json(
        route,
        sessions.filter(
          (session) => (!search || session.title.toLowerCase().includes(search)) && (!agent || session.agent === agent),
        ),
      )
    }
    if (
      url.pathname.startsWith("/operator/namespaces") ||
      url.pathname.startsWith("/operator/layout") ||
      url.pathname === "/operator/namespace-folder" ||
      url.pathname.startsWith("/operator/project-settings") ||
      url.pathname.startsWith("/operator/agent-prompt/") ||
      url.pathname === "/operator/prompt/preview" ||
      url.pathname === "/operator/prompt/sample" ||
      url.pathname === "/operator/prompt/purpose"
    )
      return prompt.handle(route, url, method)
    const permissions = url.pathname.match(/^\/operator\/agent\/([^/]+)\/permissions$/)
    if (permissions) {
      const name = decodeURIComponent(permissions[1]!)
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { scope: string; rules: Array<Record<string, string>> }
        state.permissionWrites.push({ agent: name, body })
        state.ownRules[name] = body.rules as never
        return json(route, { path: `${directory}/.opencode/opencode.jsonc` })
      }
      return json(route, permissionsFor(directory, name, state.ownRules[name], state.locks[name], namespaceRows(state)))
    }
    const calls = url.pathname.match(/^\/operator\/session\/([^/]+)\/(calls|calls\/export|call\/([^/]+)(\/raw)?)$/)
    if (calls && method === "GET") {
      const id = decodeURIComponent(calls[1]!)
      if (calls[2] === "calls") return json(route, callsFor(id, url.searchParams.get("search")))
      if (calls[2] === "calls/export")
        return json(route, { format: url.searchParams.get("format"), text: "# Transcript\n" })
      const callID = decodeURIComponent(calls[3]!)
      if (calls[4]) return json(route, rawFor(id, callID, url.searchParams.get("part") ?? "request"))
      const found = callFor(id, callID)
      return found
        ? json(route, found)
        : json(route, { name: "OperatorCallNotFoundError", data: { message: "No call" } }, 404)
    }
    if (url.pathname === "/operator/tokenizers")
      return json(route, { folder: "/root/.config/opencode/tokenizers", tokenizers: [], errors: [] })
    if (/^\/operator\/session\/[^/]+\/calls\/recount$/.test(url.pathname)) return json(route, { ok: true })
    // Agents' main and active sessions.
    const sessionState = url.pathname.match(/^\/operator\/agent\/([^/]+)\/(session-state|main|target)$/)
    if (sessionState) {
      const name = decodeURIComponent(sessionState[1]!)
      if (method === "PUT" && sessionState[2] === "target")
        state.targets[name] = (route.request().postDataJSON() as { target: "main" | "active" }).target
      else if (method === "PUT") {
        const body = route.request().postDataJSON() as { sessionID: string }
        state.mainWrites.push({ agent: name, sessionID: body.sessionID })
        if (body.sessionID) state.mainSessions[name] = body.sessionID
        else delete state.mainSessions[name]
      }
      const ref = (id: string | undefined) => {
        const found = sessions.find((session) => session.id === id)
        return found
          ? { id: found.id, title: found.title, directory: found.directory, updated: found.time.updated }
          : undefined
      }
      const main = ref(state.mainSessions[name])
      const active = ref(sessions.find((session) => session.agent === name)?.id)
      return json(route, {
        agent: name,
        target: state.targets[name] ?? "main",
        ...(main ? { main } : {}),
        ...(active ? { active } : {}),
      })
    }
    // Agents' input queues: a message waits, unless it steers (then it is delivered at once).
    const agentQueue = url.pathname.match(/^\/operator\/agent\/([^/]+)\/queue$/)
    if (agentQueue) {
      const name = decodeURIComponent(agentQueue[1]!)
      if (method === "POST") {
        const body = route.request().postDataJSON() as {
          text: string
          target?: string
          sessionID?: string
          priority?: string
          steer?: boolean
        }
        state.queueSends.push({ agent: name, ...body })
        const target = body.target ?? (body.sessionID ? "session" : (state.targets[name] ?? "main"))
        const item = {
          id: `qm_mock_${state.queue.length + 1}`,
          project: directory,
          agent: name,
          target,
          ...(body.sessionID ? { sessionID: body.sessionID } : {}),
          text: body.text,
          priority: body.priority ?? "normal",
          steer: !!body.steer,
          sender: { kind: "user" },
          status: body.steer ? "delivered" : "queued",
          createdAt: now + state.queue.length,
          ...(body.steer ? { deliveredAt: now, deliveredTo: body.sessionID ?? "ses_op_1" } : {}),
        }
        state.queue.push(item)
        return json(route, item)
      }
      return json(route, state.queue.filter((item) => item.agent === name).toReversed())
    }
    const queueItem = url.pathname.match(/^\/operator\/queue\/([^/]+)$/)
    if (queueItem && method === "DELETE") {
      const found = state.queue.find((item) => item.id === decodeURIComponent(queueItem[1]!))
      if (!found) return json(route, { name: "OperatorQueueNotFoundError", data: { message: "No message" } }, 404)
      found.status = "cancelled"
      return json(route, found)
    }
    if (url.pathname === "/operator/main-session" && method === "POST") {
      const agent = url.searchParams.get("agent") || "build"
      state.mainOpens.push({ agent, directory: url.searchParams.get("directory") })
      const id = state.mainSessions[agent] ?? "ses_op_main"
      const created = !state.mainSessions[agent]
      state.mainSessions[agent] = id
      return json(route, {
        agent,
        created,
        session: { id, title: `${agent} · main session`, directory, updated: now },
      })
    }
    if (url.pathname === "/operator/project-records") {
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { key: string; manager?: string }
        state.projectRecordWrites.push(body)
        const { manager, ...rest } = body
        state.projectRecords[body.key] = {
          description: "",
          status: "active",
          members: [],
          groups: [],
          ...state.projectRecords[body.key],
          ...rest,
          ...(manager ? { manager } : {}),
        }
        return json(route, { key: body.key, ...state.projectRecords[body.key] })
      }
      return json(
        route,
        Object.entries(state.projectRecords).map(([key, record]) => ({ key, ...record })),
      )
    }
    const locks = url.pathname.match(/^\/operator\/agent\/([^/]+)\/permission-locks$/)
    if (locks) {
      const name = decodeURIComponent(locks[1]!)
      if (method === "PUT") {
        const body = route.request().postDataJSON() as {
          locks: Array<{ permission: string; pattern: string }>
          inherit: "own" | "parent"
          deleted?: Array<{ permission: string; pattern: string }>
        }
        state.lockWrites.push({ agent: name, body })
        state.locks[name] = body
      }
      return json(route, state.locks[name] ?? { locks: [], inherit: "own" })
    }
    const sessionPermissions = url.pathname.match(/^\/operator\/session\/([^/]+)\/permissions$/)
    if (sessionPermissions) {
      const id = decodeURIComponent(sessionPermissions[1]!)
      if (method === "PUT") {
        const body = route.request().postDataJSON() as {
          rules: Array<Record<string, string>>
          deleted?: Array<{ permission: string; pattern: string }>
        }
        state.sessionPermissionWrites.push({ sessionID: id, body })
        state.sessionRules[id] = body.rules as never
        if (body.deleted) state.sessionDeleted[id] = body.deleted
      }
      return json(
        route,
        sessionPermissionsFor(
          directory,
          id,
          state.sessionRules[id],
          state.locks.build?.locks,
          state.sessionDeleted[id] ?? [],
        ),
      )
    }
    // A namespace's or project's permission level (permission-levels.ts).
    const level = url.pathname.match(/^\/operator\/permission\/level\/(namespace|project)$/)
    if (level) {
      const name = level[1] as "namespace" | "project"
      if (method === "PUT") {
        const body = route.request().postDataJSON() as Level
        state.levelWrites.push({ level: name, body })
        // A project line inside a line the namespace locked is refused.
        const locked = name === "project" ? (state.levels.namespace?.locks ?? []) : []
        const clash = body.lines.find((line) => locked.some((key) => key.permission === line.permission))
        if (clash)
          return route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              name: "OperatorPermissionLevelLockedError",
              data: { message: `${clash.permission} ${clash.pattern}: the namespace locks it` },
            }),
          })
        state.levels[name] = body
      }
      return json(route, levelFor(state, name, url.searchParams.get("namespace") ?? "opencode"))
    }
    const draft = url.pathname.match(/^\/operator\/agent\/([^/]+)\/tool-prompt\/draft$/)
    if (draft && method === "POST") {
      const body = route.request().postDataJSON() as { agentRules?: never }
      state.drafts.push(body)
      return json(route, draftFor(directory, decodeURIComponent(draft[1]!), body))
    }
    const toolPrompt = url.pathname.match(/^\/operator\/agent\/([^/]+)\/tool-prompt(\/last)?$/)
    if (toolPrompt && method === "GET") {
      state.toolPromptQueries.push(url.searchParams)
      const name = decodeURIComponent(toolPrompt[1]!)
      return json(
        route,
        toolPrompt[2]
          ? lastFor(name)
          : toolPromptFor(directory, name, url.searchParams.get("runsAs"), url.searchParams.get("session")),
      )
    }
    if (url.pathname.startsWith("/operator/agent") && method !== "GET") {
      state.agentWrites.push({ method, url: url.toString(), body: route.request().postDataJSON() })
      return json(route, { path: `${directory}/.opencode/agents/new.md` })
    }
    if (url.pathname === "/operator/agent") return json(route, agents)
    if (url.pathname === "/operator/capability") {
      const ns = url.searchParams.get("namespace") ?? undefined
      return json(route, {
        scope: ns ? "namespace" : "project",
        namespace: ns ?? "opencode",
        inheritGlobal: true,
        items: ns ? state.capabilities.filter((item) => item.origin !== "project") : state.capabilities,
        ...(ns ? { config: ["instructions"] } : {}),
      })
    }
    if (url.pathname === "/operator/capability/source") {
      if (method === "GET")
        return json(route, {
          location: `${workspace}/.opencode/commands/${url.searchParams.get("name")}.md`,
          text: "---\ndescription: Ship it\n---\nDeploy $ARGUMENTS\n",
        })
      state.capabilityWrites.push({ action: "edit", body: route.request().postDataJSON() as Record<string, unknown> })
      const edited = state.capabilities.find((item) => item.kind === "command")
      return json(route, edited)
    }
    if (url.pathname.startsWith("/operator/capability/")) {
      const action = url.pathname.slice("/operator/capability/".length)
      const raw = route.request().postDataJSON() as Record<string, unknown>
      const body = (action === "create" ? (raw.operatorCapabilityCreate ?? raw) : raw) as Record<string, unknown>
      state.capabilityWrites.push({
        action,
        body,
        ...(url.searchParams.get("directory") ? { directory: url.searchParams.get("directory")! } : {}),
      })
      const here = body.namespace ? "namespace" : "project"
      if (action === "seed") return json(route, [])
      const index = state.capabilities.findIndex((item) => item.kind === body.kind && item.name === body.name)
      const item = state.capabilities[index]
      if (action === "create") {
        const created: CapabilityItem = {
          kind: String(body.kind),
          name: String(body.name),
          origin: here,
          location: `${directory}/.opencode/${String(body.kind)}s/${String(body.name)}`,
          state: "local",
          hides: [],
        }
        state.capabilities.push(created)
        return json(route, created)
      }
      if (!item) return json(route, { name: "OperatorCapabilityError", data: { message: "No such capability" } }, 400)
      if (action === "copy") return json(route, { ...item, origin: "namespace", state: "local", hides: [] })
      if (action === "remove") {
        state.capabilities.splice(index, 1)
        state.trashWrites.push({ method: "POST", path: url.pathname, body })
        return json(route, true)
      }
      const next: CapabilityItem =
        action === "override"
          ? { ...item, origin: here, state: "overridden", hides: [{ origin: item.origin, location: item.location }] }
          : action === "disable"
            ? { ...item, state: "disabled", disabledAt: { origin: here, location: "opencode.jsonc" } }
            : {
                ...item,
                origin: item.hides[0]?.origin ?? item.origin,
                location: item.hides[0]?.location ?? item.location,
                state: "inherited",
                hides: [],
                disabledAt: undefined,
              }
      state.capabilities[index] = next
      return json(route, next)
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
          { kind: "namespace", path: `${workspace}/.opencode/opencode.jsonc`, text: '{ "model": "opencode/big" }' },
          { kind: "directory", path: `${directory}/.opencode/opencode.jsonc`, text: '{\n  "username": "me"\n}\n' },
        ],
        targets: {
          global: "/home/me/.config/opencode/opencode.jsonc",
          project: `${directory}/.opencode/opencode.jsonc`,
          namespace: `${workspace}/.opencode/opencode.jsonc`,
        },
        folders: {
          global: "/home/me/.config/opencode",
          project: `${directory}/.opencode`,
          namespace: `${workspace}/.opencode`,
        },
        namespace: "opencode",
        origins: { theme: "global", model: "namespace", username: "directory" },
      })
    const own = `${directory}/.opencode/opencode.jsonc`
    const namespaceFile = `${workspace}/opencode/.opencode/opencode.jsonc`
    if (url.pathname === "/operator/config/resolved") {
      const config = state.projectConfig
      const namespaceText = state.namespaceConfigs.opencode
      return json(route, {
        mode: config.mode,
        project: directory,
        file: config.mode === "own" ? own : namespaceFile,
        text:
          config.mode === "own"
            ? config.text
            : (namespaceText ?? "// OpenCode has no config yet. Saving here creates this project's own config.\n{}\n"),
        namespace: { id: "opencode", name: "OpenCode", global: false, file: namespaceFile, exists: !!namespaceText },
        ...(config.copy ? { copy: config.copy } : {}),
        ownFiles: config.mode === "own" ? [own] : [],
        subfolderFiles: [],
        tracked: config.tracked,
        target: own,
      })
    }
    if (url.pathname === "/operator/config/project" && method === "PUT") {
      state.writes.push({ url: url.toString(), body: route.request().postDataJSON() })
      if (state.rejectWrite)
        return json(route, { name: "OperatorConfigInvalidError", data: { path: own, message: state.rejectWrite } }, 400)
      const config = state.projectConfig
      if (config.mode === "namespace" && url.searchParams.get("confirmCopy") !== "true")
        return json(
          route,
          {
            name: "OperatorProjectConfigCopyNeededError",
            data: {
              message: "This project uses OpenCode's config.",
              project: directory,
              namespace: "opencode",
              file: own,
            },
          },
          409,
        )
      const { text } = route.request().postDataJSON() as { text: string }
      state.projectConfig = {
        ...config,
        mode: "own",
        text,
        ...(config.mode === "namespace"
          ? { copy: { namespace: "opencode", name: "OpenCode", copiedAt: Date.UTC(2026, 9, 8), changedSince: false } }
          : {}),
      }
      return json(route, { path: own, changed: true, reload: "now" })
    }
    if (url.pathname === "/operator/config/project/revert" && method === "POST") {
      state.writes.push({ url: url.toString(), body: undefined })
      if (state.projectConfig.tracked)
        return json(route, { name: "OperatorConfigInvalidError", data: { path: own, message: "git tracks it" } }, 400)
      state.projectConfig = { mode: "namespace", text: "", tracked: false }
      return json(route, { trash: "trash-config", reload: "now" })
    }
    if (url.pathname === "/operator/config/compare")
      return json(route, {
        project: { file: own, text: state.projectConfig.text },
        namespace: {
          id: "opencode",
          name: "OpenCode",
          file: namespaceFile,
          text: state.namespaceConfigs.opencode ?? "",
        },
      })
    // A namespace's effective config (§8): Global's base, the namespace's own, then the environment.
    const namespaceEffective = url.pathname.match(/^\/operator\/namespace\/([^/]+)\/config\/effective$/)
    if (namespaceEffective) {
      const id = decodeURIComponent(namespaceEffective[1]!)
      const global = id === "global"
      const parse = (text?: string): Record<string, unknown> => {
        try {
          return text ? (JSON.parse(text) as Record<string, unknown>) : {}
        } catch {
          return {}
        }
      }
      const base = parse(state.namespaceConfigs.global)
      const own = global ? {} : parse(state.namespaceConfigs[id])
      const env = { username: "ci" }
      return json(route, {
        id,
        folder: global ? "/home/me/.config/opencode" : `${workspace}/${id}`,
        config: { ...base, ...own, ...env },
        sources: [
          ...(state.namespaceConfigs.global === undefined
            ? []
            : [
                {
                  kind: "global",
                  path: "/home/me/.config/opencode/opencode.jsonc",
                  text: state.namespaceConfigs.global,
                },
              ]),
          ...(global || state.namespaceConfigs[id] === undefined
            ? []
            : [
                {
                  kind: "namespace",
                  path: `${workspace}/${id}/.opencode/opencode.jsonc`,
                  text: state.namespaceConfigs[id],
                },
              ]),
          {
            kind: "env",
            path: "OPENCODE_CONFIG_CONTENT",
            text: JSON.stringify(env),
            variable: "OPENCODE_CONFIG_CONTENT",
          },
        ],
        origins: Object.fromEntries([
          ...Object.keys(base).map((key) => [key, "global"]),
          ...Object.keys(own).map((key) => [key, "namespace"]),
          ...Object.keys(env).map((key) => [key, "env"]),
        ]),
        variables: Object.fromEntries(Object.keys(env).map((key) => [key, "OPENCODE_CONFIG_CONTENT"])),
      })
    }
    const namespaceConfig = url.pathname.match(/^\/operator\/namespace\/([^/]+)\/config$/)
    if (namespaceConfig) {
      const id = decodeURIComponent(namespaceConfig[1]!)
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { text: string }
        state.writes.push({ url: url.toString(), body })
        state.namespaceConfigs[id] = body.text
      }
      const text = state.namespaceConfigs[id]
      const global = id === "global"
      return json(route, {
        id,
        name: global ? "Global" : id === "opencode" ? "OpenCode" : id,
        global,
        file: global ? "/home/me/.config/opencode/opencode.jsonc" : `${workspace}/${id}/.opencode/opencode.jsonc`,
        text: text ?? "{}\n",
        exists: text !== undefined,
        using:
          id === "opencode" && state.projectConfig.mode === "namespace"
            ? [{ project: directory, name: "smoke-project" }]
            : [],
        own:
          id === "opencode" && state.projectConfig.mode === "own"
            ? [{ project: directory, name: "smoke-project" }]
            : [],
        inheriting: global ? ["OpenCode"] : [],
        ...(method === "PUT" ? { reload: "now" } : {}),
      })
    }
    if (url.pathname === "/operator/config" && method === "PATCH") {
      state.writes.push({ url: url.toString(), body: route.request().postDataJSON() })
      return json(route, { path: `${directory}/.opencode/opencode.jsonc`, changed: true })
    }
    if (url.pathname === "/operator/prompt") return json(route, promptCatalog)
    if (url.pathname === "/operator/prompt/plugins")
      return json(route, { plugins: [{ spec: "opencode-wakatime", source: `${directory}/opencode.json` }] })
    if (url.pathname === "/operator/model")
      return json(route, {
        model: { model: "opencode/claude-opus-4-6", source: "ranking", how: "default" },
        small: { model: "opencode/claude-haiku-4-5", source: "small-family", how: "default" },
        global: { path: "/home/me/.config/opencode/opencode.jsonc" },
      })
    if (url.pathname === "/operator/folder/roots") return json(route, [workspace])
    if (url.pathname === "/operator/folder" && method === "GET") {
      const path = url.searchParams.get("path") ?? workspace
      // Like the server, a folder that doesn't exist can't be listed.
      if (path !== workspace && !state.folders.has(path))
        return json(route, { name: "OperatorFolderInvalidError", data: { message: `${path} doesn't exist` } }, 400)
      return json(route, listing(path))
    }
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
    const memory = memoryRoute(state.memory, url, method, () => route.request().postDataJSON())
    if (memory) return json(route, memory.body, memory.status)
    if (url.pathname === "/operator/memory/file" && method === "GET")
      return json(route, { path: url.searchParams.get("path"), text: "# Project rules\nUse Bun.\n" })
    if (url.pathname === "/operator/memory/file") {
      state.memoryWrites.push({ url: url.toString(), body: route.request().postDataJSON() })
      return json(route, true)
    }
    return route.fallback()
  })

  // Settings → General lists the server's shells (the v1 route the shared mock leaves out).
  await page.route(
    (url) => url.pathname === "/pty/shells",
    (route) => json(route, []),
  )

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
    const body = route.request().postDataJSON() as { reply?: string }
    state.replies.push({ url: route.request().url(), body })
    // Always: the request's always patterns become rules of that session (as the server keeps them).
    const id = new URL(route.request().url()).pathname.split("/")[2]
    const answered = state.pending.find((item) => item.request.id === id)
    if (answered && body.reply === "always")
      state.sessionRules[answered.request.sessionID] = [
        ...(state.sessionRules[answered.request.sessionID] ?? []),
        ...answered.request.always.map((pattern) => ({
          permission: answered.request.permission,
          pattern,
          action: "allow" as const,
          origin: "always",
          time: now,
        })),
      ]
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
  // The API path only: a glob would also catch the app's own modules named skill… (pages/skills-note.tsx).
  await page.route(
    (url) => url.pathname === "/skill",
    (route) =>
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

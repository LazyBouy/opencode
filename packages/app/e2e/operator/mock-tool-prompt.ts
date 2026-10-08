// The Tool Prompt routes of the mock server: an agent's tool prompt (as built for Primary or
// Subagent) and its Last sent.

type Row = {
  index: number
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
  part: string
  from: { kind: string; path?: string; agent?: string }
  level?: string
  locked?: string
}
export type Key = { permission: string; pattern: string }

const sizes = (description: string, schema: unknown) => {
  const total = description.length + JSON.stringify(schema).length
  return { description: description.length, schema: JSON.stringify(schema).length, total, tokens: Math.ceil(total / 4) }
}

const tool = (name: string, description: string, extra: Record<string, unknown> = {}) => {
  const schema = { type: "object", properties: { input: { type: "string" } } }
  return {
    name,
    permission: name,
    source: { kind: "builtin" },
    version: { kind: "opencode", file: `packages/opencode/src/tool/${name}.txt` },
    versionText: description,
    description,
    schema,
    sizes: sizes(description, schema),
    ...extra,
  }
}

export function toolPromptFor(directory: string, agent: string, runsAs: string | null, session?: string | null) {
  const rows: Row[] = [
    { index: 1, permission: "*", pattern: "*", action: "allow", part: "opencode", from: { kind: "opencode-default" } },
    {
      index: 2,
      permission: "question",
      pattern: "*",
      action: "deny",
      part: "opencode",
      from: { kind: "opencode-default" },
    },
    {
      index: 3,
      permission: "read",
      pattern: "*.env",
      action: "ask",
      part: "opencode",
      from: { kind: "opencode-default" },
    },
    {
      index: 4,
      permission: "webfetch",
      pattern: "*",
      action: "deny",
      part: "config",
      from: { kind: "config-permission", path: `${directory}/.opencode/opencode.jsonc` },
    },
  ]
  const subagent = runsAs === "subagent"
  if (subagent)
    rows.push({
      index: 5,
      permission: "task",
      pattern: "*",
      action: "deny",
      part: "session",
      from: { kind: "session-task" },
    })
  const rulesOf = (permission: string) =>
    rows.filter((row) => row.permission === "*" || row.permission === permission).map((row) => row.index)
  const sent = [
    tool("bash", "Runs a command.", {
      version: {
        kind: "opencode",
        template: { file: "packages/opencode/src/tool/shell/shell.txt", values: { os: "linux", shell: "bash" } },
      },
    }),
    // A tool allowed only for some inputs carries the fork's note (here only in its trace).
    tool("read", "Reads a file.", {
      note: { text: "Allowed only for: `src/*`. Other inputs are refused.", size: 52 },
    }),
    ...(subagent
      ? []
      : [
          tool("task", "Starts a subagent.\nAvailable agents:\n- reviewer", {
            versionText: "Starts a subagent.",
            appended: {
              kind: "subagents",
              text: "Available agents:\n- reviewer",
              subagents: [{ name: "reviewer", kept: true }],
            },
          }),
        ]),
  ].map((item) => ({ ...item, rules: rulesOf(item.permission) }))
  const notSent = [
    { name: "webfetch", permission: "webfetch", reason: "permission", rule: 4, source: { kind: "builtin" } },
    ...(subagent
      ? [{ name: "task", permission: "task", reason: "subagent", rule: 5, source: { kind: "builtin" } }]
      : []),
    { name: "apply_patch", reason: "model", code: "model.apply_patch" },
    { name: "invalid", reason: "internal", code: "internal.invalid" },
  ]
  const totals = sent.reduce(
    (sum, item) => ({
      description: sum.description + item.sizes.description,
      schema: sum.schema + item.sizes.schema,
      total: sum.total + item.sizes.total,
    }),
    { description: 0, schema: 0, total: 0 },
  )
  return {
    agent,
    model: "opencode/claude-opus-4-6",
    modelSource: { model: "opencode/claude-opus-4-6", source: "ranking" },
    runsAs: session ? "session" : subagent ? "subagent" : "primary",
    ...(session ? { sessionID: session } : {}),
    rows,
    sent,
    notSent,
    sizes: { ...totals, tokens: Math.ceil(totals.total / 4) },
    list: sent.map((item) => ({ name: item.name, description: item.description, input_schema: item.schema })),
  }
}

// build's last request, in the OpenAI chat format; other agents have none yet.
export function lastFor(agent: string) {
  if (agent !== "build") return { captured: false }
  const tools = JSON.stringify(
    ["bash", "read", "task"].map((name) => ({
      type: "function",
      function: { name, description: `${name} text`, parameters: { type: "object" } },
    })),
  )
  return {
    captured: true,
    at: Date.now() - 60_000,
    sessionID: "ses_smoke_timeline",
    callID: "call_1",
    model: "opencode/claude-opus-4-6",
    format: "openai-chat",
    tools,
    bytes: tools.length,
    inputTokens: 12_345,
  }
}

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny"; origin?: string; time?: number }

// An agent's permissions for the editor: OpenCode's defaults, the agent's definition, a config rule,
// the agent's own rules (from its settings), and the truncation folder.
export function permissionsFor(
  directory: string,
  agent: string,
  own: Rule[] = [],
  marks: { locks?: Key[]; deleted?: Key[] } = {},
  above: Row[] = [],
) {
  const before: Row[] = [
    { index: 1, permission: "*", pattern: "*", action: "allow", part: "opencode", from: { kind: "opencode-default" } },
    {
      index: 2,
      permission: "question",
      pattern: "*",
      action: "deny",
      part: "opencode",
      from: { kind: "opencode-default" },
    },
    {
      index: 3,
      permission: "read",
      pattern: "*.env",
      action: "ask",
      part: "opencode",
      from: { kind: "opencode-default" },
    },
    {
      index: 4,
      permission: "webfetch",
      pattern: "*",
      action: "ask",
      part: "config",
      from: { kind: "config-permission", path: `${directory}/.opencode/opencode.jsonc` },
    },
  ]
  const rows = [
    ...before,
    ...own.map((rule, index) => ({
      ...rule,
      index: before.length + index + 1,
      part: "agent",
      from: { kind: "agent", path: `${directory}/.opencode/opencode.jsonc` },
    })),
    {
      index: before.length + own.length + 1,
      permission: "external_directory",
      pattern: "/tmp/opencode/tool-output/*",
      action: "allow" as const,
      part: "truncation",
      from: { kind: "truncation" },
    },
  ]
  // In levels: what the agent inherits (OpenCode's, the project's config, and any namespace lines given),
  // then the lines in force with the agent's own lines and marks.
  const truncation = rows.at(-1)!
  const inherited: Row[] = [
    ...[before[0]!, before[1]!, before[2]!, truncation].map((row) => ({ ...row, level: "opencode" })),
    ...above,
    { ...before[3]!, level: "project" },
  ]
  const sameKey = (a: Key, b: Key) => a.permission === b.permission && a.pattern === b.pattern
  const levelRows: Row[] = [
    ...inherited
      .filter((row) => !(marks.deleted ?? []).some((key) => sameKey(key, row)))
      .map((row) => {
        const mine = own.find((rule) => sameKey(rule, row))
        const lined: Row = mine && !row.locked ? { ...row, action: mine.action, level: "agent", part: "agent" } : row
        return (marks.locks ?? []).some((key) => sameKey(key, row)) && !row.locked
          ? { ...lined, locked: "agent" }
          : lined
      }),
    ...own
      .filter((rule) => !inherited.some((row) => sameKey(row, rule)))
      .map((rule) => ({
        ...rule,
        index: 0,
        part: "agent",
        level: "agent",
        from: { kind: "agent", path: `${directory}/.opencode/opencode.jsonc` },
        ...((marks.locks ?? []).some((key) => sameKey(key, rule)) ? { locked: "agent" } : {}),
      })),
  ].map((row, index) => ({ ...row, index: index + 1 }))
  return {
    agent,
    rows,
    own: { start: before.length, end: before.length + own.length },
    written: own,
    forms: { read: "path", edit: "path", external_directory: "absolute", todowrite: "any" },
    known: ["*", "bash", "edit", "external_directory", "read", "task", "todowrite", "webfetch"],
    targets: {
      project: { path: `${directory}/.opencode/opencode.jsonc`, kind: "config", tracked: true },
      global: { path: "/home/me/.config/opencode/opencode.jsonc", kind: "config", tracked: false },
    },
    alsoIn: [],
    inherited: inherited.map((row, index) => ({ ...row, index: index + 1 })),
    levelRows,
    canDeleteOpenCode: false,
  }
}

// The tool prompt with draft agent rules: a final `webfetch * deny` removes webfetch (from the list
// without the config's deny, where it is sent); other rules change nothing.
export function draftFor(directory: string, agent: string, body: { agentRules?: Rule[]; sessionRules?: Rule[] }) {
  const prompt = toolPromptFor(directory, agent, null)
  const rules = body.agentRules ?? body.sessionRules ?? []
  const at = rules.findLastIndex((rule) => rule.permission === "webfetch")
  const removed = at >= 0 && rules[at]!.action === "deny" && rules[at]!.pattern === "*"
  return {
    ...prompt,
    diff: {
      added: [],
      removed: removed ? [{ name: "webfetch", rule: 4 + at + 1 }] : [],
      changed: [],
      before: prompt.sizes.total + (removed ? 120 : 0),
      after: prompt.sizes.total,
    },
  }
}

// A session's permissions: what it inherits (build's lines in force, with build's locks), then the
// session's own lines; the inherited lines it deletes.
export function sessionPermissionsFor(
  directory: string,
  sessionID: string,
  own: Rule[] = [],
  locks: Array<{ permission: string; pattern: string }> = [],
  deleted: Key[] = [],
) {
  const agent = permissionsFor(directory, "build", [], { locks })
  const inherited = agent.levelRows
  const start = inherited.length
  const sameKey = (a: { permission: string; pattern: string }, b: { permission: string; pattern: string }) =>
    a.permission === b.permission && a.pattern === b.pattern
  return {
    sessionID,
    agent: "build",
    parent: false,
    rows: [
      ...inherited,
      ...own.map(({ origin, time, ...rule }, index) => ({
        ...rule,
        index: start + index + 1,
        part: "session",
        level: "session",
        from: { kind: `session-${origin ?? "user"}`, time: time ?? 1_700_000_000_000 },
      })),
    ],
    editable: { start, end: start + own.length },
    written: own.map(({ permission, pattern, action }) => ({ permission, pattern, action })),
    deleted,
    forms: agent.forms,
    known: agent.known,
    locked: inherited
      .filter((row) => locks.some((lock) => sameKey(lock, row)))
      .map(({ permission, pattern, action }) => ({ permission, pattern, action })),
    allLocked: inherited.every((row) => locks.some((lock) => sameKey(lock, row))),
    canDeleteOpenCode: false,
  }
}

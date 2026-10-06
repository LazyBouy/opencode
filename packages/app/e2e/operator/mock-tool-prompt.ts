// The Tool Prompt routes of the mock server: an agent's tool prompt (as built for Primary or
// Subagent) and its Last sent.

type Row = {
  index: number
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
  part: string
  from: { kind: string; path?: string; agent?: string }
}

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

export function toolPromptFor(directory: string, agent: string, runsAs: string | null) {
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
    tool("read", "Reads a file."),
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
    runsAs: subagent ? "subagent" : "primary",
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

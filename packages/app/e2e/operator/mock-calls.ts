// Recorded model calls of a session, for the Transcript view: a title call and two agent steps of one
// exchange; the second step sends the same system text and tools as the first, the first message again,
// and a reminder OpenCode added in memory.

const t0 = 1_760_000_000_000
const usage = { input: 7104, output: 122, reasoning: 80, cacheRead: 6912 }

const summary = (index: number, extra: Record<string, unknown>) => ({
  callID: `call_${index}`,
  index,
  kind: "agent",
  agent: "build",
  model: "opencode/claude-opus-4-6",
  // The fixture session's last exchange.
  userMessageID: "msg_user_smoke_0071",
  exchange: 1,
  format: "anthropic",
  endpoint: "api.example.com/v1/messages",
  startedAt: t0 + index * 5000,
  firstByteAt: t0 + index * 5000 + 900,
  finishedAt: t0 + index * 5000 + 3200,
  receiving: false,
  httpStatus: 200,
  usage,
  cost: 0.0069,
  bytes: 21000,
  exact: true,
  system: { chars: 12340, changed: false },
  tools: { count: 11, changed: false },
  messages: { total: 1, new: 1 },
  added: [],
  attempt: 1,
  attempts: 1,
  failed: false,
  billing: billingOf(index),
  ...extra,
})

// Each call's token accounting (the server's call-accounting.ts): the items sum exactly to the billed
// input with formatting and unattributed. Call 3 only added items to call 2's request: a measured delta.
const BILLED: Record<number, { input: number; read: number; output: number; reasoning: number }> = {
  1: { input: 520, read: 0, output: 12, reasoning: 0 },
  2: { input: 7104, read: 6912, output: 122, reasoning: 80 },
  3: { input: 7200, read: 7040, output: 40, reasoning: 0 },
}
const item = (fields: Record<string, unknown>) => ({ method: "estimate", cache: "new", flags: [], ...fields })
export function accountingFor(index: number) {
  const billed = BILLED[index]!
  const first = item({
    id: "m1.1",
    kind: "user",
    message: 1,
    turn: 1,
    preview: "fix the login bug",
    chars: 17,
    tokens: 4,
    content: "fix the login bug",
    ...(index === 3 ? { since: 2, cache: "read" } : {}),
  })
  const added =
    index === 3
      ? [
          item({
            id: "m2.1",
            kind: "tool-call",
            message: 2,
            name: "read",
            call: 2,
            preview: '{"filePath":"login.ts"}',
            chars: 23,
            tokens: 6,
            cache: "partial",
            content: '{"filePath":"login.ts"}',
          }),
          item({
            id: "m3.1",
            kind: "tool-result",
            message: 3,
            name: "read",
            preview: "export function login() {}",
            chars: 26,
            tokens: 7,
            content: "export function login() {}",
          }),
          item({
            id: "m3.2",
            kind: "added-request",
            message: 3,
            name: "reminder.build-switch",
            preview: "Plan mode is off.",
            chars: 50,
            tokens: 13,
            content: "<system-reminder>Plan mode is off.</system-reminder>",
          }),
        ]
      : []
  const tools =
    index === 1
      ? []
      : [
          item({
            id: "tools",
            kind: "tools",
            name: "2",
            chars: 4000,
            tokens: 1000,
            cache: "read",
            parts: [
              {
                name: "bash",
                chars: 2400,
                tokens: 600,
                description: { chars: 1600, tokens: 400 },
                schema: { chars: 600, tokens: 150 },
              },
              {
                name: "read",
                chars: 1600,
                tokens: 400,
                description: { chars: 1000, tokens: 250 },
                schema: { chars: 400, tokens: 100 },
              },
            ],
            content: '[{"name":"bash"},{"name":"read"}]',
          }),
        ]
  const system = item({
    id: "system",
    kind: "system",
    chars: index === 1 ? 400 : 23000,
    tokens: index === 1 ? 100 : 5750,
    cache: index === 1 ? "new" : "read",
    content: "You are opencode, an interactive CLI tool.",
  })
  const items = [
    ...tools,
    system,
    first,
    ...added,
    item({ id: "parameters", kind: "parameters", chars: 50, tokens: 0, method: "settings" }),
  ]
  const sum = items.reduce((total, entry) => total + (entry.tokens as number), 0)
  const outputs =
    index === 2
      ? [
          {
            id: "reasoning",
            kind: "reasoning",
            chars: 40,
            tokens: 80,
            method: "reported",
            content: "The login form posts to the wrong route.",
          },
          {
            id: "o2",
            kind: "tool-call",
            name: "read",
            chars: 23,
            tokens: 42,
            method: "reported",
            content: '{"filePath":"login.ts"}',
          },
        ]
      : [
          {
            id: "o1",
            kind: "text",
            chars: 16,
            tokens: billed.output,
            method: "reported",
            content: index === 1 ? "Fix login" : "Fixed the route.",
          },
        ]
  return {
    version: 1,
    tokenizer: "estimate",
    order: "tools-system-messages",
    input: {
      items,
      billed: billed.input,
      cacheRead: billed.read,
      cacheWrite: 0,
      new: billed.input - billed.read,
      unattributed: billed.input - sum,
      ...(index === 3
        ? {
            boundary: { item: "m2.1", read: 6, after: 0 },
            delta: { from: 2, tokens: 96, items: ["m2.1", "m3.1", "m3.2"] },
          }
        : index === 2
          ? { boundary: { item: "formatting", read: 158, after: 0 } }
          : {}),
      unrecognized: 0,
    },
    output: { items: outputs, billed: billed.output, reasoning: billed.reasoning, unattributed: 0 },
    cost: {
      provider: index === 3 ? 0.00534 : undefined,
      opencode: index === 1 ? 0.0004 : 0.0069,
      ...(index === 3 ? { difference: 0.00534 - 0.0069 } : {}),
      generationId: `gen-${index}`,
    },
    ...(index === 3
      ? { changes: { from: 2, added: ["m2.1", "m3.1", "m3.2"], removed: [], changed: [], tokens: 96, measured: true } }
      : {}),
  }
}

const billingOf = (index: number) => {
  const a = accountingFor(index)
  return {
    input: a.input.billed,
    cacheRead: a.input.cacheRead,
    cacheWrite: 0,
    new: a.input.new,
    output: a.output.billed,
    reasoning: a.output.reasoning,
    unattributed: a.input.unattributed,
    ...(a.cost.provider !== undefined ? { provider: a.cost.provider } : {}),
    opencode: a.cost.opencode,
    generationId: a.cost.generationId,
    unrecognized: 0,
  }
}

const totals = (indexes: number[]) => {
  const out = {
    calls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    new: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    providerCost: 0,
  }
  for (const index of indexes) {
    const b = billingOf(index)
    out.calls++
    out.input += b.input
    out.cacheRead += b.cacheRead
    out.new += b.new
    out.output += b.output
    out.reasoning += b.reasoning
    out.cost += b.opencode
    out.providerCost += b.provider ?? 0
  }
  return out
}

// With `search`, only the calls whose content has it (as the server searches bodies and responses).
export function callsFor(sessionID: string, search?: string | null) {
  const calls = [
    summary(1, {
      kind: "title",
      agent: "title",
      system: { chars: 400, changed: false },
      tools: { count: 0, changed: false },
    }),
    summary(2, { step: 1 }),
    summary(3, {
      step: 2,
      system: { chars: 12340, sameAs: 2, changed: false },
      tools: { count: 11, sameAs: 2, changed: false },
      messages: { total: 3, new: 2 },
      added: ["reminder.build-switch"],
    }),
  ]
  const query = search?.trim().toLowerCase()
  return {
    sessionID,
    calls: query
      ? calls.filter((call) =>
          JSON.stringify(callFor(sessionID, call.callID) ?? {})
            .toLowerCase()
            .includes(query),
        )
      : calls,
    exchanges: [
      { userMessageID: "msg_user_smoke_0071", index: 1, text: "fix the login bug", time: t0, recorded: true },
    ],
    totals: { calls: 3, input: 21312, output: 366, reasoning: 240, cacheRead: 20736, cost: 0.0207 },
    turns: [
      {
        index: 1,
        userMessageID: "msg_user_smoke_0071",
        text: "fix the login bug",
        calls: ["call_1", "call_2", "call_3"],
        unrecorded: 0,
        status: "ok",
        totals: totals([1, 2, 3]),
      },
    ],
    session: {
      rows: [
        { id: "agent", totals: totals([2, 3]) },
        { id: "side", totals: totals([1]) },
        { id: "retries", totals: totals([]) },
        { id: "session", totals: totals([1, 2, 3]) },
      ],
      inputBy: [
        { group: "system", tokens: 11600, cacheRead: 11500 },
        { group: "tools", tokens: 2000, cacheRead: 2000 },
        { group: "history", tokens: 10, cacheRead: 4 },
        { group: "reasoning-sent", tokens: 0, cacheRead: 0 },
        { group: "tool-results", tokens: 7, cacheRead: 0 },
        { group: "user", tokens: 8, cacheRead: 0 },
        { group: "added", tokens: 13, cacheRead: 0 },
        { group: "formatting", tokens: 1186, cacheRead: 158 },
      ],
      notCounted: { failed: 0, noUsage: 0 },
      providerMissing: [1, 2],
      subagents: [],
      uncertain: 0,
    },
    unrecorded: [],
    availability: { recorded: "all" },
  }
}

export function callFor(sessionID: string, callID: string) {
  const index = Number(callID.replace("call_", ""))
  const base = callsFor(sessionID).calls.find((call) => call.callID === callID)
  if (!base) return undefined
  const first = { index: 1, role: "user", marks: [], content: { role: "user", content: "fix the login bug" } }
  const sent =
    index === 3
      ? [
          { ...first, seenIn: 2 },
          {
            index: 2,
            role: "assistant",
            marks: [],
            content: {
              role: "assistant",
              content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { filePath: "login.ts" } }],
            },
          },
          {
            index: 3,
            role: "user",
            marks: ["in-memory"],
            content: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_1", content: "export function login() {}" },
                { type: "text", text: "<system-reminder>Plan mode is off.</system-reminder>" },
              ],
            },
          },
        ]
      : [first]
  return {
    ...base,
    systemText: "You are opencode, an interactive CLI tool.",
    toolNames: index === 1 ? [] : ["bash", "read"],
    toolsValue: index === 1 ? undefined : [{ name: "bash" }, { name: "read" }],
    sent,
    parameters: { model: "claude-opus-4-6", max_tokens: 32000 },
    received: {
      parsed: true,
      blocks:
        index === 2
          ? [
              { type: "reasoning", text: "The login form posts to the wrong route." },
              { type: "tool-call", id: "toolu_1", name: "read", arguments: '{"filePath":"login.ts"}' },
            ]
          : [{ type: "text", text: index === 1 ? "Fix login" : "Fixed the route." }],
      finish: index === 2 ? "tool_use" : "end_turn",
      usage,
    },
    warnings: [],
    accounting: accountingFor(index),
  }
}

export function rawFor(sessionID: string, callID: string, part: string) {
  const text =
    part === "request"
      ? JSON.stringify({
          model: "claude-opus-4-6",
          system: "You are opencode",
          messages: [{ role: "user", content: "fix the login bug" }],
        })
      : JSON.stringify({ content: [{ type: "text", text: "Fixed the route." }] })
  return { text, bytes: text.length }
}

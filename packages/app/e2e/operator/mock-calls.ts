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
  ...extra,
})

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

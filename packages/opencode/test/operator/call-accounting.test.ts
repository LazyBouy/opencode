import { describe, expect, test } from "bun:test"
import { OperatorCallAccounting } from "@/operator/call-accounting"
import { OperatorCallFormat } from "@/operator/call-format"
import type { OperatorCallStore } from "@/operator/call-store"
import { OperatorTokenizers } from "@/operator/tokenizers"

// The Kimi session of the spec (§6), as three recorded calls: OpenAI chat format through OpenRouter,
// with tools, reasoning sent back, and the provider's usage and cost.
const system = "You are OpenCode. ".repeat(540) // 9,720 characters
const tools = Array.from({ length: 11 }, (_, at) => ({
  type: "function",
  function: {
    name: at === 0 ? "webfetch" : `tool${at}`,
    description: "Fetches things. ".repeat(100),
    parameters: { type: "object", properties: { url: { type: "string" }, format: { type: "string" } } },
  },
}))
const hi = { role: "user", content: [{ type: "text", text: "Hi Kimi" }] }
const answer = { role: "assistant", content: "Hi! I'm Kimi, how can I help?", reasoning_content: "The user greets me." }
const weather = { role: "user", content: [{ type: "text", text: "Can you tell the weather in Köln Germany" }] }
const fetchCall = {
  role: "assistant",
  content: "",
  reasoning_content: "I should fetch wttr.in.",
  tool_calls: [
    { id: "call_w", type: "function", function: { name: "webfetch", arguments: '{"url":"https://wttr.in/Koln"}' } },
  ],
}
const fetched = { role: "tool", tool_call_id: "call_w", content: "Köln: 12°C, cloudy" }

const messages = [
  { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "Hi Kimi" }] },
  { info: { id: "msg_a1", role: "assistant", parentID: "msg_u1" }, parts: [] },
  { info: { id: "msg_u2", role: "user" }, parts: [{ type: "text", text: "Can you tell the weather in Köln Germany" }] },
  { info: { id: "msg_a2", role: "assistant", parentID: "msg_u2" }, parts: [] },
  { info: { id: "msg_a3", role: "assistant", parentID: "msg_u2" }, parts: [] },
]

type Usage = NonNullable<OperatorCallStore.Call["response"]>["usage"]
const recorded = (input: {
  index: number
  list: unknown[]
  usage?: Usage
  blocks: NonNullable<OperatorCallStore.Call["response"]>["blocks"]
  exchange: number
  user: string
  assistant: string
  cost?: number
  system?: string
  format?: OperatorCallFormat.Format
  body?: Record<string, unknown>
}): OperatorCallAccounting.CallInput => {
  const list = [{ role: "system", content: input.system ?? system }, ...input.list]
  const body = input.body ?? { model: "moonshotai/kimi-k2", messages: list, tools, stream: true }
  return {
    call: {
      callID: `call_${input.index}`,
      sessionID: "ses_kimi",
      kind: "agent",
      agent: "build",
      model: "openrouter/moonshotai/kimi-k2",
      endpoint: "openrouter.ai/api/v1/chat/completions",
      format: input.format ?? "openai-chat",
      startedAt: input.index * 1000,
      finishedAt: input.index * 1000 + 500,
      userMessageID: input.user,
      assistantMessageID: input.assistant,
      request: { body: {}, bytes: JSON.stringify(body).length, exact: true, headers: {} },
      response: {
        parsed: true,
        blocks: input.blocks,
        ...(input.usage ? { usage: input.usage } : {}),
        ids: [`gen-${input.index}`],
      },
    },
    body,
    hashes: list.map((item) => OperatorCallFormat.hash(JSON.stringify(item))),
    index: input.index,
    exchange: input.exchange,
    ...(input.cost !== undefined ? { opencodeCost: input.cost } : {}),
  }
}

const kimi = () => [
  recorded({
    index: 1,
    list: [hi],
    usage: { input: 7104, output: 65, reasoning: 39, cacheRead: 0 },
    blocks: [
      { type: "reasoning", text: "The user greets me." },
      { type: "text", text: "Hi! I'm Kimi, how can I help?" },
    ],
    exchange: 1,
    user: "msg_u1",
    assistant: "msg_a1",
    cost: 0.0201,
  }),
  recorded({
    index: 2,
    list: [hi, answer, weather],
    usage: { input: 7200, output: 312, reasoning: 190, cacheRead: 6912 },
    blocks: [
      { type: "reasoning", text: "I should fetch wttr.in." },
      { type: "tool-call", id: "call_w", name: "webfetch", arguments: '{"url":"https://wttr.in/Koln"}' },
    ],
    exchange: 2,
    user: "msg_u2",
    assistant: "msg_a2",
    cost: 0.0069,
  }),
  recorded({
    index: 3,
    list: [hi, answer, weather, fetchCall, fetched],
    usage: { input: 7592, output: 144, reasoning: 70, cacheRead: 7040, cost: 0.00534 },
    blocks: [
      { type: "reasoning", text: "Cloudy it is." },
      { type: "text", text: "It is 12°C and cloudy in Köln." },
    ],
    exchange: 2,
    user: "msg_u2",
    assistant: "msg_a3",
    cost: 0.0053352,
  }),
]

const sumOf = (accounting: OperatorCallAccounting.Accounting) =>
  accounting.input.items.reduce((total, item) => total + item.tokens, 0) + (accounting.input.unattributed ?? 0)
const outputOf = (accounting: OperatorCallAccounting.Accounting) =>
  accounting.output.items.reduce((total, item) => total + item.tokens, 0) + (accounting.output.unattributed ?? 0)

describe("token accounting", () => {
  test("the Kimi session: every call sums exactly, the tools are an item, deltas are measured", () => {
    const [one, two, three] = OperatorCallAccounting.account(kimi(), { messages })

    // Sums: the items plus formatting and unattributed are what the provider billed.
    for (const accounting of [one!, two!, three!]) {
      expect(sumOf(accounting)).toBe(accounting.input.billed!)
      expect(outputOf(accounting)).toBe(accounting.output.billed!)
    }
    expect([one!.output.billed, two!.output.billed, three!.output.billed]).toEqual([65, 312, 144])
    expect([one!.output.reasoning, two!.output.reasoning, three!.output.reasoning]).toEqual([39, 190, 70])

    // The tools are always an item, each tool with its description and schema.
    const toolsItem = one!.input.items.find((item) => item.kind === "tools")!
    expect(toolsItem.name).toBe("11")
    expect(toolsItem.parts).toHaveLength(11)
    expect(toolsItem.parts![0]).toMatchObject({ name: "webfetch", description: { chars: 1600 } })
    expect(toolsItem.tokens).toBeGreaterThan(one!.input.items.find((item) => item.kind === "system")!.tokens)
    // Call 1: estimates exceed the billed input; the difference is negative, not spread.
    expect(one!.input.unattributed!).toBeLessThan(0)
    expect(one!.input.items.find((item) => item.kind === "system")).toMatchObject({ tokens: 2430, method: "estimate" })

    // Measured: billed now minus billed then, over the items added since.
    expect(two!.input.delta).toEqual({ from: 1, tokens: 96, items: expect.any(Array) })
    const added = two!.input.items.filter((item) => two!.input.delta!.items.includes(item.id))
    expect(added.map((item) => item.kind)).toEqual(["reasoning-sent", "assistant", "user"])
    expect(added.find((item) => item.kind === "reasoning-sent")).toMatchObject({ call: 1 })
    expect(added.find((item) => item.kind === "user")).toMatchObject({ turn: 2 })
    expect(three!.input.delta).toMatchObject({ from: 2, tokens: 392 })
    expect(
      three!.input.items.filter((item) => three!.input.delta!.items.includes(item.id)).map((item) => item.kind),
    ).toEqual(["reasoning-sent", "tool-call", "tool-result"])
    expect(three!.input.items.find((item) => item.kind === "tool-result")).toMatchObject({ name: "webfetch" })
    // Items sent before keep their counts and say where they were first sent.
    expect(two!.input.items.find((item) => item.id === "m1.1")).toMatchObject({ since: 1, kind: "user", turn: 1 })
    expect(two!.changes).toMatchObject({ from: 1, tokens: 96, measured: true })

    // Cache: read from the start until the reported cache read is used up.
    expect(two!.input.cacheRead).toBe(6912)
    expect(two!.input.new).toBe(288)
    expect(two!.input.items[0]!.cache).toBe("read")
    expect(two!.input.boundary).toBeDefined()

    // Output: reasoning as reported; the one other item is output minus reasoning.
    expect(two!.output.items.find((item) => item.kind === "tool-call")).toMatchObject({
      tokens: 122,
      method: "reported",
    })

    // Billing: the provider's generation id and cost beside OpenCode's.
    expect(three!.cost).toMatchObject({ generationId: "gen-3", provider: 0.00534, opencode: 0.0053352 })
    expect(three!.cost.difference).toBeCloseTo(0.00534 - 0.0053352, 10)
  })

  test("a changed system prompt claims no delta; a cache read ending inside an item marks it partial", () => {
    const calls = kimi()
    calls[1] = recorded({
      index: 2,
      list: [hi, answer, weather],
      usage: { input: 7300, output: 10, reasoning: 0, cacheRead: 2000 },
      blocks: [{ type: "text", text: "ok" }],
      exchange: 2,
      user: "msg_u2",
      assistant: "msg_a2",
      system: `${system} Changed.`,
    })
    const [, two] = OperatorCallAccounting.account(calls, { messages })
    expect(two!.input.delta).toBeUndefined()
    expect(two!.changes).toMatchObject({ changed: ["system"], measured: false })
    // System ≈ 2,433 tokens: the 2,000 cached end inside it.
    expect(two!.input.items[0]).toMatchObject({ kind: "system", cache: "partial" })
    expect(two!.input.boundary).toMatchObject({ item: "system", read: 2000 })
    expect(two!.input.items[1]).toMatchObject({ kind: "tools", cache: "new" })
  })

  test("every part of a request is one labelled item: reminders, saved additions, cleared and shortened results, images, unknown blocks", () => {
    const reminder = "Your operational mode has changed from plan to build."
    const list = [
      {
        role: "user",
        content: [
          { type: "text", text: "Do it" },
          { type: "text", text: "Called the Read tool with a.ts" },
          { type: "text", text: `<system-reminder>\n${reminder}\n</system-reminder>` },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "mystery", payload: "something new" },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "[Old tool result content cleared]" },
      {
        role: "tool",
        tool_call_id: "c2",
        content:
          "out\n...9 lines truncated...\n\nThe tool call succeeded but the output was truncated. Full output saved to: /tmp/x",
      },
    ]
    const stored = [
      {
        info: { id: "msg_u", role: "user" },
        parts: [
          { type: "text", text: "Do it" },
          { type: "text", text: "Called the Read tool with a.ts", synthetic: true },
        ],
      },
    ]
    const [accounting] = OperatorCallAccounting.account(
      [
        recorded({
          index: 1,
          list,
          usage: { input: 9000, output: 1 },
          blocks: [{ type: "text", text: "x" }],
          exchange: 1,
          user: "msg_u",
          assistant: "msg_a",
        }),
      ],
      { messages: stored },
    )
    const kinds = accounting!.input.items.map((item) => item.kind)
    expect(kinds).toEqual([
      "system",
      "tools",
      "user",
      "added-saved",
      "added-request",
      "attachment",
      "unrecognized",
      "tool-call",
      "tool-call",
      "tool-result",
      "tool-result",
      "parameters",
    ])
    const item = (kind: string, at = 0) => accounting!.input.items.filter((entry) => entry.kind === kind)[at]!
    expect(item("added-request").name).toBe("reminder.build-switch")
    expect(item("attachment")).toMatchObject({
      attachment: { type: "image", mime: "image/png" },
      flags: ["not-estimated"],
    })
    expect(item("tool-result", 0)).toMatchObject({ name: "read", flags: ["cleared"] })
    expect(item("tool-result", 1)).toMatchObject({ name: "bash", flags: ["shortened"] })
    expect(item("parameters")).toMatchObject({ tokens: 0, method: "settings" })
    // Unknown content is never dropped: it is counted and named.
    expect(accounting!.input.unrecognized).toBeGreaterThan(0)
    expect(OperatorCallAccounting.label(item("unrecognized"))).toContain("Unrecognized content")
    expect(sumOf(accounting!)).toBe(9000)
  })

  test("Anthropic reports input without the cache; Google reports output without its thoughts", () => {
    const anthropic = recorded({
      index: 1,
      list: [hi],
      usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 50 },
      blocks: [{ type: "text", text: "hi" }],
      exchange: 1,
      user: "msg_u1",
      assistant: "msg_a1",
      format: "anthropic",
      body: { model: "claude", system, messages: [hi], tools: [] },
    })
    expect(OperatorCallAccounting.billed(anthropic.call)).toMatchObject({ input: 160, read: 100, write: 50 })
    const [accounting] = OperatorCallAccounting.account([anthropic], { messages })
    expect(accounting!.order).toBe("tools-system-messages")
    expect(accounting!.input.new).toBe(10)
    const google = {
      ...anthropic.call,
      format: "google" as const,
      response: { parsed: true, blocks: [], usage: { input: 9, output: 4, reasoning: 2 } },
    }
    expect(OperatorCallAccounting.billed(google)).toMatchObject({ output: 6, reasoning: 2 })
  })

  test("a plug-in tokenizer counts the items of the models it is for", () => {
    const remove = OperatorTokenizers.register({
      id: "words",
      label: "Words",
      models: ["openrouter/moonshotai/*"],
      count: (text) => text.split(/\s+/).filter(Boolean).length,
    })
    try {
      const [one] = OperatorCallAccounting.account(kimi(), { messages })
      expect(one!.tokenizer).toBe("words")
      expect(one!.input.items.find((item) => item.kind === "system")).toMatchObject({ tokens: 1620, method: "counted" })
      expect(sumOf(one!)).toBe(7104)
      expect(OperatorTokenizers.list().tokenizers.map((item) => item.id)).toContain("words")
    } finally {
      remove()
    }
    expect(OperatorTokenizers.forModel("openrouter/moonshotai/kimi-k2")).toBeUndefined()
  })

  test("turns and the session add up, with steps that were not recorded and subagents rolled up", () => {
    const calls = kimi()
    const accountings = OperatorCallAccounting.account(calls, { messages })
    // An older step OpenCode stored but did not record (turn 1).
    const stored = [
      { info: { id: "msg_u0", role: "user" }, parts: [] },
      {
        info: { id: "msg_old", role: "assistant", parentID: "msg_u0" },
        parts: [
          {
            type: "step-finish",
            cost: 0.01,
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } },
          },
        ],
      },
    ]
    const unrecorded = OperatorCallAccounting.unrecordedSteps(stored, new Set())
    expect(unrecorded).toEqual([
      {
        assistantMessageID: "msg_old",
        exchange: 1,
        totals: {
          calls: 1,
          input: 400,
          cacheRead: 300,
          cacheWrite: 0,
          new: 100,
          output: 25,
          reasoning: 5,
          cost: 0.01,
          providerCost: 0,
        },
      },
    ])
    const subagent = {
      sessionID: "ses_child",
      title: "Fix login",
      agent: "general",
      totals: { ...OperatorCallAccounting.empty(), calls: 6, input: 41200, output: 2300, cost: 0.041 },
    }
    const summary = OperatorCallAccounting.summarize({
      calls: calls.map((item, at) => ({
        callID: item.call.callID,
        index: item.index,
        kind: "agent",
        exchange: item.exchange,
        finishedAt: 1,
        accounting: accountings[at]!,
      })),
      exchanges: [
        { userMessageID: "msg_u1", index: 1, text: "Hi Kimi" },
        { userMessageID: "msg_u2", index: 2, text: "Can you tell the weather in Köln Germany" },
      ],
      unrecorded,
      subagents: [subagent],
    })
    expect(summary.turns.map((turn) => [turn.index, turn.calls.length, turn.unrecorded])).toEqual([
      [1, 1, 1],
      [2, 2, 0],
    ])
    expect(summary.turns[1]!.totals).toMatchObject({
      calls: 2,
      input: 14792,
      cacheRead: 13952,
      new: 840,
      output: 456,
      reasoning: 260,
    })
    const row = (id: string) => summary.session.rows.find((item) => item.id === id)!.totals
    // The session is the sum of its turns; with subagents adds theirs.
    const turns = summary.turns.reduce(
      (total, turn) => OperatorCallAccounting.add(total, turn.totals),
      OperatorCallAccounting.empty(),
    )
    expect(row("session")).toEqual(turns)
    expect(row("session").input).toBe(7104 + 7200 + 7592 + 400)
    expect(row("all").calls).toBe(row("session").calls + 6)
    // The provider reported a cost for call 3 only.
    expect(summary.session.providerMissing).toEqual([1, 2])
    // Where the input went: the groups add up to the billed input of the recorded calls.
    const went = summary.session.inputBy.reduce((total, item) => total + item.tokens, 0)
    expect(went).toBe(7104 + 7200 + 7592)
    expect(summary.session.inputBy.find((item) => item.group === "tools")!.tokens).toBeGreaterThan(0)
  })
})

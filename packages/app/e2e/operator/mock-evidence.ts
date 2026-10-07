import { callFor, callsFor } from "./mock-calls"

// A session shaped like the evidence session of transcript_view_spec_v2.md: 4 turns, 11 recorded calls.
// Turn 1 "Hi": call 1 refused (403). Turn 2 "hi": calls 2–5, 429 each. Turn 3 "hi ": call 6 answered.
// Turn 4: calls 7–10 429, call 11 answered. Every call sends the whole conversation again.

const TURNS = [
  { index: 1, text: "Hi", calls: [1], failure: { index: 1, status: 403 } },
  { index: 2, text: "hi", calls: [2, 3, 4, 5], failure: { index: 5, status: 429 } },
  { index: 3, text: "hi ", calls: [6] },
  { index: 4, text: "can you tell me a bit about yourself", calls: [7, 8, 9, 10, 11] },
] as const
const ANSWER = "Hello! How can I help?"
const t0 = 1_760_000_000_000

const turnOf = (index: number) => TURNS.find((turn) => (turn.calls as readonly number[]).includes(index))!
const okCall = (index: number) => index === 6 || index === 11
const statusOf = (index: number) => (okCall(index) ? 200 : index === 1 ? 403 : 429)

export function evidenceList(sessionID: string) {
  const base = callsFor(sessionID)
  const template = base.calls[1]!
  const calls = TURNS.flatMap((turn) =>
    turn.calls.map((index, at) => {
      const ok = okCall(index)
      return {
        ...template,
        callID: `call_${index}`,
        index,
        exchange: turn.index,
        step: 1,
        userMessageID: `msg_turn_${turn.index}`,
        attempt: at + 1,
        attempts: turn.calls.length,
        failed: !ok,
        startedAt: t0 + index * 6000,
        firstByteAt: ok ? t0 + index * 6000 + 900 : undefined,
        finishedAt: t0 + index * 6000 + 1200,
        httpStatus: statusOf(index),
        error: ok ? undefined : { status: statusOf(index), message: index === 1 ? "free tier" : "Too Many Requests" },
        usage: ok ? template.usage : undefined,
        billing: ok ? template.billing : undefined,
        cost: ok ? 0 : undefined,
      }
    }),
  )
  const empty = { ...base.turns[0]!.totals, calls: 0, input: 0, cacheRead: 0, new: 0, output: 0, reasoning: 0, cost: 0 }
  const turns = TURNS.map((turn) => ({
    index: turn.index,
    userMessageID: `msg_turn_${turn.index}`,
    text: turn.text,
    calls: turn.calls.map((index) => `call_${index}`),
    unrecorded: 0,
    status: "failure" in turn ? "failed" : "ok",
    ...("failure" in turn ? { failure: turn.failure } : {}),
    totals: { ...empty, calls: turn.calls.length },
  }))
  return {
    ...base,
    calls,
    turns,
    exchanges: turns.map((turn) => ({
      userMessageID: turn.userMessageID,
      index: turn.index,
      text: turn.text,
      time: t0,
      recorded: true,
    })),
    totals: { ...base.totals, calls: calls.length },
  }
}

const item = (fields: Record<string, unknown>) => ({ method: "estimate", cache: "new", flags: [], chars: 4, ...fields })

// A call's items: the system prompt and tools, every earlier turn again, and its own turn's message.
function itemsOf(index: number) {
  const own = turnOf(index)
  const items: Record<string, unknown>[] = [
    item({ id: "system", kind: "system", tokens: 5750, cache: "read", content: "You are opencode." }),
    item({ id: "tools", kind: "tools", name: "12", tokens: 1000, cache: "read", content: "[]" }),
  ]
  let message = 0
  for (const turn of TURNS) {
    if (turn.index > own.index) break
    const earlier = turn.index < own.index
    const first = turn.calls[0]!
    message++
    items.push(
      item({
        id: `m${message}.1`,
        kind: "user",
        message,
        turn: turn.index,
        preview: turn.text,
        tokens: earlier ? 1 : 9,
        content: turn.text,
        ...(earlier || index > first ? { since: first, cache: "read" } : {}),
      }),
    )
    if (earlier && turn.index === 3) {
      message++
      items.push(
        item({
          id: `m${message}.1`,
          kind: "assistant",
          message,
          turn: 3,
          preview: ANSWER,
          tokens: 40,
          since: 7,
          cache: "partial",
          content: ANSWER,
        }),
      )
    }
  }
  items.push(item({ id: "parameters", kind: "parameters", tokens: 0, method: "settings" }))
  return items
}

export function evidenceCall(sessionID: string, callID: string) {
  const index = Number(callID.replace("call_", ""))
  const summary = evidenceList(sessionID).calls.find((call) => call.callID === callID)
  if (!summary) return undefined
  const ok = okCall(index)
  const items = itemsOf(index)
  const sum = items.reduce((total, entry) => total + (entry.tokens as number), 0)
  return {
    ...callFor(sessionID, "call_2")!,
    ...summary,
    received: ok ? { parsed: true, blocks: [{ type: "text", text: ANSWER }], finish: "end_turn" } : undefined,
    accounting: {
      version: 2,
      tokenizer: "estimate",
      order: "system-tools-messages",
      input: {
        items,
        cacheRead: ok ? 6750 : 0,
        cacheWrite: 0,
        unrecognized: 0,
        ...(ok ? { billed: sum + 20, new: sum + 20 - 6750, unattributed: 20 } : {}),
      },
      output: { items: [], reasoning: 0, ...(ok ? { billed: 12, unattributed: 12 } : {}) },
      cost: { opencode: 0 },
    },
  }
}

import type { OperatorCallSummary, OperatorInputItem, OperatorTurn } from "@opencode-ai/sdk/v2/client"

// The Transcript's pure logic (transcript_view_spec_v2.md §2): a call's items split into what every
// call sends (system, tools), the earlier turns it sends again, and its own turn; and the list of turns
// with their steps and the attempts of each step.

export type EarlierTurn = {
  turn: number
  items: OperatorInputItem[]
  tokens: number
  // The first earlier call that sent any of it.
  since?: number
  // Its user text (the first one), and whether an answer of the agent is in it.
  text?: string
  answered: boolean
}

// In request order (the cache is read from the start): each item, or an earlier turn's items as one
// group where its first item is.
export type Entry = { item: OperatorInputItem; earlier?: undefined } | { earlier: EarlierTurn; item?: undefined }

export function splitByTurn(items: ReadonlyArray<OperatorInputItem>, own: number | undefined) {
  const entries: Entry[] = []
  const earlier: EarlierTurn[] = []
  for (const item of items) {
    const turn = item.turn
    // A compaction summary stands for the turns it replaced: it stays an item of its own.
    if (
      own === undefined ||
      turn === undefined ||
      turn >= own ||
      item.message === undefined ||
      item.kind === "summary"
    ) {
      entries.push({ item })
      continue
    }
    let group = earlier.find((entry) => entry.turn === turn)
    if (!group) {
      group = { turn, items: [], tokens: 0, answered: false }
      earlier.push(group)
      entries.push({ earlier: group })
    }
    group.items.push(item)
    group.tokens += item.tokens
    if (item.since !== undefined) group.since = Math.min(group.since ?? item.since, item.since)
    if (item.kind === "user" && group.text === undefined) group.text = item.preview
    if (item.kind === "assistant" || item.kind === "tool-call") group.answered = true
  }
  return { entries, earlier }
}

// How much of a folded group the provider read from its cache (never "new": it was sent before).
export function cacheOf(items: ReadonlyArray<OperatorInputItem>): "read" | "partial" | "new" {
  const states = new Set(items.map((item) => item.cache))
  if (states.size === 1 && states.has("read")) return "read"
  if ([...states].every((state) => state === "new" || state === "write")) return "new"
  return "partial"
}

// A turn's steps: an agent step's attempts together (the failed ones first, the last one the one that
// counts), where its first attempt is; every other call on its own.
export type ListStep = { key: string; step?: number; calls: OperatorCallSummary[] }
export type ListTurn = { turn: OperatorTurn; steps: ListStep[]; calls: OperatorCallSummary[] }

export function listOf(
  turns: ReadonlyArray<OperatorTurn>,
  byID: ReadonlyMap<string, OperatorCallSummary>,
  shown: (call: OperatorCallSummary) => boolean,
): ListTurn[] {
  return turns.map((turn) => {
    const calls = turn.calls.flatMap((id) => {
      const call = byID.get(id)
      return call && shown(call) ? [call] : []
    })
    const steps: ListStep[] = []
    for (const call of calls) {
      const same =
        call.kind === "agent" && call.step !== undefined
          ? steps.find((entry) => entry.step === call.step && entry.calls[0]!.kind === "agent")
          : undefined
      if (same) same.calls.push(call)
      else steps.push({ key: call.callID, ...(call.step !== undefined ? { step: call.step } : {}), calls: [call] })
    }
    return { turn, steps, calls }
  })
}

// A call's status in the list: its HTTP status when it failed, else ok (or receiving).
export function statusOf(call: OperatorCallSummary): "receiving" | "ok" | "failed" | number {
  if (call.receiving) return "receiving"
  const status = call.error?.status ?? ((call.httpStatus ?? 0) >= 400 ? call.httpStatus : undefined)
  if (call.failed || call.error) return status ?? "failed"
  return "ok"
}

// What Call details shows: all turns, one turn, or one call (with its turn for context).
export type Selection = { kind: "all" } | { kind: "turn"; turn: number } | { kind: "call"; callID: string }

export function selectionOf(value: string | undefined, turns: ReadonlyArray<OperatorTurn>): Selection | undefined {
  if (value === "all") return { kind: "all" }
  if (value?.startsWith("call:")) return { kind: "call", callID: value.slice(5) }
  if (value?.startsWith("turn:")) return { kind: "turn", turn: Number(value.slice(5)) }
  // None picked: the latest turn, so a running or just-finished session opens on what just happened.
  const latest = turns.filter((turn) => turn.index > 0).at(-1) ?? turns.at(-1)
  return latest ? { kind: "turn", turn: latest.index } : undefined
}

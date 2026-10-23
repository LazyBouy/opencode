// What messaging puts on parts (SPEC-0023 §10.2), for the session views: a delivered message's text part carries
// `metadata.message` (messaging/message.ts `Mark`), a `ping` call's tool part carries `metadata.ping` (its card,
// messaging/ping.ts `Card`). Read here so the views stay plain.

export type MessageMark = {
  id: string
  agent: string
  folder: string
  from: { kind: "user" | "agent" | "system" | "external"; project?: string; agent?: string; session?: string }
  correlationID: string
  replyTo?: string
  priority: "low" | "normal" | "high" | "urgent"
}

export type PingCard = {
  verb: "discover" | "send"
  target?: string
  status: "listed" | "sent" | "refused" | "waiting" | "replied" | "no reply"
  reason?: string
  messages?: Array<{ id?: string; to: string; status: string; reason?: string }>
  correlationID?: string
  wait?: { since: number; timeout: number; from?: string }
  reply?: { id: string; from: string; text: string }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** The message a user message's parts were delivered as, if they were (the first text part's mark). */
export function messageMarkOf(parts: ReadonlyArray<{ type: string; metadata?: unknown }>): MessageMark | undefined {
  for (const part of parts) {
    if (part.type !== "text" || !isRecord(part.metadata)) continue
    const mark = part.metadata.message
    if (isRecord(mark) && typeof mark.id === "string" && isRecord(mark.from)) return mark as MessageMark
  }
  return undefined
}

/** A `ping` call's card, from its part's state (the running call's, as it updates, or the finished one's). */
export function pingCardOf(part: { type: string; tool?: string; state?: unknown }): PingCard | undefined {
  if (part.type !== "tool" || part.tool !== "ping" || !isRecord(part.state)) return undefined
  const metadata = part.state.metadata
  const card = isRecord(metadata) ? metadata.ping : undefined
  return isRecord(card) && typeof card.status === "string" ? (card as PingCard) : undefined
}

/** `m:ss`, for the time a call has waited. */
export function waited(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

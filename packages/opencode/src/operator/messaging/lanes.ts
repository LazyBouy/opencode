export * as OperatorMessageLanes from "./lanes"

import type { OperatorQueueStore } from "../queue-store"

// The memory lane (SPEC-0023 §6.2, §6.5): messages for a session that is running a turn, held in memory so they're
// read fast. A steering message is read at the session's next step; one that doesn't steer stays until the turn
// ends, then moves to the session's SQLite lane (queue.ts), keeping its id, priority and time, so its order holds.
// At most 200 a session: past that, a message goes straight to the SQLite lane. An interface with one backend now,
// in-process (the server's memory); Redis is the other (phase 6).

type Item = OperatorQueueStore.Item

/** A held message: the queue item it becomes, and the session it's held for. */
export type Held = { item: Item; sessionID: string; directory: string }

export interface MemoryLane {
  /** Holds a message for its session; false when the session already has `CAP`. */
  put(held: Held): boolean
  /** Takes the session's messages, in delivery order (priority, then oldest first). */
  take(sessionID: string): Held[]
  /** The held messages of a project (and agent), in delivery order. */
  list(filter: { project?: string; agent?: string }): Held[]
  get(id: string): Held | undefined
  remove(id: string): Held | undefined
}

export const CAP = 200

const RANK = { low: 0, normal: 1, high: 2, urgent: 3 } as const
const order = (a: Held, b: Held) =>
  RANK[b.item.priority] - RANK[a.item.priority] ||
  a.item.createdAt - b.item.createdAt ||
  a.item.id.localeCompare(b.item.id)

export function inProcess(cap = CAP): MemoryLane {
  const sessions = new Map<string, Held[]>()
  const byId = new Map<string, Held>()
  return {
    put(held) {
      const list = sessions.get(held.sessionID) ?? []
      if (list.length >= cap) return false
      list.push(held)
      sessions.set(held.sessionID, list)
      byId.set(held.item.id, held)
      return true
    },
    take(sessionID) {
      const list = sessions.get(sessionID) ?? []
      sessions.delete(sessionID)
      for (const held of list) byId.delete(held.item.id)
      return list.toSorted(order)
    },
    list(filter) {
      return [...byId.values()]
        .filter(
          (held) =>
            (!filter.project || held.item.project === filter.project) &&
            (!filter.agent || held.item.agent === filter.agent),
        )
        .toSorted(order)
    },
    get: (id) => byId.get(id),
    remove(id) {
      const held = byId.get(id)
      if (!held) return undefined
      byId.delete(id)
      const list = (sessions.get(held.sessionID) ?? []).filter((item) => item.item.id !== id)
      if (list.length) sessions.set(held.sessionID, list)
      else sessions.delete(held.sessionID)
      return held
    },
  }
}

// The lane the server uses.
let current: MemoryLane | undefined
export function lane(): MemoryLane {
  return (current ??= inProcess())
}
/** For tests: a lane of their own. */
export function use(next: MemoryLane | undefined) {
  current = next
}

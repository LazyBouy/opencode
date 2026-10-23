export * as OperatorMessageLanes from "./lanes"

import { RedisClient } from "bun"
import type { OperatorQueueStore } from "../queue-store"

// The memory lane (SPEC-0023 §6.2, §6.5): messages for a session that is running a turn, held so they're read fast.
// A steering message is read at the session's next step; one that doesn't steer stays until the turn ends, then
// moves to the session's SQLite lane (queue.ts), keeping its id, priority and time, so its order holds. At most 200
// a session: past that, a message goes straight to the SQLite lane. A reply to a `ping` that waits (§7.4) never
// waits in the lane: it's handed to the waiting call at once.
//
// Two backends: in-process (the server's memory, the default), and Redis (OPENCODE_OPERATOR_REDIS_URL): a list of
// ids per session and one hash of the held messages, so what's held survives a restart of the server (if Redis
// keeps its data). The waiting calls are this server's own, so handing a reply to one is always in-process (several
// servers sharing a lane, through a channel, is for later).

type Item = OperatorQueueStore.Item

/** A held message: the queue item it becomes, and the session it's held for. */
export type Held = { item: Item; sessionID: string; directory: string }

/** A `ping` call waiting for a reply in its session: the first message it accepts is handed to it. */
export type Waiter = { sessionID: string; accepts: (item: Item) => boolean }

export type State = { backend: "in-process" | "redis"; connection?: "connected" | "down"; host?: string }

export interface MemoryLane {
  /** Holds a message for its session; false when the session already has `CAP`. */
  put(held: Held): Promise<boolean>
  /** Takes the session's messages, in delivery order (priority, then oldest first). */
  take(sessionID: string): Promise<Held[]>
  /** The held messages of a project (and agent), in delivery order. */
  list(filter: { project?: string; agent?: string }): Promise<Held[]>
  get(id: string): Promise<Held | undefined>
  remove(id: string): Promise<Held | undefined>
  /** Waits for a reply: resolves with the first message `handoff` gives it, until `cancel`. */
  wait(waiter: Waiter): { reply: Promise<Item>; cancel: () => void }
  /** Gives the message to a call waiting for it in its session; false when none accepts it. */
  handoff(held: Held): boolean
  state(): State
  close(): void
}

export const CAP = 200

const RANK = { low: 0, normal: 1, high: 2, urgent: 3 } as const
const order = (a: Held, b: Held) =>
  RANK[b.item.priority] - RANK[a.item.priority] ||
  a.item.createdAt - b.item.createdAt ||
  a.item.id.localeCompare(b.item.id)
const matches = (filter: { project?: string; agent?: string }) => (held: Held) =>
  (!filter.project || held.item.project === filter.project) && (!filter.agent || held.item.agent === filter.agent)

// This server's waiting calls, whichever backend holds the messages.
function waiters(): Pick<MemoryLane, "wait" | "handoff"> {
  const all = new Map<string, Array<Waiter & { resolve: (item: Item) => void }>>()
  const unwait = (sessionID: string, entry: Waiter) => {
    const list = (all.get(sessionID) ?? []).filter((item) => item !== entry)
    if (list.length) all.set(sessionID, list)
    else all.delete(sessionID)
  }
  return {
    wait(waiter) {
      let resolve!: (item: Item) => void
      const reply = new Promise<Item>((done) => (resolve = done))
      const entry = { ...waiter, resolve }
      all.set(waiter.sessionID, [...(all.get(waiter.sessionID) ?? []), entry])
      return { reply, cancel: () => unwait(waiter.sessionID, entry) }
    },
    handoff(held) {
      const entry = all.get(held.sessionID)?.find((item) => item.accepts(held.item))
      if (!entry) return false
      unwait(held.sessionID, entry)
      entry.resolve(held.item)
      return true
    },
  }
}

export function inProcess(cap = CAP): MemoryLane {
  const sessions = new Map<string, Held[]>()
  const byId = new Map<string, Held>()
  return {
    ...waiters(),
    async put(held) {
      const list = sessions.get(held.sessionID) ?? []
      if (list.length >= cap) return false
      list.push(held)
      sessions.set(held.sessionID, list)
      byId.set(held.item.id, held)
      return true
    },
    async take(sessionID) {
      const list = sessions.get(sessionID) ?? []
      sessions.delete(sessionID)
      for (const held of list) byId.delete(held.item.id)
      return list.toSorted(order)
    },
    async list(filter) {
      return [...byId.values()].filter(matches(filter)).toSorted(order)
    },
    get: async (id) => byId.get(id),
    async remove(id) {
      const held = byId.get(id)
      if (!held) return undefined
      byId.delete(id)
      const list = (sessions.get(held.sessionID) ?? []).filter((item) => item.item.id !== id)
      if (list.length) sessions.set(held.sessionID, list)
      else sessions.delete(held.sessionID)
      return held
    },
    state: () => ({ backend: "in-process" }),
    close: () => undefined,
  }
}

/** A server's host:port, never the whole URL (it may hold a password). */
export function hostOf(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`
  } catch {
    return "?"
  }
}

// Each change of the Redis lane is one script, so two at once (a turn's end is announced twice) never see the same
// messages: put checks the cap and adds; take reads and deletes a session's list; remove drops one message.
const PUT = `if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('RPUSH', KEYS[1], ARGV[1])
return 1`
const TAKE = `local ids = redis.call('LRANGE', KEYS[1], 0, -1)
if #ids == 0 then return {} end
redis.call('DEL', KEYS[1])
local values = redis.call('HMGET', KEYS[2], unpack(ids))
redis.call('HDEL', KEYS[2], unpack(ids))
return values`
const REMOVE = `local value = redis.call('HGET', KEYS[1], ARGV[1])
if not value then return false end
redis.call('LREM', ARGV[2] .. cjson.decode(value).sessionID, 0, ARGV[1])
redis.call('HDEL', KEYS[1], ARGV[1])
return value`

/** Redis: `<prefix>s:<sessionID>` lists a session's held ids in arrival order; `<prefix>held` maps id → message. */
export function redis(url: string, options: { cap?: number; prefix?: string } = {}): MemoryLane {
  const client = new RedisClient(url, { autoReconnect: true, enableOfflineQueue: false })
  const cap = options.cap ?? CAP
  const prefix = options.prefix ?? "opencode:lane:"
  const sessionKey = (sessionID: string) => `${prefix}s:${sessionID}`
  const heldKey = `${prefix}held`
  const parse = (text: string | null | undefined) => (text ? (JSON.parse(text) as Held) : undefined)
  const ready = client.connect().catch(() => undefined)
  const script = async (source: string, keys: string[], args: string[]) => {
    await ready
    return client.send("EVAL", [source, String(keys.length), ...keys, ...args])
  }
  return {
    ...waiters(),
    async put(held) {
      const added = await script(
        PUT,
        [sessionKey(held.sessionID), heldKey],
        [held.item.id, JSON.stringify(held), String(cap)],
      )
      return Number(added) === 1
    },
    async take(sessionID) {
      const values = ((await script(TAKE, [sessionKey(sessionID), heldKey], [])) ?? []) as Array<string | null>
      return values.flatMap((value) => parse(value) ?? []).toSorted(order)
    },
    async list(filter) {
      await ready
      return Object.values(await client.hgetall(heldKey))
        .flatMap((value) => parse(value) ?? [])
        .filter(matches(filter))
        .toSorted(order)
    },
    get: async (id) => (await ready, parse(await client.hget(heldKey, id))),
    async remove(id) {
      return parse((await script(REMOVE, [heldKey], [id, `${prefix}s:`])) as string | null)
    },
    state: () => ({ backend: "redis", connection: client.connected ? "connected" : "down", host: hostOf(url) }),
    close: () => client.close(),
  }
}

// The lane the server uses: Redis when OPENCODE_OPERATOR_REDIS_URL is set, else the server's memory.
let current: MemoryLane | undefined
export function lane(): MemoryLane {
  if (current) return current
  const url = process.env.OPENCODE_OPERATOR_REDIS_URL?.trim()
  return (current = url ? redis(url) : inProcess())
}
/** For tests: a lane of their own. */
export function use(next: MemoryLane | undefined) {
  current = next
}

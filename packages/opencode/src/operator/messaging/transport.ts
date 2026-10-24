export * as OperatorInboxTransport from "./transport"

import { Database } from "bun:sqlite"
import { Connection, ConsumerStatus, type Consumer, type Publisher } from "rabbitmq-client"
import type { OperatorMessage } from "./message"

// How messages reach other projects' inboxes (SPEC-0023 §9.4). Without RabbitMQ, an inbox routes each message as it
// arrives (inbox.ts calls its router directly). With RabbitMQ (OPENCODE_OPERATOR_RABBITMQ_URL), a message for
// another project's inbox is published and the server consumes it, a few at a time; routing stays in OpenCode:
//   - one durable topic exchange, `opencode.inbox`;
//   - per project, a durable (quorum) queue `opencode.inbox.<projectID>`, bound with the project's id, that gives a
//     message up after 5 failed deliveries to the dead-letter exchange `opencode.inbox.dlx` and its queue
//     `opencode.inbox.<projectID>.failed` (failures to process, not §8.4's dead letters);
//   - persistent messages with publisher confirms; the AMQP message id and correlation id are the message's own,
//     headers carry the source project and hops;
//   - a message is acknowledged only once its routing result is in the message log;
//   - while the broker can't be reached, messages wait in an outbox (`inbox_outbox` in queue.sqlite) and are
//     published when it's back.
// No session code here: the inbox gives the transport its router.

type Message = OperatorMessage.Message

export const EXCHANGE = "opencode.inbox"
export const DLX = "opencode.inbox.dlx"
export const ATTEMPTS = 5
export const queueOf = (project: string) => `${EXCHANGE}.${project}`

/** Routes one message that arrived for a project's inbox; resolves once the result is in the message log. */
export type Router = (message: Message) => Promise<void>

export type State = {
  connection: "connected" | "down"
  /** The broker's host (never the whole URL: it holds the password). */
  host: string
  outbox: number
}

export interface Transport {
  /** Publishes a message for a project's inbox (by the project's id); to the outbox while the broker is down. */
  send(project: string, message: Message): Promise<"published" | "outbox">
  /** Consumes those of the projects' queues that exist (more are added as messages go to them), routing each message. */
  start(projects: ReadonlyArray<string>, route: Router): Promise<void>
  state(): State
  close(): Promise<void>
}

/** The broker's host:port, for Settings → Messaging. */
export function hostOf(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`
  } catch {
    return "?"
  }
}

/** The outbox: messages published once the broker is back, oldest first. */
export function outbox(file: string) {
  const db = new Database(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_outbox (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  return {
    put: (project: string, message: Message) =>
      db
        .query("INSERT OR REPLACE INTO inbox_outbox (id, project, body, created_at) VALUES (?, ?, ?, ?)")
        .run(message.id, project, JSON.stringify(message), Date.now()),
    all: () =>
      (
        db.query("SELECT project, body FROM inbox_outbox ORDER BY created_at, rowid").all() as Array<{
          project: string
          body: string
        }>
      ).map((row) => ({ project: row.project, message: JSON.parse(row.body) as Message })),
    remove: (id: string) => db.query("DELETE FROM inbox_outbox WHERE id = ?").run(id),
    size: () => (db.query("SELECT COUNT(*) AS count FROM inbox_outbox").get() as { count: number }).count,
  }
}

// A project's queue: durable, quorum, giving a message up to the dead-letter exchange after 5 failed deliveries.
const queueOptions = (project: string) => ({
  durable: true,
  arguments: {
    "x-queue-type": "quorum" as const,
    // Counts redeliveries: the first delivery and 4 more make 5 tries.
    "x-delivery-limit": ATTEMPTS - 1,
    "x-dead-letter-exchange": DLX,
    "x-dead-letter-routing-key": project,
  },
})

export function rabbitmq(
  url: string,
  /** The outbox's file, or where to find it when first needed (the queue's file). */
  outboxFile: string | (() => string),
  options: { prefetch?: number } = {},
): Transport {
  const connection = new Connection({ url, connectionName: "opencode", retryLow: 1000, retryHigh: 15_000 })
  let box: ReturnType<typeof outbox> | undefined
  const waitingBox = () => (box ??= outbox(typeof outboxFile === "string" ? outboxFile : outboxFile()))
  let route: Router | undefined
  let publisher: Publisher | undefined
  const consumers = new Map<string, Consumer>()
  const declared = new Map<string, Promise<void>>()
  let draining: Promise<void> | undefined
  let closed = false
  // The broker logs its own errors; ours go to the outbox and the state.
  connection.on("error", () => undefined)

  // The exchanges, declared once per connection (a broker down when the server starts is retried when it's back).
  let exchanges: Promise<void> | undefined
  const ensureExchanges = () =>
    (exchanges ??= (async () => {
      await connection.exchangeDeclare({ exchange: EXCHANGE, type: "topic", durable: true })
      await connection.exchangeDeclare({ exchange: DLX, type: "topic", durable: true })
    })().catch((error: unknown) => {
      exchanges = undefined
      throw error
    }))

  // A project's queue, its failed queue and their bindings (declared once per connection's life here).
  const declare = (project: string) => {
    const found = declared.get(project)
    if (found) return found
    const made = ensureExchanges().then(async () => {
      await connection.queueDeclare({ queue: queueOf(project), ...queueOptions(project) })
      await connection.queueBind({ queue: queueOf(project), exchange: EXCHANGE, routingKey: project })
      await connection.queueDeclare({ queue: `${queueOf(project)}.failed`, durable: true })
      await connection.queueBind({ queue: `${queueOf(project)}.failed`, exchange: DLX, routingKey: project })
    })
    declared.set(project, made)
    made.catch(() => declared.delete(project))
    return made
  }

  // Each message is routed, then acknowledged; one that fails goes back, and past 5 tries to the failed queue. (The
  // consumer declares its queue again, so with the same options.)
  const consume = (project: string) => {
    if (consumers.has(project) || !route) return
    const router = route
    const consumer = connection.createConsumer(
      {
        queue: queueOf(project),
        queueOptions: queueOptions(project),
        qos: { prefetchCount: options.prefetch ?? 4 },
        requeue: true,
      },
      async (delivered) => {
        const message = (typeof delivered.body === "string" ? JSON.parse(delivered.body) : delivered.body) as Message
        await router(message)
        return ConsumerStatus.ACK
      },
    )
    consumer.on("error", () => undefined)
    consumers.set(project, consumer)
  }

  const publish = async (project: string, message: Message) => {
    await declare(project)
    publisher ??= connection.createPublisher({ confirm: true, maxAttempts: 1 })
    await publisher.send(
      {
        exchange: EXCHANGE,
        routingKey: project,
        messageId: message.id,
        correlationId: message.correlationID,
        durable: true,
        contentType: "application/json",
        headers: { "x-source-project": message.project, "x-hops": message.hops },
      },
      message,
    )
    consume(project)
  }

  // The outbox, published in order once the broker is back.
  const drain = () =>
    (draining ??= (async () => {
      try {
        for (const item of waitingBox().all()) {
          if (closed || !connection.ready) return
          await publish(item.project, item.message)
          waitingBox().remove(item.message.id)
        }
      } catch {
        // still down: the next connection tries again
      } finally {
        draining = undefined
      }
    })())
  // The projects whose queues the server consumes, when they exist: a project no message went to has none, and none
  // is made for it here (publishing makes it). Checked again on each connection, so messages left waiting in
  // RabbitMQ while the server was away are taken.
  let known: ReadonlyArray<string> = []
  const scan = async () => {
    for (const project of known) {
      if (closed || consumers.has(project)) continue
      const exists = await connection
        .queueDeclare({ queue: queueOf(project), passive: true })
        .then(() => true)
        .catch(() => false)
      if (exists) consume(project)
    }
  }

  connection.on("connection", () => {
    declared.clear()
    exchanges = undefined
    void drain()
    void scan()
  })
  const timer = setInterval(() => {
    if (connection.ready && waitingBox().size()) void drain()
  }, 5_000)

  return {
    async send(project, message) {
      if (connection.ready && !waitingBox().size()) {
        try {
          await publish(project, message)
          return "published"
        } catch {
          // falls through to the outbox
        }
      }
      waitingBox().put(project, message)
      if (connection.ready) void drain()
      return "outbox"
    },
    async start(projects, router) {
      route = router
      known = projects
      await scan()
    },
    state: () => ({
      connection: connection.ready ? "connected" : "down",
      host: hostOf(url),
      outbox: waitingBox().size(),
    }),
    async close() {
      closed = true
      clearInterval(timer)
      for (const consumer of consumers.values()) await consumer.close().catch(() => undefined)
      await publisher?.close().catch(() => undefined)
      await connection.close().catch(() => undefined)
    },
  }
}

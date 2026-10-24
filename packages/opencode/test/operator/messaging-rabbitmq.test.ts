import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Fiber, Layer } from "effect"
import { Connection } from "rabbitmq-client"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorAgentSessions } from "@/operator/agent-sessions"
import { OperatorPingDefaults } from "@/operator/messaging/defaults"
import { OperatorProjectInbox } from "@/operator/messaging/inbox"
import { OperatorMessageLog } from "@/operator/messaging/log"
import type { OperatorMessage } from "@/operator/messaging/message"
import { OperatorPing } from "@/operator/messaging/ping"
import { OperatorInboxTransport } from "@/operator/messaging/transport"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorQueue } from "@/operator/queue"
import { OperatorQueueStore } from "@/operator/queue-store"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, session } from "../merge/harness"

// The inbox transport over RabbitMQ (SPEC-0023 §9.4, §14). The parts without a broker always run; the rest run when
// OPENCODE_TEST_RABBITMQ_URL names one (the Docker stack's: amqp://opencode:opencode@rabbitmq:5672, with
// `--profile messaging`): publish and consume, acknowledged only once routed, `.failed` after 5 failures, the outbox
// while the broker is down, and a reply between two projects over the broker.

const BROKER = process.env.OPENCODE_TEST_RABBITMQ_URL
const withBroker = BROKER ? test : test.skip

const message = (id: string, project: string): OperatorMessage.Message => ({
  id,
  project: "src01",
  from: { kind: "agent", agent: "build", project: "src01" },
  to: { type: "project-agent", project, id: "plan" },
  body: { type: "text", text: "hello" },
  priority: "normal",
  steer: false,
  correlationID: id,
  hops: 1,
  status: "queued",
  inbox: project,
  createdAt: Date.now(),
  trail: [],
})
const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error("timed out")
}
const tmpFile = () => path.join(os.tmpdir(), `outbox-${Math.random().toString(36).slice(2)}.sqlite`)
const projectId = () => `t${Math.random().toString(36).slice(2, 6)}`

describe("the inbox transport", () => {
  test("Settings → Messaging shows the broker's host, never its credentials; the outbox keeps its order", () => {
    expect(OperatorInboxTransport.hostOf("amqp://user:secret@rabbitmq:5672/vhost")).toBe("rabbitmq:5672")
    expect(OperatorInboxTransport.hostOf("not a url")).toBe("?")
    const box = OperatorInboxTransport.outbox(tmpFile())
    box.put("p1", message("msg_a", "p1"))
    box.put("p2", message("msg_b", "p2"))
    expect(box.all().map((item) => [item.project, item.message.id])).toEqual([
      ["p1", "msg_a"],
      ["p2", "msg_b"],
    ])
    box.remove("msg_a")
    expect(box.size()).toBe(1)
  })

  withBroker(
    "published, consumed and acknowledged once routed; .failed after 5 failed deliveries",
    async () => {
      const project = projectId()
      const transport = OperatorInboxTransport.rabbitmq(BROKER!, tmpFile())
      const admin = new Connection(BROKER!)
      try {
        const routed: string[] = []
        let failures = 0
        await transport.start([project], async (arrived) => {
          if (arrived.body.text === "poison") {
            failures++
            throw new Error("can't route it")
          }
          await Bun.sleep(100)
          routed.push(arrived.id)
        })
        await until(() => transport.state().connection === "connected")
        expect(await transport.send(project, message("msg_ok", project))).toBe("published")
        await until(() => routed.includes("msg_ok"))
        // Acknowledged: nothing is left in the queue.
        await until(
          async () =>
            (await admin.queueDeclare({ queue: OperatorInboxTransport.queueOf(project), passive: true }))
              .messageCount === 0,
        )

        await transport.send(project, { ...message("msg_poison", project), body: { type: "text", text: "poison" } })
        await until(
          async () =>
            (await admin.queueDeclare({ queue: `${OperatorInboxTransport.queueOf(project)}.failed`, passive: true }))
              .messageCount === 1,
          30_000,
        )
        expect(failures).toBe(OperatorInboxTransport.ATTEMPTS)
      } finally {
        await transport.close()
        await admin.queueDelete({ queue: OperatorInboxTransport.queueOf(project) }).catch(() => undefined)
        await admin.queueDelete({ queue: `${OperatorInboxTransport.queueOf(project)}.failed` }).catch(() => undefined)
        await admin.close()
      }
    },
    60_000,
  )

  withBroker(
    "at start, only existing queues are consumed: none is made for a project no message went to",
    async () => {
      const [used, unused] = [projectId(), projectId()]
      const admin = new Connection(BROKER!)
      // A message left in a project's queue (published by a server that didn't consume it).
      const before = OperatorInboxTransport.rabbitmq(BROKER!, tmpFile())
      await until(() => before.state().connection === "connected")
      expect(await before.send(used, message("msg_left", used))).toBe("published")
      await before.close()
      const after = OperatorInboxTransport.rabbitmq(BROKER!, tmpFile())
      try {
        const routed: string[] = []
        await until(() => after.state().connection === "connected")
        await after.start([used, unused], async (arrived) => void routed.push(arrived.id))
        await until(() => routed.includes("msg_left"))
        const missing = await admin
          .queueDeclare({ queue: OperatorInboxTransport.queueOf(unused), passive: true })
          .then(() => "exists")
          .catch(() => "missing")
        expect(missing).toBe("missing")
      } finally {
        await after.close()
        await admin.queueDelete({ queue: OperatorInboxTransport.queueOf(used) }).catch(() => undefined)
        await admin.queueDelete({ queue: `${OperatorInboxTransport.queueOf(used)}.failed` }).catch(() => undefined)
        await admin.close()
      }
    },
    60_000,
  )

  withBroker(
    "while the broker can't be reached, messages wait in the outbox; it's emptied once one is",
    async () => {
      const project = projectId()
      const file = tmpFile()
      const down = OperatorInboxTransport.rabbitmq("amqp://opencode:opencode@127.0.0.1:1", file)
      expect(await down.send(project, message("msg_wait", project))).toBe("outbox")
      expect(down.state()).toMatchObject({ connection: "down", outbox: 1 })
      await down.close()

      const up = OperatorInboxTransport.rabbitmq(BROKER!, file)
      const admin = new Connection(BROKER!)
      try {
        const routed: string[] = []
        await up.start([project], async (arrived) => void routed.push(arrived.id))
        await until(() => routed.includes("msg_wait"))
        expect(up.state().outbox).toBe(0)
      } finally {
        await up.close()
        await admin.queueDelete({ queue: OperatorInboxTransport.queueOf(project) }).catch(() => undefined)
        await admin.queueDelete({ queue: `${OperatorInboxTransport.queueOf(project)}.failed` }).catch(() => undefined)
        await admin.close()
      }
    },
    60_000,
  )
})

// Between two projects over the broker, as the server runs with OPENCODE_OPERATOR_RABBITMQ_URL.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorToolPrompt.node,
      OperatorPermissionLive.node,
      OperatorSessionPermissions.node,
      OperatorPermissionLocks.node,
      OperatorAgentSessions.node,
      OperatorQueue.node,
      OperatorProjectInbox.node,
      OperatorPing.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const brokerIt = BROKER && process.platform !== "win32" ? it.instance : it.instance.skip
beforeAll(() => {
  if (BROKER) process.env.OPENCODE_OPERATOR_RABBITMQ_URL = BROKER
})
afterAll(() => {
  delete process.env.OPENCODE_OPERATOR_RABBITMQ_URL
})

brokerIt("a message to another project goes over RabbitMQ, and so does its reply to the waiting ping", () =>
  Effect.gen(function* () {
    const configured = yield* configure({ permission: { ping: OperatorPingDefaults.NAMESPACE } })
    OperatorQueueStore.use(OperatorQueueStore.sqlite(path.join(configured.directory, ".queue.sqlite")))
    const web = configured.directory
    const app = path.join(web, "app")
    const [webID, appID] = [projectId(), projectId()]
    const file = path.join(Global.Path.config, "namespaces", "projects.json")
    const before = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
    yield* Effect.promise(async () => {
      await fs.mkdir(app, { recursive: true })
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        JSON.stringify({
          ...(before ? JSON.parse(before) : {}),
          [web]: { namespace: "acme", id: webID },
          [app]: { namespace: "acme", id: appID },
        }),
      )
    })
    const ping = yield* OperatorPing.Service
    const instances = yield* InstanceStore.Service
    const sender = yield* session()
    const call = (args: OperatorPing.Args, options: { sessionID: string; agent: string }): OperatorPing.Call => ({
      ...options,
      args,
      ask: async () => undefined,
      abort: new AbortController().signal,
      progress: () => undefined,
    })
    try {
      const waiting = yield* ping
        .run(
          call(
            {
              verb: "send",
              target: { type: "project.agent", id: `${appID}/plan` },
              message: { body: "Which API version?" },
              wait: true,
              timeout: 30,
            },
            { sessionID: sender.id, agent: "build" },
          ),
        )
        .pipe(Effect.forkChild)
      // Published, then routed when consumed: plan's copy appears in app's queue.
      let copy: OperatorQueueStore.Item | undefined
      yield* Effect.promise(() =>
        until(() => {
          copy = OperatorQueueStore.store()
            .list({ agent: "plan" })
            .find((item) => item.project === app)
          return !!copy
        }),
      )
      const entered = OperatorMessageLog.log().get(copy!.via!.id)!
      expect(entered.trail.map((step) => step.kind)).toEqual(["entered the Project inbox", "published", "routed"])
      // plan answers; the reply goes back over the broker, through web's inbox, to the waiting ping.
      yield* Effect.promise(() => until(() => OperatorQueueStore.store().get(copy!.id)?.status === "delivered"))
      const answered = yield* instances.provide(
        { directory: app },
        ping.run(
          call(
            { verb: "send", replyTo: copy!.id, message: { body: "v3" } },
            { sessionID: OperatorQueueStore.store().get(copy!.id)!.deliveredTo!, agent: "plan" },
          ),
        ),
      )
      expect(answered.card.messages).toMatchObject([{ status: "queued" }])
      const result = yield* Fiber.join(waiting)
      expect(result.card).toMatchObject({ status: "replied", reply: { from: "plan", text: "v3" } })
    } finally {
      yield* Effect.promise(async () => {
        if (before === undefined) await fs.rm(file, { force: true })
        else await fs.writeFile(file, before)
        const admin = new Connection(BROKER!)
        for (const id of [webID, appID]) {
          await admin.queueDelete({ queue: OperatorInboxTransport.queueOf(id) }).catch(() => undefined)
          await admin.queueDelete({ queue: `${OperatorInboxTransport.queueOf(id)}.failed` }).catch(() => undefined)
        }
        await admin.close()
      })
    }
  }),
)
